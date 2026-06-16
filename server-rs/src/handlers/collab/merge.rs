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
