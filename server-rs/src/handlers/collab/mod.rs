// WS /.collab/<path>?token=<auth>: Yjs sync + awareness, binary only.
// Single-frame cap 16 MB, 5 s disk checkpoint + flush on last-out
// (server.md Collab, editor.md Collaboration).
//
// This module holds the room registry and the per-connection socket loop.
// The rest is split by concern: checkpoint (disk persistence + external-write
// merge trigger), merge (CRDT merge of foreign writes), protocol (the Yjs
// sync wire codec and fan-out). Submodules reach Room/RoomState internals as
// descendants of this module.

use crate::state::AppState;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use bytes::Bytes;
use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Text, Transact};

mod checkpoint;
mod merge;
mod protocol;

use protocol::{
    apply_incoming_sync, broadcast, extract_sync_payload, sync_step_1_msg, sync_step_2_reply,
};

const MSG_SYNC: u8 = 0;

const SYNC_STEP_1: u8 = 0;
const SYNC_STEP_2: u8 = 1;
const SYNC_UPDATE: u8 = 2;

/// Single-frame cap (server.md Collab). Above this we close 1009.
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Disk checkpoint interval (editor.md Collaboration).
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5);

/// Bounded outbound queue per peer. A slow peer whose queue fills is
/// dropped from the room instead of growing the queue forever: its
/// outbound task drains and the socket closes (no close frame). Yjs
/// CRDT resyncs cleanly on reconnect.
const PEER_QUEUE_DEPTH: usize = 256;

struct RoomState {
    doc: yrs::Doc,
    dirty: bool,
    /// Bumped on every applied SYNC_UPDATE / SYNC_STEP_2. The flush task
    /// snapshots this before writing and only clears `dirty` if no new
    /// updates arrived during the write, else mid-flush edits would be
    /// silently dropped from the next window.
    updates_applied: u64,
    /// Disk mtime as of the last checkpoint we wrote (or initial seed).
    /// Lets the checkpoint loop detect non-collab writes between
    /// checkpoints (push / pull / external editor) and merge them per
    /// editor.md Collaboration.
    last_disk_mtime: i64,
    /// Doc state at the last checkpoint (or seed) encoded as a full
    /// update, paired with the exact text written. A foreign disk write
    /// is diffed against these and merged like edits from a peer that
    /// went offline at the checkpoint and came back.
    checkpoint_update: Vec<u8>,
    checkpoint_text: String,
}

struct Room {
    clients: DashMap<u64, mpsc::Sender<Bytes>>,
    state: StdMutex<RoomState>,
    next_id: AtomicU64,
}

#[derive(Default)]
struct Rooms {
    map: DashMap<String, std::sync::Arc<Room>>,
}

fn rooms() -> &'static Rooms {
    static R: OnceLock<Rooms> = OnceLock::new();
    R.get_or_init(Rooms::default)
}

/// Build a room, optionally seeded from disk. The seed transaction must
/// NOT mark the doc dirty: that would trigger a spurious 5 s checkpoint
/// rewrite and break mtime-based optimistic concurrency for the HTTP
/// path. Rooms use `Doc::new()`, so the doc's OffsetKind is Bytes: every
/// Y.Text index in this module is a UTF-8 byte offset.
fn new_room(seed: Option<(String, i64)>) -> std::sync::Arc<Room> {
    let doc = yrs::Doc::new();
    let (checkpoint_text, last_disk_mtime) = seed.unwrap_or_default();
    if !checkpoint_text.is_empty() {
        let ytext = doc.get_or_insert_text("content");
        let mut tx = doc.transact_mut();
        ytext.insert(&mut tx, 0, &checkpoint_text);
    }
    let checkpoint_update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    std::sync::Arc::new(Room {
        clients: DashMap::new(),
        state: StdMutex::new(RoomState {
            doc,
            dirty: false,
            updates_applied: 0,
            last_disk_mtime,
            checkpoint_update,
            checkpoint_text,
        }),
        next_id: AtomicU64::new(0),
    })
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    AxPath(path): AxPath<String>,
    State(app): State<AppState>,
) -> Response {
    // Axum's Path extractor already percent-decoded the capture,
    // decoding again would corrupt names with a literal `%HH`.
    let path = path.trim_start_matches('/').to_string();
    ws.on_upgrade(move |socket| handle_socket(socket, path, app))
}

