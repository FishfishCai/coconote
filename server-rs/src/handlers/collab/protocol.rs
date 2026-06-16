// Yjs sync wire codec and peer fan-out. Frame layout is
// `[MSG_SYNC, sub, varuint(len), payload]`; the sub byte is one of
// SYNC_STEP_1 / SYNC_STEP_2 / SYNC_UPDATE.

use super::{Room, MSG_SYNC, SYNC_STEP_1, SYNC_STEP_2, SYNC_UPDATE};
use bytes::Bytes;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact, Update};

/// Fan a frame out to every connected peer except `skip`. A peer whose
/// queue is full is dropped from the room (see PEER_QUEUE_DEPTH).
pub(super) fn broadcast(room: &Room, frame: Bytes, skip: Option<u64>) {
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
pub(super) fn apply_incoming_sync(room: &Room, bytes: &[u8]) {
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
pub(super) fn extract_sync_payload(buf: &[u8], expected_sub: u8) -> Option<Vec<u8>> {
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

pub(super) fn read_varuint(buf: &[u8]) -> Option<(usize, usize)> {
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

pub(super) fn write_varuint(buf: &mut Vec<u8>, mut n: usize) {
    while n > 0x7f {
        buf.push((0x80 | (n & 0x7f)) as u8);
        n >>= 7;
    }
    buf.push((n & 0x7f) as u8);
}

/// Build a `[MSG_SYNC, sub, varuint(len), payload]` frame.
fn sync_frame(sub: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![MSG_SYNC, sub];
    write_varuint(&mut out, payload.len());
    out.extend_from_slice(payload);
    out
}

/// SYNC_STEP_1: the server's own sync request, sent to every newly-registered
/// peer (its current state vector).
pub(super) fn sync_step_1_msg(room: &Room) -> Vec<u8> {
    let st = room.state.lock().unwrap();
    let sv = st.doc.transact().state_vector().encode_v1();
    sync_frame(SYNC_STEP_1, &sv)
}

/// SYNC_UPDATE: server-originated update fan-out (external write merge).
pub(super) fn sync_update_msg(update: &[u8]) -> Vec<u8> {
    sync_frame(SYNC_UPDATE, update)
}

/// SYNC_STEP_2: the diff a peer is missing, computed from its state vector.
pub(super) fn sync_step_2_reply(room: &Room, peer_sv: &StateVector) -> Vec<u8> {
    let st = room.state.lock().unwrap();
    let update = st.doc.transact().encode_state_as_update_v1(peer_sv);
    sync_frame(SYNC_STEP_2, &update)
}
