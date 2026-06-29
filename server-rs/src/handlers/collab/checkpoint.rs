// Disk persistence (editor.md Collaboration): the 5 s checkpoint loop, the
// dirty-doc flush, and the foreign-write detection that hands off to the
// CRDT merge. A flushed checkpoint also records an `edit` history row.

use super::merge::merge_external_text;
use super::protocol::{broadcast, sync_update_msg};
use super::{rooms, Room, CHECKPOINT_INTERVAL};
use crate::state::AppState;
use bytes::Bytes;
use std::sync::Arc;
use yrs::{GetString, ReadTxn, StateVector, Transact};

/// Every 5 s, dump the doc to disk if dirty. Exits when the room is
/// gone (Arc dropped) or empty. `id` is the registry key, `path` the file.
pub(super) fn spawn_checkpoint_loop(room: Arc<Room>, id: String, path: String, app: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CHECKPOINT_INTERVAL).await;
            // Bail if the room was evicted (last-out flush already ran):
            // post-eviction flushes are wasted writes.
            let evicted = rooms()
                .map
                .get(&id)
                .map(|r| !Arc::ptr_eq(&r, &room))
                .unwrap_or(true);
            if evicted {
                return;
            }
            flush_room_to_disk(&room, &id, &path, &app).await;
        }
    });
}

