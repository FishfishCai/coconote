// CodeMirror Yjs binding. Anonymous awareness — every connected client
// gets a colour for its cursor; no user identity. The server (server-rs
// handlers/collab.rs) is a full sync peer, not a relay: it keeps a yrs
// Doc per room, initiates SyncStep1 to each new peer (pulling their
// offline backlog), answers our SyncStep1 with SyncStep2, fans updates
// out, and checkpoints the doc to disk every 5 s. Lazily imported by
// the editor when collab is on.

import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { getAuthToken } from "../lib/authed_fetch.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// editor.md §Collaboration — UI dot encodes 4 phases:
// connecting (first try) | connected | reconnecting (after a drop) | disposed.
export type CollabStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disposed";

export type CollabHandle = {
  doc: Y.Doc;
  awareness: Awareness;
  extension: Extension;
  disconnect: () => void;
  /** Live connection state. */
  status: () => CollabStatus;
  /** True once the initial SyncStep2 arrived — i.e. the doc content is
   *  authoritative even if empty. */
  synced: () => boolean;
  /** Subscribe to status flips. Returns an unsubscribe fn. */
  onStatusChange: (cb: (s: CollabStatus) => void) => () => void;
};

// Cursor color is generated once per browser session so the same user
// keeps the same colour across page switches (vs randomising per
// connectCollab, which made one peer look like many). Falls back to
// a module-scoped cache when sessionStorage is unavailable (Safari
// private mode, embedded webviews) so the color is stable per page
// load at least.
let inMemoryCursorColor: string | null = null;
function sessionCursorColor(): string {
  if (inMemoryCursorColor) return inMemoryCursorColor;
  try {
    const cached = sessionStorage.getItem("coconote.cursorColor");
    if (cached) {
      inMemoryCursorColor = cached;
      return cached;
    }
  } catch {/* sessionStorage unavailable — fall through */}
  const hue = Math.floor(Math.random() * 360);
  const c = `hsl(${hue} 80% 45%)`;
  inMemoryCursorColor = c;
  try {
    sessionStorage.setItem("coconote.cursorColor", c);
  } catch {/* best effort */}
  return c;
}

/**
 * Connect to a collab session for `path`. Attach `extension` to your
 * EditorState; call `disconnect()` on unmount.
 */
