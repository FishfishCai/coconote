// Live PDF-sidecar SESSION: realtime Yjs collab over the annotations json,
// with an HTTP read/save fallback. The data model (types + parse/serialize)
// is in core/file (pdf_sidecar); this module owns the I/O + shared state.
//
// The server seeds a Yjs room for a PDF id from its sidecar json TEXT, so the
// shared Y.Text("content") IS the serialized sidecar json (symmetric to a
// markdown body): local edits rewrite the Y.Text, remote updates re-parse it.
// The HTTP loadSidecar/saveSidecar path is the no-websocket / read-only
// fallback. The sidecar is the owning pdf's `<stem>.json` companion asset,
// read/written via `/.file?id=<pdfId>&asset=<stem>.json`.

import type { HttpSpacePrimitives } from "../../../core/transport";
import type { AttachedCollabHandle } from "../../../core/ctx/editor.ts";
import type { CollabHandle } from "../../../capabilities/collab/index.ts";
// Type-only: erased at build time, so the yjs bundle stays behind the lazy
// connectCollab() import below and out of the main chunk.
import type * as Y from "yjs";
import {
  emptySidecar,
  parseSidecar,
  type PdfSidecar,
  serializeSidecar,
  SIDECAR_ASSET,
} from "../../../core/file";

/** Load a PDF sidecar via `/.file?id=<pdfId>&asset=@sidecar`. Returns an empty
 *  sidecar when missing. HTTP fallback for the no-websocket / read-only case. */
export async function loadSidecar(
  sp: HttpSpacePrimitives,
  pdfId: string,
): Promise<PdfSidecar> {
  try {
    const { data } = await sp.readFile({ id: pdfId, asset: SIDECAR_ASSET });
    return parseSidecar(new TextDecoder().decode(data));
  } catch {
    return emptySidecar();
  }
}

/** Overwrite the sidecar via `/.file?id=<pdfId>&asset=@sidecar`. HTTP fallback
 *  for the no-websocket / read-only case. */
export async function saveSidecar(
  sp: HttpSpacePrimitives,
  pdfId: string,
  sidecar: PdfSidecar,
): Promise<void> {
  const bytes = new TextEncoder().encode(serializeSidecar(sidecar));
  await sp.writeFile({ id: pdfId, asset: SIDECAR_ASSET }, bytes);
}

// --- Live sidecar session (Yjs collab + HTTP fallback) ----------------
//
// The room's Y.Text("content") holds the serialized sidecar json. Local
// annotation / metadata edits replace the whole Y.Text with the freshly
// serialized sidecar; remote updates re-parse it back into `current` and
// broadcast to the viewer. If the websocket never delivers content (no-WS /
// read-only server) the session drops to HTTP load/save.

type SidecarListener = (s: PdfSidecar) => void;

const HTTP_SAVE_DEBOUNCE_MS = 600;
// Mirror collab/attach_to_editor.ts: if collab yields no content within this
// window it never will (no-WS / read-only) - drop to HTTP.
const COLLAB_FALLBACK_MS = 3000;
// Tag local Y.Text writes so the observer skips re-parsing our own edits
// (current is already up to date); only remote updates re-emit.
const SELF_ORIGIN = "coconote-pdf-sidecar-local";

type SidecarSession = {
  id: string;
  sp: HttpSpacePrimitives;
  current: PdfSidecar;
  listeners: Set<SidecarListener>;
  refs: number;
  closed: boolean;
  // Collab state (undefined once torn down / in HTTP mode).
  collab?: CollabHandle;
  yText?: Y.Text;
  observer?: (e: Y.YTextEvent) => void;
  unsubStatus?: () => void;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  // The handle published to the collab status dot, and the publisher (only
  // the viewer passes one - it owns client.collabHandle).
  collabAttached?: AttachedCollabHandle;
  publishCollab?: (h: AttachedCollabHandle | undefined) => void;
  // HTTP-fallback debounced save.
  httpSaveTimer?: ReturnType<typeof setTimeout>;
  httpDirty: boolean;
};