pub(super) async fn flush_room_to_disk(room: &Room, id: &str, path: &str, app: &AppState) {
    // The room versions the file's CONTENT: a pdf's sidecar json, else the
    // file itself. Disk IO (seed mtime, foreign-write detect, checkpoint
    // write) targets the content path; history + remote-write protection key
    // off the owner path (`path`) so a pdf's `.history/` lands in its
    // `.<stem>.assets/` and the sidecar identity stays protected.
    let content_path = crate::meta::content_path(path);
    // editor.md Collaboration: disk mtime newer than our last checkpoint
    // means a non-collab write landed (push / pull / external editor).
    // Merge it like a peer that went offline at the checkpoint and came
    // back with edits. Only when the file is unreadable do we keep the
    // old reset: peers' WS senders are released so their outbound tasks
    // close the sockets, and reconnect re-seeds the room from disk.
    let disk_mtime_now = app
        .space()
        .get_file_meta(&content_path)
        .await
        .map(|e| e.mtime)
        .unwrap_or(0);
    if disk_mtime_now > room.state.lock().unwrap().last_disk_mtime {
        let disk = match app.space().read_file(&content_path).await {
            Ok((bytes, entry)) => String::from_utf8(bytes).ok().map(|s| (s, entry.mtime)),
            Err(_) => None,
        };
        let Some((disk_text, mtime)) = disk else {
            tracing::info!("collab: unreadable external write on {content_path}; resetting room");
            rooms().map.remove(id);
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

    let (snapshot, version, encoded, has_remote) = {
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
            st.has_remote,
        )
    };
    // Once a remote peer has joined, the identity is read-only: a markdown
    // file keeps its on-disk frontmatter, a pdf sidecar keeps its on-disk
    // metadata identity (id/title/tags/backrefs); only the body / annotations
    // persist (design.md). A purely local room persists the snapshot verbatim.
    let to_write: Vec<u8> = if has_remote {
        match app.space().read_file(&content_path).await {
            Ok((disk, _)) => {
                if crate::meta::is_pdf(path) {
                    crate::meta::merge_remote_sidecar(&disk, snapshot.as_bytes())
                } else {
                    crate::frontmatter::merge_remote_frontmatter(&disk, snapshot.as_bytes())
                }
            }
            Err(_) => snapshot.clone().into_bytes(),
        }
    } else {
        snapshot.clone().into_bytes()
    };
    match app.space().write_file(&content_path, &to_write, None).await {
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
            // SPEC-redesign history: every save records a row. Collab
            // checkpoints are the "save" event while a peer is connected,
            // so they must record an `edit` row too (otherwise enabling
            // collab silently drops all snapshots for that file).
            crate::handlers::fs::record_history(path, &written, &to_write, None, None);
        }
        Err(e) => {
            tracing::warn!("collab checkpoint write {path}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{new_room, rooms, Room};
    use super::flush_room_to_disk;
    use crate::state::AppState;
    use std::sync::Arc;
    use yrs::{GetString, Text, Transact};

    // Minimal AppState; the file path is the history key, so no extra wiring.
    fn test_app() -> AppState {
        AppState {
            client_bundle: crate::space::ClientBundle::new(),
            boundary: Arc::new(arc_swap::ArcSwap::from_pointee(crate::state::Boundary::default())),
            resolver: Arc::new(crate::resolver::Resolver::new(vec![])),
            auth_token: String::new(),
            build_time: String::new(),
            started_at: String::new(),
            pid: 0,
            config_path: None,
            watcher: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn abs(dir: &std::path::Path, name: &str) -> String {
        dir.join(name).to_string_lossy().into_owned()
    }

    fn room_text(room: &Room) -> String {
        let st = room.state.lock().unwrap();
        let ytext = st.doc.get_or_insert_text("content");
        let tx = st.doc.transact();
        ytext.get_string(&tx)
    }

    // Edit the live doc and mark it dirty like an applied SYNC_UPDATE,
    // so the next flush has something to persist.
    fn dirty_edit(room: &Room, at: u32, ins: &str) {
        let mut st = room.state.lock().unwrap();
        let ytext = st.doc.get_or_insert_text("content");
        let mut tx = st.doc.transact_mut();
        ytext.insert(&mut tx, at, ins);
        drop(tx);
        st.dirty = true;
        st.updates_applied += 1;
    }

    // --- seeding the doc from disk (new_room) ---

    #[test]
    fn seed_loads_text_without_dirtying() {
        // editor.md: the seed transaction must not mark the doc dirty,
        // else a spurious 5s checkpoint would rewrite the file and break
        // mtime-based optimistic concurrency.
        let room = new_room(Some(("hello world\n".to_string(), 42)), true);
        assert_eq!(room_text(&room), "hello world\n");
        let st = room.state.lock().unwrap();
        assert!(!st.dirty, "seed must not dirty the doc");
        assert_eq!(st.updates_applied, 0);
        assert_eq!(st.last_disk_mtime, 42);
        // Checkpoint pair records the seeded text for later foreign-write diffs.
        assert_eq!(st.checkpoint_text, "hello world\n");
        assert!(!st.checkpoint_update.is_empty());
    }

    #[test]
    fn empty_seed_is_clean_and_blank() {
        // New file (None) and explicit empty text both yield a blank,
        // non-dirty doc with mtime 0.
        for seed in [None, Some((String::new(), 0))] {
            let room = new_room(seed, true);
            assert_eq!(room_text(&room), "");
            let st = room.state.lock().unwrap();
            assert!(!st.dirty);
            assert_eq!(st.last_disk_mtime, 0);
            assert_eq!(st.checkpoint_text, "");
        }
    }

    // --- last-peer-out / 5s checkpoint flush (flush_room_to_disk) ---

    #[tokio::test]
    async fn dirty_doc_flushes_to_disk() {
        // The last-out flush and the 5s tick both call flush_room_to_disk:
        // a dirty doc must be written verbatim to disk.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let note = abs(dir.path(), "note.txt");
        app.space().write_file(&note, b"base\n", None).await.unwrap();
        let (seed, mtime) = {
            let (b, e) = app.space().read_file(&note).await.unwrap();
            (String::from_utf8(b).unwrap(), e.mtime)
        };
        let room = new_room(Some((seed, mtime)), true);
        dirty_edit(&room, 0, "X");

        flush_room_to_disk(&room, &note, &note, &app).await;

        let (bytes, _) = app.space().read_file(&note).await.unwrap();
        assert_eq!(bytes, b"Xbase\n");
    }

    #[tokio::test]
    async fn flush_protects_frontmatter_once_a_remote_peer_joined() {
        // A local-first room that a remote peer later joined is frontmatter
        // read-only for the rest of its life (per-connection, not per-room).
        // A CRDT edit that rewrites the frontmatter must not be persisted:
        // the on-disk frontmatter survives, only the body changes.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let note = abs(dir.path(), "note.md");
        app.space()
            .write_file(&note, b"---\ntitle: real\nrefs: [a.md]\n---\nbody\n", None)
            .await
            .unwrap();
        let (seed, mtime) = {
            let (b, e) = app.space().read_file(&note).await.unwrap();
            (String::from_utf8(b).unwrap(), e.mtime)
        };
        // Local first-opener (loopback=true), then a remote peer latches it.
        let room = new_room(Some((seed, mtime)), true);
        room.state.lock().unwrap().has_remote = true;
        // Replace the whole doc, including the frontmatter block.
        {
            let mut st = room.state.lock().unwrap();
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            let len = ytext.get_string(&tx).len() as u32;
            ytext.remove_range(&mut tx, 0, len);
            ytext.insert(&mut tx, 0, "---\ntitle: HACK\nrefs: [evil.md]\n---\nnew body\n");
            drop(tx);
            st.dirty = true;
            st.updates_applied += 1;
        }

        flush_room_to_disk(&room, &note, &note, &app).await;

        let (bytes, _) = app.space().read_file(&note).await.unwrap();
        let fm = crate::frontmatter::scan_frontmatter(&bytes);
        assert_eq!(fm.title, "real", "remote peer cannot change title");
        assert_eq!(fm.refs, vec!["a.md"], "remote peer cannot change refs");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.ends_with("new body\n"), "body edit accepted: {s:?}");
    }

    #[tokio::test]
    async fn flush_clears_dirty_and_advances_checkpoint() {
        // A successful flush clears `dirty` (no concurrent update landed)
        // and refreshes the checkpoint pair + mtime so the next tick sees
        // our own write, not a foreign one.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let note = abs(dir.path(), "note.txt");
        app.space().write_file(&note, b"base\n", None).await.unwrap();
        let (seed, mtime) = {
            let (b, e) = app.space().read_file(&note).await.unwrap();
            (String::from_utf8(b).unwrap(), e.mtime)
        };
        let room = new_room(Some((seed, mtime)), true);
        dirty_edit(&room, 0, "X");

        flush_room_to_disk(&room, &note, &note, &app).await;

        let disk_mtime = app.space().get_file_meta(&note).await.unwrap().mtime;
        let st = room.state.lock().unwrap();
        assert!(!st.dirty, "flush with no mid-write update clears dirty");
        assert_eq!(st.checkpoint_text, "Xbase\n");
        assert_eq!(st.last_disk_mtime, disk_mtime);
        // Re-detecting our own write as foreign would re-merge it.
        assert!(
            disk_mtime <= st.last_disk_mtime,
            "checkpoint mtime must cover our own write"
        );
    }

    #[tokio::test]
    async fn flush_keeps_dirty_when_update_lands_mid_write() {
        // updates_applied is snapshotted before the disk write and dirty
        // is cleared only if it still matches afterward, else a mid-write
        // edit would be dropped from the next window. Race a counter bump
        // against the (real, fsync-ing) write: a concurrent task waits for
        // the write to start, then mutates the doc like an applied update.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let note = abs(dir.path(), "note.txt");
        app.space().write_file(&note, b"base\n", None).await.unwrap();
        let (seed, mtime) = {
            let (b, e) = app.space().read_file(&note).await.unwrap();
            (String::from_utf8(b).unwrap(), e.mtime)
        };
        let room = new_room(Some((seed, mtime)), true); // already Arc<Room>
        dirty_edit(&room, 0, "X");

        // flush snapshots updates_applied, then awaits a real fsync-ing
        // write_file (which yields via spawn_blocking). A concurrent task
        // bumps the counter across that yield window, so the post-write
        // equality check is guaranteed to miss and dirty is preserved.
        // yield_now between bumps keeps the mover live whenever flush is
        // parked on the blocking write.
        let mover = {
            let room = room.clone();
            tokio::spawn(async move {
                for _ in 0..200 {
                    room.state.lock().unwrap().updates_applied += 1;
                    tokio::task::yield_now().await;
                }
            })
        };
        flush_room_to_disk(&room, &note, &note, &app).await;
        mover.await.unwrap();

        assert!(
            room.state.lock().unwrap().dirty,
            "a mid-write update must keep the room dirty"
        );
        // The bytes were still flushed.
        let (bytes, _) = app.space().read_file(&note).await.unwrap();
        assert_eq!(bytes, b"Xbase\n");
    }

    #[tokio::test]
    async fn clean_doc_flush_is_noop() {
        // Not dirty: flush must neither create nor touch the file.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let ghost = abs(dir.path(), "ghost.txt");
        let room = new_room(Some(("untouched\n".to_string(), 1)), true);
        // No dirty_edit: doc matches disk-of-record (which doesn't exist).
        flush_room_to_disk(&room, &ghost, &ghost, &app).await;
        assert!(
            app.space().get_file_meta(&ghost).await.is_err(),
            "clean doc must not write a file"
        );
    }

    #[tokio::test]
    async fn flush_without_foreign_write_does_not_evict() {
        // Plain dirty flush (no newer disk mtime) keeps peers connected,
        // unlike the unreadable/vanished foreign-write reset paths.
        let dir = tempfile::TempDir::new().unwrap();
        let app = test_app();
        let note = abs(dir.path(), "note.txt");
        app.space().write_file(&note, b"base\n", None).await.unwrap();
        let (seed, mtime) = {
            let (b, e) = app.space().read_file(&note).await.unwrap();
            (String::from_utf8(b).unwrap(), e.mtime)
        };
        let room = new_room(Some((seed, mtime)), true);
        let (tx, _rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(8);
        room.clients.insert(1, tx);
        dirty_edit(&room, 0, "X");

        flush_room_to_disk(&room, &note, &note, &app).await;
        assert!(room.clients.contains_key(&1), "normal flush keeps peers");
    }

    // --- 5s checkpoint-loop eviction decision ---

    #[test]
    fn checkpoint_loop_eviction_decision() {
        // spawn_checkpoint_loop bails when the registry no longer maps the
        // path to THIS room Arc (evicted by last-out flush, or replaced by
        // a fresh room after re-seed). Mirror that exact predicate.
        let path = "evict-decision-probe.md".to_string();
        let room = new_room(None, true);
        let decide = |r: &Arc<Room>| {
            rooms()
                .map
                .get(&path)
                .map(|e| !Arc::ptr_eq(&e, r))
                .unwrap_or(true)
        };

        // Absent from registry -> evicted (true).
        rooms().map.remove(&path);
        assert!(decide(&room), "missing entry means evicted");

        // Same Arc registered -> live (false).
        rooms().map.insert(path.clone(), room.clone());
        assert!(!decide(&room), "our own room must not be seen as evicted");

        // Replaced by a different Arc -> evicted (true).
        let replacement = new_room(None, true);
        rooms().map.insert(path.clone(), replacement);
        assert!(decide(&room), "a replacement room evicts the old loop");

        rooms().map.remove(&path);
    }
}