export function connectCollab(path: string): CollabHandle {
  const doc = new Y.Doc();
  const yText = doc.getText("content");
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", {
    name: "anon",
    color: sessionCursorColor(),
  });

  // Browsers can't set Authorization on a WS handshake, so the server
  // accepts the token as a query param (server-rs handlers/collab.rs).
  // Without this, non-loopback servers reject with 403 and the client
  // sits in permanent reconnect.
  const wsUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = `${proto}://${location.host}/.collab/${
      path.split("/").map(encodeURIComponent).join("/")
    }`;
    const token = getAuthToken();
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  })();

  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let disposed = false;
  let reconnectAttempt = 0;
  let everConnected = false;
  let synced = false;
  let status: CollabStatus = "connecting";
  const statusSubscribers = new Set<(s: CollabStatus) => void>();
  const setStatus = (s: CollabStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of statusSubscribers) cb(s);
  };
  // editor.md §Collaboration: backoff 1, 2, 4, 8, 16, capped at 32 s,
  // with jitter. reconnectAttempt is already incremented when this runs,
  // so attempt 1 must map to 1 s (not 2 s).
  const reconnectDelayMs = () => {
    const exp = Math.min(Math.max(reconnectAttempt - 1, 0), 5);
    return 1000 * 2 ** exp + Math.floor(Math.random() * 500);
  };

  const open = () => {
    if (disposed) return;
    setStatus(everConnected ? "reconnecting" : "connecting");
    // Capture the socket per-connection so a close/error event from a
    // socket that's already been replaced (e.g. by an immediate
    // reconnect) is ignored — otherwise it would schedule a parallel
    // reconnect onto the live socket.
    const sock = new WebSocket(wsUrl);
    ws = sock;
    sock.binaryType = "arraybuffer";
    sock.addEventListener("open", () => {
      if (ws !== sock) return;
      reconnectAttempt = 0;
      everConnected = true;
      setStatus("connected");
      // Step 1: send our state vector.
      {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(enc, doc);
        sock.send(encoding.toUint8Array(enc));
      }
      // Step 2: send our awareness.
      {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
        );
        sock.send(encoding.toUint8Array(enc));
      }
    });
    sock.addEventListener("message", (e) => {
      if (ws !== sock) return;
      const buf = new Uint8Array(e.data as ArrayBuffer);
      const dec = decoding.createDecoder(buf);
      const kind = decoding.readVarUint(dec);
      if (kind === MESSAGE_SYNC) {
        const replyEnc = encoding.createEncoder();
        encoding.writeVarUint(replyEnc, MESSAGE_SYNC);
        const messageType = syncProtocol.readSyncMessage(
          dec,
          replyEnc,
          doc,
          "remote",
        );
        // The server's SyncStep2 answers our SyncStep1: initial content
        // delivered (possibly empty — that's authoritative too).
        if (messageType === syncProtocol.messageYjsSyncStep2) synced = true;
        // Reply only when the protocol wrote something — receiving a
        // Step2 writes nothing, and sending the bare 1-byte MESSAGE_SYNC
        // header would crash peers' decoders when the hub fans it out.
        if (encoding.length(replyEnc) > 1) {
          sock.send(encoding.toUint8Array(replyEnc));
        }
      } else if (kind === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, "remote");
      }
    });
    sock.addEventListener("close", () => {
      if (ws !== sock) return; // superseded by a newer socket; ignore
      ws = null;
      if (disposed) return;
      // Stay on "connecting" until the first success — spec keeps
      // "reconnecting" for AFTER an established session drops.
      setStatus(everConnected ? "reconnecting" : "connecting");
      reconnectAttempt += 1;
      reconnectTimer = self.setTimeout(open, reconnectDelayMs());
    });
    sock.addEventListener("error", () => {
      if (ws === sock) sock.close();
    });
  };
  open();

  // Local doc updates → broadcast.
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      ws.send(encoding.toUint8Array(enc));
    }
  };
  doc.on("update", onDocUpdate);
  const onAwarenessChange = (
    { added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    },
  ) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const changed = added.concat(updated).concat(removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      ws.send(encoding.toUint8Array(enc));
    }
  };
  awareness.on("update", onAwarenessChange);

  // editor.md: undo/redo must be Yjs-aware under collab — bind the
  // Y.UndoManager keymap above CodeMirror's history (which the attach
  // path disables for the session) so Cmd+Z can't revert peers' edits.
  const extension: Extension = [
    yCollab(yText, awareness),
    Prec.high(keymap.of(yUndoManagerKeymap)),
  ];

  // editor.md §Collaboration: tab visible / network online / window
  // focus → cancel pending backoff and try immediately. Resets the
  // attempt counter so wake-on-broken-network doesn't wait the full
  // 32s capped delay.
  const triggerImmediateReconnect = () => {
    if (disposed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      // Already connected or handshaking — nothing to retry.
      return;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    // open() installs a fresh socket; the old one's close event is
    // ignored by the per-socket guard in open().
    open();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") triggerImmediateReconnect();
  };
  const onOnline = () => triggerImmediateReconnect();
  const onFocus = () => triggerImmediateReconnect();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);

  // Awareness "remove" frame so peers drop this cursor immediately
  // instead of waiting for their local 30s timeout.
  const sendAwarenessRemove = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      // Remove the local state FIRST so the encoded frame is a real
      // removal (null state at the bumped clock). Encoding before
      // removing would broadcast the still-live cursor instead, and
      // onAwarenessChange is already detached here so the removal won't
      // be sent any other way.
      awarenessProtocol.removeAwarenessStates(
        awareness,
        [doc.clientID],
        "local",
      );
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
      );
      ws.send(encoding.toUint8Array(enc));
    } catch {/* socket may have raced shut */}
  };

  return {
    doc,
    awareness,
    extension,
    status: () => status,
    synced: () => synced,
    onStatusChange: (cb) => {
      statusSubscribers.add(cb);
      return () => statusSubscribers.delete(cb);
    },
    disconnect: () => {
      disposed = true;
      setStatus("disposed");
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sendAwarenessRemove();
      ws?.close();
      doc.destroy();
    },
  };
}
