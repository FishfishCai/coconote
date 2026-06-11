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
    // editor.md Collaboration: disk mtime newer than our last checkpoint
    // means a non-collab write landed (push / pull / external editor).
    // Merge it like a peer that went offline at the checkpoint and came
    // back with edits. Only when the file is unreadable do we keep the
    // old reset: peers' WS senders are released so their outbound tasks
    // close the sockets, and reconnect re-seeds the room from disk.
    let disk_mtime_now = app
        .space()
        .get_file_meta(path)
        .await
        .map(|e| e.mtime)
        .unwrap_or(0);
    if disk_mtime_now > room.state.lock().unwrap().last_disk_mtime {
        let disk = match app.space().read_file(path).await {
            Ok((bytes, entry)) => String::from_utf8(bytes).ok().map(|s| (s, entry.mtime)),
            Err(_) => None,
        };
        let Some((disk_text, mtime)) = disk else {
            tracing::info!("collab: unreadable external write on {path}; resetting room");
            rooms().map.remove(path);
            room.clients.clear();
            return;
        };
        let update = {
            let mut st = room.state.lock().unwrap();
            // Record the mtime now so this same write is not re-detected
            // as foreign on the next tick.
            st.last_disk_mtime = mtime;
            merge_external_text(&mut st, &disk_text)
        };
        // Fan the merge out exactly like a client-originated update, then
        // fall through: merge marked the room dirty, so this same tick
        // persists the merged result.
        if let Some(update) = update {
            tracing::info!("collab: merged external write into {path}");
            broadcast(room, Bytes::from(sync_update_msg(&update)), None);
        }
    }

    let (snapshot, version, encoded) = {
        let st = room.state.lock().unwrap();
        if !st.dirty {
            return;
        }
        let ytext = st.doc.get_or_insert_text("content");
        let tx = st.doc.transact();
        (
            ytext.get_string(&tx),
            st.updates_applied,
            tx.encode_state_as_update_v1(&StateVector::default()),
        )
    };
    match app.space().write_file(path, snapshot.as_bytes()).await {
        Ok(written) => {
            // Clear `dirty` only if no new update landed during the
            // write, else mid-flush edits would be silently dropped
            // from the next window. Always update last_disk_mtime so
            // the next checkpoint's foreign-write check reflects our
            // own write, and keep the checkpoint pair the next
            // external-write diff is computed against.
            {
                let mut st = room.state.lock().unwrap();
                if st.updates_applied == version {
                    st.dirty = false;
                }
                st.last_disk_mtime = written.mtime;
                st.checkpoint_update = encoded;
                st.checkpoint_text = snapshot.clone();
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
                    snapshot.as_bytes(),
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

/// Merge a foreign disk write into the live doc like a returning offline
/// peer: replay the checkpoint state on a fork, splice the checkpoint ->
/// disk text diff into it in one transaction, then apply the fork's ops
/// the live doc is missing. Because fork and live share history up to
/// the checkpoint, yrs merges the external edits with concurrent client
/// edits. Returns the applied update for broadcast, or None when the
/// disk text matches the checkpoint.
fn merge_external_text(st: &mut RoomState, disk_text: &str) -> Option<Vec<u8>> {
    if disk_text == st.checkpoint_text {
        return None;
    }
    let snapshot = Update::decode_v1(&st.checkpoint_update).ok()?;
    let fork = yrs::Doc::new();
    let ytext = fork.get_or_insert_text("content");
    {
        let mut tx = fork.transact_mut();
        let _ = tx.apply_update(snapshot);
        for s in text_splices(&st.checkpoint_text, disk_text).iter().rev() {
            if s.del > 0 {
                ytext.remove_range(&mut tx, s.at, s.del);
            }
            if !s.insert.is_empty() {
                ytext.insert(&mut tx, s.at, &s.insert);
            }
        }
    }
    let missing = {
        let live_sv = st.doc.transact().state_vector();
        fork.transact().encode_state_as_update_v1(&live_sv)
    };
    let update = Update::decode_v1(&missing).ok()?;
    {
        let mut tx = st.doc.transact_mut();
        let _ = tx.apply_update(update);
    }
    st.dirty = true;
    st.updates_applied = st.updates_applied.wrapping_add(1);
    Some(missing)
}

/// One text replacement. Offsets and lengths are UTF-8 byte units (the
/// rooms' Doc OffsetKind is Bytes, see new_room).
struct Splice {
    at: u32,
    del: u32,
    insert: String,
}

/// Char-level diff of old -> new as splices with byte offsets into old,
/// ascending and non-overlapping (apply in reverse to keep them valid).
/// The timeout degrades huge diffs to coarser but still correct ops.
fn text_splices(old: &str, new: &str) -> Vec<Splice> {
    let diff = similar::TextDiff::configure()
        .timeout(Duration::from_millis(500))
        .diff_chars(old, new);
    let ob = byte_offsets(old);
    let nb = byte_offsets(new);
    let mut out = Vec::new();
    for op in diff.ops() {
        if op.tag() == similar::DiffTag::Equal {
            continue;
        }
        let (o, n) = (op.old_range(), op.new_range());
        out.push(Splice {
            at: ob[o.start] as u32,
            del: (ob[o.end] - ob[o.start]) as u32,
            insert: new[nb[n.start]..nb[n.end]].to_string(),
        });
    }
    out
}

/// Byte offset of every char index (plus the end), so char-indexed diff
/// ranges convert to the byte offsets Y.Text expects.
fn byte_offsets(s: &str) -> Vec<usize> {
    let mut v: Vec<usize> = s.char_indices().map(|(i, _)| i).collect();
    v.push(s.len());
    v
}

/// Fan a frame out to every connected peer except `skip`. A peer whose
/// queue is full is dropped from the room (see PEER_QUEUE_DEPTH).
fn broadcast(room: &Room, frame: Bytes, skip: Option<u64>) {
    let mut laggards: Vec<u64> = Vec::new();
    for entry in room.clients.iter() {
        if Some(*entry.key()) == skip {
            continue;
        }
        if entry.value().try_send(frame.clone()).is_err() {
            laggards.push(*entry.key());
        }
    }
    for id in laggards {
        room.clients.remove(&id);
    }
}

/// Apply a peer's sync payload to the room doc. A handshake SYNC_STEP_2
/// from a peer with no offline edits is an empty diff: marking it dirty
/// would rewrite an identical file on every page open (mtime churn plus
/// a noise history row), so STEP_2 only dirties when it changed the doc.
/// Snapshot compare, not state-vector compare: a pure-deletion offline
/// edit moves only the delete set.
fn apply_incoming_sync(room: &Room, bytes: &[u8]) {
    let Some(update_payload) = extract_sync_update(bytes) else {
        return;
    };
    let Ok(update) = Update::decode_v1(&update_payload) else {
        return;
    };
    let is_step2 = matches!(bytes.get(1), Some(&SYNC_STEP_2));
    let mut st = room.state.lock().unwrap();
    let before = if is_step2 {
        Some(st.doc.transact().snapshot())
    } else {
        None
    };
    let mut tx = st.doc.transact_mut();
    let _ = tx.apply_update(update);
    drop(tx);
    if before.map_or(true, |b| st.doc.transact().snapshot() != b) {
        st.dirty = true;
        st.updates_applied = st.updates_applied.wrapping_add(1);
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

/// `[MSG_SYNC, SYNC_UPDATE, varuint(len), update]`: server-originated
/// update fan-out (external write merge).
fn sync_update_msg(update: &[u8]) -> Vec<u8> {
    let mut out = vec![MSG_SYNC, SYNC_UPDATE];
    write_varuint(&mut out, update.len());
    out.extend_from_slice(update);
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
    use std::sync::Arc;

    #[test]
    fn varuint_roundtrip() {
        for v in [0usize, 1, 127, 128, 16384, 1_000_000, usize::MAX / 2] {
            let mut b = Vec::new();
            write_varuint(&mut b, v);
            let (got, _) = read_varuint(&b).unwrap();
            assert_eq!(got, v);
        }
    }

    fn test_app(dir: &std::path::Path) -> AppState {
        let space: crate::state::DynSpace =
            Arc::new(crate::space::DiskSpacePrimitives::new(dir).unwrap());
        AppState {
            live: Arc::new(arc_swap::ArcSwap::from_pointee(crate::state::LiveSpace {
                roots: indexmap::IndexMap::new(),
                space,
            })),
            client_bundle: Arc::new(crate::space::EmbeddedReadOnlySpacePrimitives::new(0)),
            read_only: false,
            auth_token: String::new(),
            build_time: String::new(),
            started_at: String::new(),
            pid: 0,
            history: None,
            config_path: None,
            restart_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn room_text(room: &Room) -> String {
        let st = room.state.lock().unwrap();
        let ytext = st.doc.get_or_insert_text("content");
        let tx = st.doc.transact();
        ytext.get_string(&tx)
    }

    /// Seed a room from disk like handle_socket does on first join.
    async fn seeded_room(app: &AppState, path: &str) -> Arc<Room> {
        let (bytes, entry) = app.space().read_file(path).await.unwrap();
        new_room(Some((String::from_utf8(bytes).unwrap(), entry.mtime)))
    }

    #[tokio::test]
    async fn external_write_merges_with_concurrent_edit() {
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app(dir.path());
        app.space()
            .write_file("note.md", b"alpha\nbeta\ngamma\n")
            .await
            .unwrap();
        let room = seeded_room(&app, "note.md").await;
        let (tx, mut rx) = mpsc::channel::<Bytes>(8);
        room.clients.insert(1, tx);

        // Concurrent in-room edit since the checkpoint.
        {
            let mut st = room.state.lock().unwrap();
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            ytext.insert(&mut tx, 5, " TYPED");
            drop(tx);
            st.dirty = true;
            st.updates_applied += 1;
        }
        // External write to a different line, strictly newer mtime.
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(dir.path().join("note.md"), "alpha\nbeta\nGAMMA external\n").unwrap();

        flush_room_to_disk(&room, "note.md", &app).await;

        // Both edits survive, peers stay in the room, and the merge is
        // fanned out as a regular SYNC_UPDATE frame.
        assert_eq!(room_text(&room), "alpha TYPED\nbeta\nGAMMA external\n");
        assert!(room.clients.contains_key(&1), "merge must not evict peers");
        let frame = rx.try_recv().expect("merge broadcast frame");
        assert_eq!(&frame[..2], [MSG_SYNC, SYNC_UPDATE]);

        // The same tick persisted the merged result, and the write is
        // not re-detected as foreign on the next tick.
        let (bytes, _) = app.space().read_file("note.md").await.unwrap();
        assert_eq!(bytes, b"alpha TYPED\nbeta\nGAMMA external\n");
        flush_room_to_disk(&room, "note.md", &app).await;
        assert!(room.clients.contains_key(&1));
    }

    #[test]
    fn multibyte_external_diff_uses_byte_offsets() {
        // CJK + emoji before every edit point: if splice offsets were
        // char counts instead of UTF-8 bytes the inserts would land on
        // non-boundaries (panic) or in the wrong place.
        let base = "CJK 你好世界\nemoji 🦀🚀 tail\nplain\n";
        let room = new_room(Some((base.to_string(), 1)));
        let mut st = room.state.lock().unwrap();
        {
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            let at = base.find("plain").unwrap() as u32;
            ytext.insert(&mut tx, at, "local ");
        }
        let external = "CJK 你好亲爱的世界\nemoji 🦀🛸🚀 tail\nplain\n";
        merge_external_text(&mut st, external).expect("merge");
        drop(st);
        assert_eq!(
            room_text(&room),
            "CJK 你好亲爱的世界\nemoji 🦀🛸🚀 tail\nlocal plain\n"
        );
    }

    #[tokio::test]
    async fn non_utf8_external_write_still_evicts() {
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app(dir.path());
        app.space().write_file("note.md", b"seed\n").await.unwrap();
        let room = seeded_room(&app, "note.md").await;
        let (tx, _rx) = mpsc::channel::<Bytes>(8);
        room.clients.insert(1, tx);
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(dir.path().join("note.md"), [0xffu8, 0xfe, 0x9f]).unwrap();
        flush_room_to_disk(&room, "note.md", &app).await;
        assert!(room.clients.is_empty(), "non-UTF-8 write must evict peers");
    }

    #[tokio::test]
    async fn missing_file_on_foreign_write_still_evicts() {
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app(dir.path());
        // last_disk_mtime older than "no file" (mtime 0) simulates the
        // file vanishing between the mtime probe and the read.
        let room = new_room(Some(("seed\n".to_string(), -1)));
        let (tx, _rx) = mpsc::channel::<Bytes>(8);
        room.clients.insert(1, tx);
        flush_room_to_disk(&room, "note.md", &app).await;
        assert!(room.clients.is_empty(), "vanished file must evict peers");
    }

    fn step2_frame(payload: &[u8]) -> Vec<u8> {
        let mut out = vec![MSG_SYNC, SYNC_STEP_2];
        write_varuint(&mut out, payload.len());
        out.extend_from_slice(payload);
        out
    }

    /// Fork sharing the room's full history, plus the room's state vector.
    fn fork_of(room: &Room) -> (yrs::Doc, StateVector) {
        let st = room.state.lock().unwrap();
        let tx = st.doc.transact();
        let full = tx.encode_state_as_update_v1(&StateVector::default());
        let sv = tx.state_vector();
        drop(tx);
        let fork = yrs::Doc::new();
        {
            let mut ftx = fork.transact_mut();
            let _ = ftx.apply_update(Update::decode_v1(&full).unwrap());
        }
        (fork, sv)
    }

    #[tokio::test]
    async fn noop_step2_does_not_mark_dirty() {
        let room = new_room(Some(("alpha\n".to_string(), 1)));
        let (fork, sv) = fork_of(&room);
        let diff = fork.transact().encode_state_as_update_v1(&sv);
        apply_incoming_sync(&room, &step2_frame(&diff));
        let st = room.state.lock().unwrap();
        assert!(!st.dirty, "empty handshake diff must not dirty the room");
        assert_eq!(st.updates_applied, 0);
    }

    #[tokio::test]
    async fn pure_delete_step2_marks_dirty() {
        let room = new_room(Some(("alpha\n".to_string(), 1)));
        let (fork, sv) = fork_of(&room);
        {
            let ytext = fork.get_or_insert_text("content");
            let mut ftx = fork.transact_mut();
            ytext.remove_range(&mut ftx, 0, 2);
        }
        let diff = fork.transact().encode_state_as_update_v1(&sv);
        apply_incoming_sync(&room, &step2_frame(&diff));
        assert!(room.state.lock().unwrap().dirty, "offline deletion must dirty the room");
        assert_eq!(room_text(&room), "pha\n");
    }

    #[tokio::test]
    async fn live_update_marks_dirty() {
        let room = new_room(Some(("alpha\n".to_string(), 1)));
        let (fork, sv) = fork_of(&room);
        {
            let ytext = fork.get_or_insert_text("content");
            let mut ftx = fork.transact_mut();
            ytext.insert(&mut ftx, 0, "x");
        }
        let diff = fork.transact().encode_state_as_update_v1(&sv);
        apply_incoming_sync(&room, &sync_update_msg(&diff));
        assert!(room.state.lock().unwrap().dirty);
        assert_eq!(room_text(&room), "xalpha\n");
    }
}
