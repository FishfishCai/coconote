// One-shot Yjs sync client over `ws`, modeled on the product's own
// hand-rolled client for this server (client/collab/collab_extension.ts).
//
// Why not y-websocket: its v3 url getter keeps room slashes verbatim
// (serverUrl + "/" + roomname), but it cannot express the two things a
// one-shot tool call needs. (1) A real server ack: this server never
// echoes a peer's update back to its sender (collab.rs broadcast skips
// the sender id), so the only reliable ack is a SyncStep1 round trip,
// which needs raw socket access. (2) Fail fast: y-websocket turns a 403
// or 404 handshake into endless silent reconnects instead of an error.
//
// Ack-before-disconnect: the server handles frames strictly in arrival
// order and answers SyncStep1 inline from the same receive loop
// (server-rs/src/handlers/collab.rs). After fn ran, we send one more
// SyncStep1 and wait for its SyncStep2 reply. That reply proves every
// update frame sent before it was already applied to the server's room
// doc. On our disconnect the server's last-client-out flush (or its 5s
// checkpoint loop) persists the doc to disk.

import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { encodePathSegments } from "./api";
import { token, wsBaseUrl } from "./config";

const MESSAGE_SYNC = 0;
const CONNECT_TIMEOUT_MS = 10_000;
const ROUND_TRIP_TIMEOUT_MS = 10_000;

export type Room = { doc: Y.Doc; ytext: Y.Text };

type Waiter = {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Connect to the collab room for `path`, wait for the initial sync,
 * run `fn` (which mutates the Y.Text in one or more transactions),
 * wait for the server to ack the local updates, then disconnect.
 *
 * Updates stream to the server as each transaction commits, so `fn`
 * must finish all validation before its first mutation.
 */
export async function withRoom<T>(path: string, fn: (room: Room) => T | Promise<T>): Promise<T> {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  const t = token();
  const url = `${wsBaseUrl()}/.collab/${encodePathSegments(path)}` +
    (t ? `?token=${encodeURIComponent(t)}` : "");
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let closing = false;
  let fatal: Error | null = null;
  const step2Waiters: Waiter[] = [];

  const abort = (err: Error) => {
    if (!fatal) fatal = err;
    while (step2Waiters.length > 0) {
      const w = step2Waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(err);
    }
  };

  const send = (frame: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  };

  // SyncStep1 round trip, resolved when the matching SyncStep2 arrives.
  const roundTrip = (label: string) =>
    new Promise<void>((resolve, reject) => {
      if (fatal) return reject(fatal);
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = step2Waiters.indexOf(waiter);
          if (i >= 0) step2Waiters.splice(i, 1);
          reject(new Error(
            `${label} timed out after ${ROUND_TRIP_TIMEOUT_MS}ms for ${path}. ` +
              `Check that the Coconote server is reachable.`,
          ));
        }, ROUND_TRIP_TIMEOUT_MS),
      };
      step2Waiters.push(waiter);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      send(encoding.toUint8Array(enc));
    });

  ws.on("message", (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return; // awareness ignored
    const replyEnc = encoding.createEncoder();
    encoding.writeVarUint(replyEnc, MESSAGE_SYNC);
    const messageType = syncProtocol.readSyncMessage(dec, replyEnc, doc, "remote");
    // Step2 only ever arrives as the reply to one of our Step1s.
    if (messageType === syncProtocol.messageYjsSyncStep2) {
      const w = step2Waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
    // Reply only when the protocol wrote something: a bare 1-byte
    // MESSAGE_SYNC header crashes peers' decoders when fanned out.
    if (encoding.length(replyEnc) > 1) send(encoding.toUint8Array(replyEnc));
  });

  let sentUpdates = 0;
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    sentUpdates += 1;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    send(encoding.toUint8Array(enc));
  };
  doc.on("update", onDocUpdate);

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `collab connect to ${path} timed out after ${CONNECT_TIMEOUT_MS}ms ` +
          `(${wsBaseUrl()}). Check COCONOTE_URL and that the server is running.`,
      );
      abort(err);
      reject(err);
    }, CONNECT_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const hint = res.statusCode === 403
        ? " Set COCONOTE_TOKEN (required for non-loopback servers)."
        : "";
      const err = new Error(`collab handshake for ${path} rejected: HTTP ${res.statusCode}.${hint}`);
      abort(err);
      reject(err);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      const err = new Error(`collab connection failed for ${path}: ${e.message}`);
      abort(err);
      reject(err);
    });
    ws.on("close", (code, reason) => {
      if (closing) return;
      clearTimeout(timer);
      const why = code === 1003
        ? " The file is not UTF-8 text (binary files cannot be edited over collab)."
        : code === 1009
          ? " A frame exceeded the server's 16MB cap, the page is too large."
          : "";
      const err = new Error(
        `collab connection for ${path} closed (code ${code}` +
          `${reason.length > 0 ? ` ${reason.toString()}` : ""}).${why}`,
      );
      abort(err);
      reject(err);
    });
  });

  try {
    await opened;
    // The server seeds the room from disk and answers with the full
    // state. After this the Y.Text is authoritative, even when empty.
    await roundTrip("initial collab sync");
    const result = await fn({ doc, ytext });
    if (fatal) throw fatal;
    if (sentUpdates > 0) await roundTrip("server ack of local edits");
    return result;
  } finally {
    closing = true;
    doc.off("update", onDocUpdate);
    try {
      ws.close();
    } catch {
      // already closed
    }
    doc.destroy();
  }
}
