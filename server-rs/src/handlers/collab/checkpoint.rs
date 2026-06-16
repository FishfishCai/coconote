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
/// gone (Arc dropped) or empty.
pub(super) fn spawn_checkpoint_loop(room: Arc<Room>, path: String, app: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CHECKPOINT_INTERVAL).await;
            // Bail if the room was evicted (last-out flush already ran):
            // post-eviction flushes are wasted writes.
            let evicted = rooms()
                .map
                .get(&path)
                .map(|r| !Arc::ptr_eq(&r, &room))
                .unwrap_or(true);
            if evicted {
                return;
            }
            flush_room_to_disk(&room, &path, &app).await;
        }
    });
}

pub(super) async fn flush_room_to_disk(room: &Room, path: &str, app: &AppState) {
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