async fn handle_socket(mut socket: WebSocket, path: String, app: AppState) {
    // If the read fails or isn't valid UTF-8, refuse to seed an empty
    // doc: the 5 s checkpoint would overwrite the on-disk bytes with
    // empty content. Closing the WS surfaces the issue instead of
    // silently corrupting data.
    let seed: Option<(String, i64)> = match app.space().read_file(&path).await {
        Ok((bytes, entry)) => match String::from_utf8(bytes) {
            Ok(s) => Some((s, entry.mtime)),
            Err(_) => {
                tracing::warn!("collab refuse: {path} is not valid UTF-8");
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1003, // unsupported data
                        reason: "non-UTF-8".into(),
                    })))
                    .await;
                return;
            }
        },
        Err(_) => None, // new file: empty doc is fine
    };

    // Atomic "get or seed" so two simultaneous first joiners don't race.
    let room = match rooms().map.entry(path.clone()) {
        dashmap::mapref::entry::Entry::Occupied(e) => e.get().clone(),
        dashmap::mapref::entry::Entry::Vacant(e) => {
            let new_room = new_room(seed);
            e.insert(new_room.clone());
            checkpoint::spawn_checkpoint_loop(new_room.clone(), path.clone(), app.clone());
            new_room
        }
    };

    let cid = room.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::channel::<Bytes>(PEER_QUEUE_DEPTH);
    // Server-initiated SyncStep1 (editor.md Collaboration: on connect
    // "both sides do a full sync"). Without it the server only ANSWERS
    // the client's Step1 and never asks for what it is missing: a
    // reconnecting client's offline backlog only travels in its
    // SyncStep2 reply to this request (applied by the receive loop).
    // Fresh queue, so try_send can't fail.
    let _ = tx.try_send(Bytes::from(sync_step_1_msg(&room)));
    room.clients.insert(cid, tx);

    use futures::{SinkExt, StreamExt};
    let (mut socket_tx, mut socket_rx) = socket.split();

    let (close_tx, mut close_rx) = mpsc::channel::<CloseFrame<'static>>(1);
    let outbound = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(b) = rx.recv() => {
                    if socket_tx.send(Message::Binary(b.into())).await.is_err() {
                        break;
                    }
                }
                Some(frame) = close_rx.recv() => {
                    let _ = socket_tx.send(Message::Close(Some(frame))).await;
                    break;
                }
                else => break,
            }
        }
    });

    while let Some(msg) = socket_rx.next().await {
        let Ok(msg) = msg else { break };
        let bytes: Bytes = match msg {
            Message::Binary(b) => b.into(),
            Message::Close(_) => break,
            _ => continue,
        };
        if bytes.len() > MAX_MESSAGE_BYTES {
            tracing::warn!(
                "collab: {} byte frame exceeds {} cap on {}; closing",
                bytes.len(),
                MAX_MESSAGE_BYTES,
                path
            );
            let _ = close_tx
                .send(CloseFrame {
                    code: 1009, // message too big
                    reason: "frame > 16MB".into(),
                })
                .await;
            break;
        }
        // Apply SYNC_UPDATE payloads to the server's doc so
        // flush_room_to_disk has the latest state. Forward EVERY
        // non-private sync frame and all awareness frames: even when
        // yrs can't decode an update, yjs peers may understand each
        // other, so don't drop their messages. SYNC_STEP_1 stays
        // private (replied to sender).
        if bytes.first().copied() == Some(MSG_SYNC) {
            apply_incoming_sync(&room, &bytes);
            if matches!(bytes.get(1), Some(&SYNC_STEP_1)) {
                // Reply with only the diff the peer is missing: parse
                // their StateVector out of the SYNC_STEP_1 payload.
                let peer_sv = extract_sync_payload(&bytes, SYNC_STEP_1)
                    .and_then(|p| StateVector::decode_v1(&p).ok())
                    .unwrap_or_default();
                if let Some(sender) = room.clients.get(&cid) {
                    let _ = sender.try_send(Bytes::from(sync_step_2_reply(&room, &peer_sv)));
                }
                // SYNC_STEP_1 is a private request, don't fan out.
                continue;
            }
        }
        broadcast(&room, bytes, Some(cid));
    }
    room.clients.remove(&cid);
    // Drop the close channel so the outbound task drains queued frames
    // and exits cleanly (no abort()).
    drop(close_tx);
    let _ = outbound.await;

    // Last client out: flush + drop the room.
    if room.clients.is_empty() {
        checkpoint::flush_room_to_disk(&room, &path, &app).await;
        rooms().map.remove(&path);
    }
}

#[cfg(test)]
mod tests;
