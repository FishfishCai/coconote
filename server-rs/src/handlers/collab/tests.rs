use super::checkpoint::flush_room_to_disk;
use super::merge::merge_external_text;
use super::protocol::{apply_incoming_sync, read_varuint, sync_update_msg, write_varuint};
use super::{new_room, Room, MSG_SYNC, SYNC_STEP_2, SYNC_UPDATE};
use crate::state::AppState;
use bytes::Bytes;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use yrs::updates::decoder::Decode;
use yrs::{GetString, ReadTxn, StateVector, Text, Transact, Update};

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
