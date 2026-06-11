// WS /.collab/<path>?token=<auth>: Yjs sync + awareness, binary only.
// Single-frame cap 16 MB, 5 s disk checkpoint + flush on last-out
// (server.md Collab, editor.md Collaboration).

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
use yrs::updates::encoder::Encode;
use yrs::{GetString, ReadTxn, StateVector, Text, Transact, Update};

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
    /// checkpoints (push / pull / external editor) and reset the session
    /// per editor.md Collaboration.
    last_disk_mtime: i64,
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
    // The seed transaction must NOT mark the doc dirty: that would
    // trigger a spurious 5 s checkpoint rewrite and break mtime-based
    // optimistic concurrency for the HTTP path.
    let room = match rooms().map.entry(path.clone()) {
        dashmap::mapref::entry::Entry::Occupied(e) => e.get().clone(),
        dashmap::mapref::entry::Entry::Vacant(e) => {
            let new_room = std::sync::Arc::new(Room {
                clients: DashMap::new(),
                state: StdMutex::new(RoomState {
                    doc: yrs::Doc::new(),
                    dirty: false,
                    updates_applied: 0,
                    last_disk_mtime: 0,
                }),
                next_id: AtomicU64::new(0),
            });
            if let Some((s, mtime)) = seed {
                let mut st = new_room.state.lock().unwrap();
                {
                    let ytext = st.doc.get_or_insert_text("content");
                    let mut tx = st.doc.transact_mut();
                    ytext.insert(&mut tx, 0, &s);
                }
                st.last_disk_mtime = mtime;
            }
            e.insert(new_room.clone());
            spawn_checkpoint_loop(new_room.clone(), path.clone(), app.clone());
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
            if let Some(update_payload) = extract_sync_update(&bytes) {
                if let Ok(update) = Update::decode_v1(&update_payload) {
                    let mut st = room.state.lock().unwrap();
                    let mut tx = st.doc.transact_mut();
                    let _ = tx.apply_update(update);
                    drop(tx);
                    st.dirty = true;
                    st.updates_applied = st.updates_applied.wrapping_add(1);
                }
            }
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
        let mut laggards: Vec<u64> = Vec::new();
        for entry in room.clients.iter() {
            if *entry.key() == cid {
                continue;
            }
            if entry.value().try_send(bytes.clone()).is_err() {
                laggards.push(*entry.key());
            }
        }
        for id in laggards {
            room.clients.remove(&id);
        }
    }
    room.clients.remove(&cid);
    // Drop the close channel so the outbound task drains queued frames
    // and exits cleanly (no abort()).
    drop(close_tx);
    let _ = outbound.await;

    // Last client out: flush + drop the room.
    if room.clients.is_empty() {
        flush_room_to_disk(&room, &path, &app).await;
        rooms().map.remove(&path);
    }
}

/// Every 5 s, dump the doc to disk if dirty. Exits when the room is
/// gone (Arc dropped) or empty.
fn spawn_checkpoint_loop(room: std::sync::Arc<Room>, path: String, app: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CHECKPOINT_INTERVAL).await;
            // Bail if the room was evicted (last-out flush already ran):
            // post-eviction flushes are wasted writes.
            let evicted = rooms()
                .map
                .get(&path)
                .map(|r| !std::sync::Arc::ptr_eq(&r, &room))
                .unwrap_or(true);
            if evicted {
                return;
            }
            flush_room_to_disk(&room, &path, &app).await;
        }
    });
}

