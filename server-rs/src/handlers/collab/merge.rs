// CRDT merge of a foreign disk write (push / pull / external editor) into a
// live room, per editor.md Collaboration: replay the checkpoint on a fork,
// splice the checkpoint -> disk diff into it, then apply the ops the live doc
// is missing so concurrent peer edits survive.

use super::RoomState;
use std::time::Duration;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Text, Transact, Update};

/// Merge a foreign disk write into the live doc like a returning offline
/// peer. Because fork and live share history up to the checkpoint, yrs
/// merges the external edits with concurrent client edits. Returns the
/// applied update for broadcast, or None when the disk text matches the
/// checkpoint.
pub(super) fn merge_external_text(st: &mut RoomState, disk_text: &str) -> Option<Vec<u8>> {
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

#[cfg(test)]
mod tests {
    // merge.rs is a descendant of collab/mod.rs, so this child module can
    // name the private RoomState/Room and call the private new_room. We seed
    // rooms via new_room (it fills checkpoint_update/checkpoint_text for us)
    // and drive merge_external_text directly. The sibling tests.rs covers the
    // flush_room_to_disk integration path and a CJK/emoji direct merge; these
    // target the merge primitive's return value, the no-op guard, side
    // effects, pure-delete, overlapping edits, and the splice/offset helpers.
    use super::super::{new_room, Room};
    use super::{byte_offsets, merge_external_text, text_splices};
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, ReadTxn, StateVector, Text, Transact, Update};

    /// Current text of the room's live "content" Y.Text.
    fn room_text(room: &Room) -> String {
        let st = room.state.lock().unwrap();
        let ytext = st.doc.get_or_insert_text("content");
        let tx = st.doc.transact();
        ytext.get_string(&tx)
    }

    /// Replay `old` -> `new` purely through text_splices (reverse order, the
    /// contract the caller relies on) and return the reconstructed string.
    fn apply_splices(old: &str, new: &str) -> String {
        let mut buf = old.to_string();
        for s in text_splices(old, new).iter().rev() {
            let (at, end) = (s.at as usize, (s.at + s.del) as usize);
            buf.replace_range(at..end, &s.insert);
        }
        buf
    }

    #[test]
    fn noop_when_disk_matches_checkpoint() {
        let room = new_room(Some(("alpha\nbeta\n".to_string(), 7)), true);
        let mut st = room.state.lock().unwrap();
        // Identical text: no diff, no work, no broadcast.
        assert!(merge_external_text(&mut st, "alpha\nbeta\n").is_none());
        // Guard must not touch any of the flush-relevant fields.
        assert!(!st.dirty);
        assert_eq!(st.updates_applied, 0);
        assert_eq!(st.last_disk_mtime, 7);
    }

    #[test]
    fn pure_append_no_concurrent_edit_takes_disk_text() {
        let room = new_room(Some(("line one\n".to_string(), 1)), true);
        let mut st = room.state.lock().unwrap();
        let out = merge_external_text(&mut st, "line one\nline two\n");
        assert!(out.is_some(), "a real change must produce a broadcast update");
        drop(st);
        // No concurrent peer edit -> live doc becomes exactly the disk text.
        assert_eq!(room_text(&room), "line one\nline two\n");
        let st = room.state.lock().unwrap();
        assert!(st.dirty, "an applied merge must dirty the room for flushing");
        assert_eq!(st.updates_applied, 1);
        // The checkpoint itself is NOT advanced by a merge (the flush loop
        // owns that): the next diff is still measured from the old baseline.
        assert_eq!(st.checkpoint_text, "line one\n");
    }

    #[test]
    fn pure_deletion_external_write_applies() {
        // Existing direct test only inserts; cover a shrinking disk file.
        let room = new_room(Some(("keep DELETE keep\n".to_string(), 1)), true);
        let mut st = room.state.lock().unwrap();
        merge_external_text(&mut st, "keep keep\n").expect("merge");
        drop(st);
        assert_eq!(room_text(&room), "keep keep\n");
    }

    #[test]
    fn concurrent_edit_survives_non_overlapping() {
        // Peer types at the head; external write changes a later region.
        let room = new_room(Some(("AAA\nBBB\nCCC\n".to_string(), 1)), true);
        let mut st = room.state.lock().unwrap();
        {
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            ytext.insert(&mut tx, 0, "X "); // -> "X AAA\nBBB\nCCC\n"
        }
        st.updates_applied = 1;
        // External edit is diffed against the CHECKPOINT ("AAA..."), so it
        // merges like a returning peer rather than clobbering the live edit.
        merge_external_text(&mut st, "AAA\nBBB\nZZZ\n").expect("merge");
        drop(st);
        assert_eq!(room_text(&room), "X AAA\nBBB\nZZZ\n");
    }

    #[test]
    fn concurrent_edit_survives_overlapping_region() {
        // Both edits touch the same line. CRDT must keep both contributions
        // (intention preservation), not drop the live one.
        let room = new_room(Some(("hello world\n".to_string(), 1)), true);
        let mut st = room.state.lock().unwrap();
        {
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            ytext.insert(&mut tx, 5, " LIVE"); // "hello LIVE world\n"
        }
        st.updates_applied = 1;
        // External write appends to the same line relative to checkpoint.
        merge_external_text(&mut st, "hello world DISK\n").expect("merge");
        drop(st);
        let got = room_text(&room);
        assert!(got.contains("LIVE"), "live insert lost: {got:?}");
        assert!(got.contains("DISK"), "disk insert lost: {got:?}");
        assert!(got.starts_with("hello"));
    }

    #[test]
    fn returned_update_replays_onto_live_peer() {
        // The Some(update) is the delta sent to peers that already hold the
        // live state (it is encoded against the live state vector, so it
        // carries only the disk diff). A peer that applies it must converge
        // to the same merged text the server has.
        let room = new_room(Some(("base\n".to_string(), 1)), true);
        let mut st = room.state.lock().unwrap();
        {
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            ytext.insert(&mut tx, 4, " live"); // "base live\n"
        }
        st.updates_applied = 1;
        // Snapshot the live state a peer would already have, pre-merge.
        let live_full = st
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let update = merge_external_text(&mut st, "base disk\n").expect("merge");
        drop(st);
        let expected = room_text(&room);

        // Peer = pre-merge live state, then the broadcast delta.
        let peer = yrs::Doc::new();
        let ptext = peer.get_or_insert_text("content");
        {
            let mut tx = peer.transact_mut();
            tx.apply_update(Update::decode_v1(&live_full).unwrap()).unwrap();
            tx.apply_update(Update::decode_v1(&update).unwrap()).unwrap();
        }
        assert_eq!(ptext.get_string(&peer.transact()), expected);
        // Sanity: the merge actually combined both sources.
        assert!(expected.contains("live") && expected.contains("disk"), "{expected:?}");
    }

    #[test]
    fn merge_result_matches_independent_offline_peer() {
        // Cross-check merge_external_text against a hand-rolled offline-peer
        // merge of the SAME shape: fork the checkpoint, splice in the disk
        // diff, diff against the live state vector. The two forks are separate
        // Docs with different random client_ids, so the encoded bytes differ;
        // what must match is the converged TEXT once each delta is applied to
        // a peer holding the live state.
        let room = new_room(Some(("red green blue\n".to_string(), 1)), true);
        let checkpoint = {
            let st = room.state.lock().unwrap();
            st.checkpoint_update.clone()
        };
        let mut st = room.state.lock().unwrap();
        {
            let ytext = st.doc.get_or_insert_text("content");
            let mut tx = st.doc.transact_mut();
            ytext.insert(&mut tx, 0, "C "); // live edit at the head
        }
        st.updates_applied = 1;
        let live_full = st
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let live_sv = st.doc.transact().state_vector();

        // Reference offline-peer merge, mirroring merge_external_text.
        let fork = yrs::Doc::new();
        let ftext = fork.get_or_insert_text("content");
        {
            let mut tx = fork.transact_mut();
            tx.apply_update(Update::decode_v1(&checkpoint).unwrap()).unwrap();
            for s in text_splices("red green blue\n", "red GREEN blue\n").iter().rev() {
                if s.del > 0 {
                    ftext.remove_range(&mut tx, s.at, s.del);
                }
                if !s.insert.is_empty() {
                    ftext.insert(&mut tx, s.at, &s.insert);
                }
            }
        }
        let from_fork = fork.transact().encode_state_as_update_v1(&live_sv);
        let from_merge = merge_external_text(&mut st, "red GREEN blue\n").expect("merge");
        drop(st);

        // The server's own result.
        let server_text = room_text(&room);
        assert_eq!(server_text, "C red GREEN blue\n");
        // The reference delta, applied to a live peer, converges identically.
        let peer = yrs::Doc::new();
        let ptext = peer.get_or_insert_text("content");
        {
            let mut tx = peer.transact_mut();
            tx.apply_update(Update::decode_v1(&live_full).unwrap()).unwrap();
            tx.apply_update(Update::decode_v1(&from_fork).unwrap()).unwrap();
        }
        assert_eq!(ptext.get_string(&peer.transact()), server_text);
        // And the merge did return a non-empty broadcast delta.
        assert!(!from_merge.is_empty());
    }

    #[test]
    fn text_splices_reverse_apply_reconstructs_new() {
        // The core invariant the merge relies on: splices applied in reverse
        // turn `old` into `new`. Cover insert, delete, and middle replace.
        for (old, new) in [
            ("", "fresh"),
            ("gone", ""),
            ("abcXYZdef", "abcdef"),            // middle delete
            ("abcdef", "abcMIDdef"),            // middle insert
            ("the quick fox", "the slow brown fox"), // middle replace
        ] {
            assert_eq!(apply_splices(old, new), new, "old={old:?} new={new:?}");
        }
    }

    #[test]
    fn text_splices_offsets_are_utf8_bytes() {
        // Diff after a multibyte prefix: the splice offset must be the BYTE
        // start of the edit, not the char index, or Y.Text would misplace it.
        let old = "ab\u{4f60}\u{597d}cd"; // a b U+4F60 U+597D c d
        let new = "ab\u{4f60}\u{597d}Xcd"; // insert 'X' before 'c'
        let sp = text_splices(old, new);
        assert_eq!(sp.len(), 1);
        // "ab" = 2 bytes, two 3-byte CJK chars = 6 bytes -> offset 8.
        assert_eq!(sp[0].at, 8);
        assert_eq!(sp[0].del, 0);
        assert_eq!(sp[0].insert, "X");
        assert_eq!(apply_splices(old, new), new);
    }

    #[test]
    fn byte_offsets_ascii_and_multibyte() {
        // ASCII: offset i for char i, plus the trailing length entry.
        assert_eq!(byte_offsets("abc"), vec![0, 1, 2, 3]);
        // Mixed width: 'a'(1) + U+00E9(2) + U+4E16(3) + 'z'(1).
        assert_eq!(byte_offsets("a\u{e9}\u{4e16}z"), vec![0, 1, 3, 6, 7]);
        // Empty string still yields the single end-of-string offset.
        assert_eq!(byte_offsets(""), vec![0]);
    }

    #[test]
    fn empty_checkpoint_to_full_disk_write() {
        // A brand-new file seeds an empty doc (checkpoint_text == ""); the
        // first external write must populate it wholesale.
        let room = new_room(None, true);
        let mut st = room.state.lock().unwrap();
        assert_eq!(st.checkpoint_text, "");
        merge_external_text(&mut st, "first content\n").expect("merge");
        drop(st);
        assert_eq!(room_text(&room), "first content\n");
    }
}