let activeSidecar: SidecarSession | null = null;

function emitSidecar(s: SidecarSession): void {
  for (const l of s.listeners) l(s.current);
}

/** Open (or join) the live session for `pdfId`'s sidecar. `onChange` fires
 *  immediately with the current state, again once collab/HTTP lands content,
 *  and on every remote update. `opts.publishCollab` (the viewer) receives the
 *  collab handle so the status dot reflects the PDF room. The session closes
 *  when the last holder releases. */
export function openSidecarSession(
  sp: HttpSpacePrimitives,
  pdfId: string,
  onChange: SidecarListener,
  opts?: { publishCollab?: (h: AttachedCollabHandle | undefined) => void },
): { release: () => void } {
  if (activeSidecar && activeSidecar.id === pdfId) {
    const s = activeSidecar;
    s.listeners.add(onChange);
    s.refs += 1;
    onChange(s.current);
    // A late joiner that wants the collab handle (and one is already live)
    // gets it now. The first opener's publisher stays the owner.
    if (opts?.publishCollab) {
      if (!s.publishCollab) s.publishCollab = opts.publishCollab;
      if (s.collabAttached) opts.publishCollab(s.collabAttached);
    }
    return { release: () => releaseSidecar(s, onChange) };
  }
  if (activeSidecar) closeSidecar(activeSidecar);
  const session: SidecarSession = {
    id: pdfId,
    sp,
    current: emptySidecar(),
    listeners: new Set([onChange]),
    refs: 1,
    closed: false,
    publishCollab: opts?.publishCollab,
    httpDirty: false,
  };
  activeSidecar = session;
  onChange(session.current);
  startCollab(session);
  return { release: () => releaseSidecar(session, onChange) };
}

function startCollab(s: SidecarSession): void {
  // Lazy import keeps yjs out of the main chunk (build splitting=true).
  import("../../../capabilities/collab/index.ts")
    .then(({ connectCollab }) => {
      if (s.closed) return;
      const handle = connectCollab(s.id);
      s.collab = handle;
      const yText = handle.doc.getText("content");
      s.yText = yText;
      const observer = (e: Y.YTextEvent) => {
        if (s.closed) return;
        // Skip our own writes - `current` is already the source of them.
        if (e.transaction.origin === SELF_ORIGIN) return;
        s.current = parseSidecar(yText.toString());
        emitSidecar(s);
      };
      s.observer = observer;
      yText.observe(observer);
      // Defensive: content already present (a very fast sync) - parse once.
      if (yText.length > 0) {
        s.current = parseSidecar(yText.toString());
        emitSidecar(s);
      }
      // Publish the handle for the collab status dot.
      const adapter: AttachedCollabHandle = {
        id: s.id,
        extension: [], // PDF has no CodeMirror editor to bind.
        disconnect: () => handle.disconnect(),
        status: () => handle.status(),
        synced: () => handle.synced(),
        onStatusChange: (cb) => handle.onStatusChange(cb),
      };
      s.collabAttached = adapter;
      s.publishCollab?.(adapter);
      // An external disconnect (navigator detaching on navigation) destroys
      // the doc - drop the dead handle so further edits fall back to HTTP.
      s.unsubStatus = handle.onStatusChange((st) => {
        if (st === "disposed") teardownCollab(s, false);
      });
      // No-WS / read-only fallback (mirrors collab/attach_to_editor.ts).
      s.fallbackTimer = setTimeout(() => {
        s.fallbackTimer = undefined;
        if (s.closed || !s.collab) return;
        if (s.collab.synced()) return; // healthy, authoritative (even empty)
        if (s.yText && s.yText.length > 0) return; // got content
        teardownCollab(s, true);
        void loadSidecar(s.sp, s.id).then((sc) => {
          if (s.closed) return;
          s.current = sc;
          emitSidecar(s);
        });
      }, COLLAB_FALLBACK_MS);
    })
    .catch(() => {
      // Module import failed - degrade to the HTTP fallback.
      if (s.closed) return;
      void loadSidecar(s.sp, s.id).then((sc) => {
        if (s.closed) return;
        s.current = sc;
        emitSidecar(s);
      });
    });
}