async fn flush_room_to_disk(room: &Room, path: &str, app: &AppState) {
    // editor.md Collaboration: detect a non-collab write landed between
    // checkpoints (push / pull / external editor). If disk mtime is newer
    // than our previous checkpoint, drop the room: peers' WS senders are
    // released so their outbound tasks close the sockets, and reconnect
    // re-seeds the room from the freshly-written disk content. Yjs edits
    // since the last checkpoint are intentionally lost - the documented
    // trade-off for letting HTTP writes win.
    let disk_mtime_now = app
        .space()
        .get_file_meta(path)
        .await
        .map(|e| e.mtime)
        .unwrap_or(0);
    {
        let st = room.state.lock().unwrap();
        if disk_mtime_now > st.last_disk_mtime {
            tracing::info!(
                "collab: concurrent HTTP write on {path} (disk mtime {disk_mtime_now} > last \
                 checkpoint mtime {}); resetting room",
                st.last_disk_mtime
            );
            drop(st);
            rooms().map.remove(path);
            room.clients.clear();
            return;
        }
    }

    let (snapshot, version) = {
        let st = room.state.lock().unwrap();
        if !st.dirty {
            return;
        }
        let ytext = st.doc.get_or_insert_text("content");
        let tx = st.doc.transact();
        (ytext.get_string(&tx), st.updates_applied)
    };
    let body = snapshot.into_bytes();
    match app.space().write_file(path, &body).await {
        Ok(written) => {
            // Clear `dirty` only if no new update landed during the
            // write, else mid-flush edits would be silently dropped
            // from the next window. Always update last_disk_mtime so
            // the next checkpoint's HTTP-conflict check reflects our
            // own write.
            {
                let mut st = room.state.lock().unwrap();
                if st.updates_applied == version {
                    st.dirty = false;
                }
                st.last_disk_mtime = written.mtime;
            }
            // history.md SaveType: every save records a row. Collab
            // checkpoints are the "save" event while a peer is connected,
            // so they must record an `edit` row too (otherwise enabling
            // collab silently drops all snapshots for that page).
            if let Some(h) = &app.history {
                crate::handlers::fs::record_history(
                    h.clone(),
                    app.space(),
                    path,
                    &written,
                    &body,
                    None,
                )
                .await;
            }
        }
        Err(e) => {
            tracing::warn!("collab checkpoint write {path}: {e}");
        }
    }
}

fn extract_sync_update(buf: &[u8]) -> Option<Vec<u8>> {
    extract_sync_payload(buf, SYNC_STEP_2).or_else(|| extract_sync_payload(buf, SYNC_UPDATE))
}

/// Decode the varuint-prefixed payload of a sync frame matching `expected_sub`.
/// `buf` layout: [MSG_SYNC, sub, varuint(len), bytes(len)].
fn extract_sync_payload(buf: &[u8], expected_sub: u8) -> Option<Vec<u8>> {
    if buf.len() < 3 {
        return None;
    }
    if buf[1] != expected_sub {
        return None;
    }
    let (len, header_len) = read_varuint(&buf[2..])?;
    let start = 2 + header_len;
    if start.checked_add(len)? > buf.len() {
        return None;
    }
    Some(buf[start..start + len].to_vec())
}

fn read_varuint(buf: &[u8]) -> Option<(usize, usize)> {
    let mut n: u64 = 0;
    let mut shift: u32 = 0;
    for (i, b) in buf.iter().enumerate().take(10) {
        let chunk = (*b & 0x7f) as u64;
        let shifted = chunk.checked_shl(shift)?;
        n = n.checked_add(shifted)?;
        if *b & 0x80 == 0 {
            return Some((n as usize, i + 1));
        }
        shift += 7;
    }
    None
}

/// `[MSG_SYNC, SYNC_STEP_1, varuint(len), state-vector]`: the server's
/// own sync request, sent to every newly-registered peer.
fn sync_step_1_msg(room: &Room) -> Vec<u8> {
    let st = room.state.lock().unwrap();
    let tx = st.doc.transact();
    let sv = tx.state_vector().encode_v1();
    let mut out = vec![MSG_SYNC, SYNC_STEP_1];
    write_varuint(&mut out, sv.len());
    out.extend_from_slice(&sv);
    out
}

fn sync_step_2_reply(room: &Room, peer_sv: &StateVector) -> Vec<u8> {
    let st = room.state.lock().unwrap();
    let tx = st.doc.transact();
    let update = tx.encode_state_as_update_v1(peer_sv);
    let mut out = vec![MSG_SYNC, SYNC_STEP_2];
    write_varuint(&mut out, update.len());
    out.extend_from_slice(&update);
    out
}

fn write_varuint(buf: &mut Vec<u8>, mut n: usize) {
    while n > 0x7f {
        buf.push((0x80 | (n & 0x7f)) as u8);
        n >>= 7;
    }
    buf.push((n & 0x7f) as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varuint_roundtrip() {
        for v in [0usize, 1, 127, 128, 16384, 1_000_000, usize::MAX / 2] {
            let mut b = Vec::new();
            write_varuint(&mut b, v);
            let (got, _) = read_varuint(&b).unwrap();
            assert_eq!(got, v);
        }
    }
}
