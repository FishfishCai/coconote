// WS /.collab?id=<id>&token=<auth>: Yjs sync + awareness, binary only.
// Single-frame cap 16 MB, 5 s disk checkpoint + flush on last-out (design.md
// collaboration). The room is keyed by the file's id (design.md: "whether two
// opens are the same file is decided by id"); the resolved path is carried
// alongside for disk IO.
//
// This module holds the room registry and the per-connection socket loop.
// The rest is split by concern: checkpoint (disk persistence + external-write
// merge trigger), merge (CRDT merge of foreign writes), protocol (the Yjs
// sync wire codec and fan-out). Submodules reach Room/RoomState internals as
// descendants of this module.

use crate::handlers::fs::Loopback;
use crate::state::AppState;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
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
    /// Sticky flag: true once any non-loopback (remote) peer has joined
    /// this room, and stays true for the room's lifetime. Drives
    /// frontmatter-read-only on flush. Frontmatter is remote read-only, so
    /// it is decided per connection rather than per room: the moment a
    /// remote peer can put frontmatter edits into the shared doc, every
    /// flush keeps the on-disk frontmatter and persists only body edits
    /// (SPEC-redesign). A purely local room writes frontmatter verbatim.
    has_remote: bool,
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
fn new_room(seed: Option<(String, i64)>, loopback: bool) -> std::sync::Arc<Room> {
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
            // A remote first-opener already makes the room frontmatter
            // read-only. A local first-opener latches it later if a remote
            // joins.
            has_remote: !loopback,
        }),
        next_id: AtomicU64::new(0),
    })
}

#[derive(Deserialize)]
pub struct CollabQuery {
    id: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<CollabQuery>,
    Extension(Loopback(loopback)): Extension<Loopback>,
    State(app): State<AppState>,
) -> Response {
    // Resolve the id to a path before upgrading: an unresolvable id has no
    // file to seed a room from.
    let Some(path) = app.resolver.resolve(&q.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let id = q.id;
    ws.on_upgrade(move |socket| handle_socket(socket, id, path, app, loopback))
}

async fn handle_socket(
    mut socket: WebSocket,
    id: String,
    path: String,
    app: AppState,
    loopback: bool,
) {
    // The collab room versions the file's CONTENT: for a pdf that is its
    // sidecar json (UTF-8 annotations), not the immutable binary, so two
    // clients on the same pdf id realtime-sync the sidecar (design.md
    // L277/L281). For markdown the content is the file itself. Seeding the
    // room from the binary pdf used to fail from_utf8 and close 1003 on every
    // open; seed from content_path instead.
    let content_path = crate::meta::content_path(&path);
    // If the read fails or isn't valid UTF-8, refuse to seed an empty
    // doc: the 5 s checkpoint would overwrite the on-disk bytes with
    // empty content. Closing the WS surfaces the issue instead of
    // silently corrupting data. A missing sidecar (pdf never annotated) is
    // a new file: seed an empty doc, the first edit creates the sidecar.
    let seed: Option<(String, i64)> = match app.space().read_file(&content_path).await {
        Ok((bytes, entry)) => match String::from_utf8(bytes) {
            Ok(s) => Some((s, entry.mtime)),
            Err(_) => {
                tracing::warn!("collab refuse: {content_path} is not valid UTF-8");
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1003, // unsupported data
                        reason: "non-UTF-8".into(),
                    })))
                    .await;
                return;
            }
        },
        Err(_) => None, // new file / unannotated pdf: empty doc is fine
    };

    // Atomic "get or seed" so two simultaneous first joiners don't race. The
    // room is keyed by id; the resolved path travels for disk IO.
    let room = match rooms().map.entry(id.clone()) {
        dashmap::mapref::entry::Entry::Occupied(e) => e.get().clone(),
        dashmap::mapref::entry::Entry::Vacant(e) => {
            let new_room = new_room(seed, loopback);
            e.insert(new_room.clone());
            checkpoint::spawn_checkpoint_loop(
                new_room.clone(),
                id.clone(),
                path.clone(),
                app.clone(),
            );
            new_room
        }
    };

    // A remote peer joining an existing local-only room latches frontmatter
    // read-only for the room's lifetime (per-connection, not per-room).
    if !loopback {
        room.state.lock().unwrap().has_remote = true;
    }

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
        checkpoint::flush_room_to_disk(&room, &id, &path, &app).await;
        rooms().map.remove(&id);
    }
}

#[cfg(test)]
mod tests;