/** Drop the collab handle: detach the observer, clear the published dot
 *  handle, and (when self-initiated) disconnect the websocket. Idempotent. */
function teardownCollab(s: SidecarSession, selfInitiated: boolean): void {
  const handle = s.collab;
  if (!handle) return;
  s.collab = undefined;
  // Detach the status subscriber FIRST so a self-initiated disconnect does
  // not re-enter this through its own "disposed" notification.
  s.unsubStatus?.();
  s.unsubStatus = undefined;
  if (s.fallbackTimer) {
    clearTimeout(s.fallbackTimer);
    s.fallbackTimer = undefined;
  }
  if (s.observer && s.yText) {
    try {
      s.yText.unobserve(s.observer);
    } catch {/* doc may already be destroyed */}
  }
  s.observer = undefined;
  s.yText = undefined;
  if (s.collabAttached) {
    // Clear the status dot. If navigation already swapped in a new handle,
    // the viewer's publishCollab guard keeps us from clobbering it.
    s.publishCollab?.(undefined);
    s.collabAttached = undefined;
  }
  if (selfInitiated) {
    try {
      handle.disconnect();
    } catch {/* best effort */}
  }
}

function releaseSidecar(s: SidecarSession, cb: SidecarListener): void {
  s.listeners.delete(cb);
  s.refs -= 1;
  if (s.refs <= 0) closeSidecar(s);
}

function closeSidecar(s: SidecarSession): void {
  s.closed = true;
  // Flush a pending HTTP-fallback save before tearing down.
  if (s.httpSaveTimer) {
    clearTimeout(s.httpSaveTimer);
    s.httpSaveTimer = undefined;
    if (s.httpDirty) {
      void saveSidecar(s.sp, s.id, s.current).catch(() => {});
    }
  }
  // Disconnect the room - the server's last-leave flush persists its content
  // and records an edit history row.
  teardownCollab(s, true);
  if (activeSidecar === s) activeSidecar = null;
}

/** Current in-memory sidecar for `pdfId`, or null if no session. Used by the
 *  history panel to diff the live sidecar json against a snapshot. */
export function activeSidecarState(pdfId: string): PdfSidecar | null {
  return activeSidecar && activeSidecar.id === pdfId
    ? activeSidecar.current
    : null;
}

/** Mutate the live sidecar and broadcast it. In collab mode the serialized
 *  json is written into the shared Y.Text (fanned out to peers and
 *  checkpointed by the server); otherwise it falls back to a debounced HTTP
 *  write to the asset endpoint. */
export function updateSidecarSession(
  pdfId: string,
  mutate: (s: PdfSidecar) => PdfSidecar,
): void {
  const s = activeSidecar;
  if (!s || s.id !== pdfId) return;
  s.current = mutate(s.current);
  emitSidecar(s);
  // Collab path: replace the whole Y.Text with the serialized sidecar json.
  if (s.collab && s.yText && s.collab.status() !== "disposed") {
    try {
      const json = serializeSidecar(s.current);
      const yText = s.yText;
      s.collab.doc.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, json);
      }, SELF_ORIGIN);
      return;
    } catch {
      // Doc destroyed mid-write (raced an external disconnect) - fall
      // through to a best-effort HTTP save.
    }
  }
  // HTTP fallback (no websocket / read-only / collab torn down).
  scheduleHttpSave(s);
}

function scheduleHttpSave(s: SidecarSession): void {
  s.httpDirty = true;
  if (s.httpSaveTimer) clearTimeout(s.httpSaveTimer);
  s.httpSaveTimer = setTimeout(() => {
    s.httpSaveTimer = undefined;
    s.httpDirty = false;
    void saveSidecar(s.sp, s.id, s.current).catch((e) =>
      console.error(`save sidecar ${s.id}:`, e)
    );
  }, HTTP_SAVE_DEBOUNCE_MS);
}
