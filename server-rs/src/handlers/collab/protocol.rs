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

#[cfg(test)]
mod tests {
    // Sibling collab/tests.rs already covers the varuint happy-path
    // roundtrip and apply_incoming_sync (noop/delete/live). These target
    // the gaps: the frame codec, read_varuint edge cases, and the
    // StateVector / SYNC_STEP_2 sync roundtrip.
    // MSG_SYNC / SYNC_* and the local codec fns come in via `super::*`
    // (protocol.rs re-imports the constants from its parent). new_room
    // is only in the parent, so pull it explicitly.
    use super::super::new_room;
    use super::*;
    use yrs::GetString;

    // ---- extract_sync_payload <-> sync_frame ----

    #[test]
    fn frame_roundtrips_through_extract() {
        // Short payload (1-byte len) and a >127-byte payload (multi-byte
        // varuint length) must both survive the encode/decode roundtrip.
        for payload in [vec![1u8, 2, 3], vec![0xABu8; 300]] {
            let frame = sync_frame(SYNC_UPDATE, &payload);
            assert_eq!(frame[0], MSG_SYNC);
            assert_eq!(frame[1], SYNC_UPDATE);
            let got = extract_sync_payload(&frame, SYNC_UPDATE).unwrap();
            assert_eq!(got, payload);
        }
    }

    #[test]
    fn extract_empty_payload_is_some_not_none() {
        // Zero-length payload is a valid frame (e.g. an empty diff),
        // distinct from a malformed frame.
        let frame = sync_frame(SYNC_STEP_2, &[]);
        assert_eq!(extract_sync_payload(&frame, SYNC_STEP_2), Some(Vec::new()));
    }

    #[test]
    fn extract_rejects_wrong_sub() {
        let frame = sync_frame(SYNC_STEP_1, &[9, 9, 9]);
        assert!(extract_sync_payload(&frame, SYNC_STEP_2).is_none());
        assert!(extract_sync_payload(&frame, SYNC_UPDATE).is_none());
        assert!(extract_sync_payload(&frame, SYNC_STEP_1).is_some());
    }

    #[test]
    fn extract_rejects_short_buffer() {
        for buf in [&[][..], &[MSG_SYNC][..], &[MSG_SYNC, SYNC_UPDATE][..]] {
            assert!(extract_sync_payload(buf, SYNC_UPDATE).is_none());
        }
    }

    #[test]
    fn extract_rejects_truncated_payload() {
        // Header claims len 5 but only 2 payload bytes follow.
        let buf = [MSG_SYNC, SYNC_UPDATE, 5, 0xAA, 0xBB];
        assert!(extract_sync_payload(&buf, SYNC_UPDATE).is_none());
    }

    // ---- read_varuint edge cases (sibling only tests the happy path) ----

    #[test]
    fn read_varuint_reports_consumed_len() {
        // 300 = 0xAC 0x02: two bytes consumed, value 300.
        let mut b = Vec::new();
        write_varuint(&mut b, 300);
        assert_eq!(read_varuint(&b), Some((300, 2)));
        // A trailing byte must not be consumed.
        b.push(0x77);
        assert_eq!(read_varuint(&b), Some((300, 2)));
    }

    #[test]
    fn read_varuint_truncated_is_none() {
        // Continuation bit set on the last available byte: incomplete.
        assert!(read_varuint(&[0x80]).is_none());
        assert!(read_varuint(&[0xAC]).is_none());
    }

    #[test]
    fn read_varuint_overlong_is_none() {
        // 10 continuation bytes overflow u64 / never terminate -> None,
        // guarding the decode loop against unbounded/garbage input.
        let overlong = [0x80u8; 11];
        assert!(read_varuint(&overlong).is_none());
    }

    // ---- StateVector + SYNC_STEP_2 sync roundtrip ----

    /// A doc holding the room's full history, plus its state vector.
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

    #[test]
    fn step1_carries_the_rooms_state_vector() {
        // StateVector encode (in sync_step_1_msg) -> extract -> decode
        // must reproduce the room's own state vector exactly.
        let room = new_room(Some(("alpha beta\n".to_string(), 1)), true);
        let frame = sync_step_1_msg(&room);
        assert_eq!(&frame[..2], [MSG_SYNC, SYNC_STEP_1]);
        let payload = extract_sync_payload(&frame, SYNC_STEP_1).unwrap();
        let decoded = StateVector::decode_v1(&payload).unwrap();
        let expected = room.state.lock().unwrap().doc.transact().state_vector();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn empty_doc_state_vector_roundtrips() {
        // A brand-new empty doc has an empty state vector; it must still
        // encode and decode cleanly (no panic, equal result).
        let room = new_room(None, true);
        let payload = extract_sync_payload(&sync_step_1_msg(&room), SYNC_STEP_1).unwrap();
        assert_eq!(StateVector::decode_v1(&payload).unwrap(), StateVector::default());
    }

    #[test]
    fn step2_reply_brings_a_blank_peer_up_to_date() {
        // A peer with nothing (default SV) gets a STEP_2 diff that, applied
        // to its blank doc, reproduces the room's text in full.
        let room = new_room(Some(("hello world\n".to_string(), 1)), true);
        let frame = sync_step_2_reply(&room, &StateVector::default());
        assert_eq!(&frame[..2], [MSG_SYNC, SYNC_STEP_2]);
        let diff = extract_sync_payload(&frame, SYNC_STEP_2).unwrap();

        let peer = yrs::Doc::new();
        {
            let mut tx = peer.transact_mut();
            tx.apply_update(Update::decode_v1(&diff).unwrap()).unwrap();
        }
        let ytext = peer.get_or_insert_text("content");
        assert_eq!(ytext.get_string(&peer.transact()), "hello world\n");
    }

    #[test]
    fn step2_reply_to_caught_up_peer_is_an_empty_diff() {
        // When the peer's SV already equals the room's, the STEP_2 payload
        // is an update that adds nothing: applying it is a no-op.
        let room = new_room(Some(("synced\n".to_string(), 1)), true);
        let (peer, sv) = fork_of(&room);
        let diff = extract_sync_payload(&sync_step_2_reply(&room, &sv), SYNC_STEP_2).unwrap();
        {
            let mut tx = peer.transact_mut();
            tx.apply_update(Update::decode_v1(&diff).unwrap()).unwrap();
        }
        let ytext = peer.get_or_insert_text("content");
        assert_eq!(ytext.get_string(&peer.transact()), "synced\n");
    }
}
