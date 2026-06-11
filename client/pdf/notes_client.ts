// HTTP client for PDF sidecars (`.<filename>.json` next to the PDF).
// pdf.md: the sidecar is a regular on-disk JSON file with shape
//   { metadata: {id, coconote, title, tag}, highlights, anchors, comments }
// Read/write goes through the standard `/.file/<sidecar-path>` endpoint.

import { authedFetch } from "../lib/authed_fetch.ts";
import { newPageId } from "../lib/id.ts";
import { encodePathSegments } from "../lib/path_url.ts";
import { fsEndpoint } from "../spaces/constants.ts";
import { type CollabHandle, connectCollab } from "../collab/collab_extension.ts";

export type Color = "yellow" | "green" | "blue" | "pink" | "orange";
export const HIGHLIGHT_COLORS: Color[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
];

export type Highlight = {
  id: string;
  page: number;
  /** Rects as in-page fractions (0..1) of the page box, top-left origin
   *  (pdf.md: "in-page normalized coords"). Scale/zoom-independent. */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  color: Color;
  text: string;
};

// pdf.md: { name, highlightId }. No `id` field — the highlightId
// is the join key.
export type Anchor = {
  highlightId: string;
  name: string;
};

// pdf.md: { highlightId, body, ts }. Spec uses `ts`, not
// `createdAt`; and there's no separate `id`.
export type Comment = {
  highlightId: string;
  body: string;
  ts: number;
};

export type PdfMetadata = {
  id: string;
  coconote: boolean;
  title: string;
  tag: string[];
};

export type PdfSidecar = {
  metadata: PdfMetadata;
  highlights: Highlight[];
  anchors: Anchor[];
  comments: Comment[];
};

export type PdfNotes = {
  highlights: Highlight[];
  anchors: Anchor[];
  comments: Comment[];
};

/// `path/to/paper.pdf` → `path/to/.paper.json` (file.md: `<name>` is the
/// basename without the `.pdf` extension).
export function sidecarPath(pdfPath: string): string {
  const slash = pdfPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : pdfPath.slice(0, slash + 1);
  const base = slash === -1 ? pdfPath : pdfPath.slice(slash + 1);
  const stem = base.replace(/\.pdf$/i, "");
  return `${dir}.${stem}.json`;
}

function pdfStem(pdfPath: string): string {
  const base = pdfPath.split("/").pop() ?? pdfPath;
  return base.replace(/\.pdf$/i, "");
}

const fileUrl = (path: string) => `${fsEndpoint}/${encodePathSegments(path)}`;

function emptySidecar(): PdfSidecar {
  return {
    metadata: { id: "", coconote: true, title: "", tag: [] },
    highlights: [],
    anchors: [],
    comments: [],
  };
}

/** Shape-harden a parsed sidecar. file.md sanctions hand-created
 *  sidecars ("Create `.<name>.json` externally with coconote: true"), so
 *  missing arrays / metadata fields are normal, not corruption. */
function normalizeSidecar(raw: unknown): PdfSidecar {
  if (!raw || typeof raw !== "object") return emptySidecar();
  const o = raw as {
    metadata?: Partial<PdfMetadata>;
    highlights?: unknown;
    anchors?: unknown;
    comments?: unknown;
  };
  return {
    metadata: {
      id: typeof o.metadata?.id === "string" ? o.metadata.id : "",
      coconote: o.metadata?.coconote === true,
      title: typeof o.metadata?.title === "string" ? o.metadata.title : "",
      tag: Array.isArray(o.metadata?.tag) ? o.metadata.tag : [],
    },
    highlights: Array.isArray(o.highlights)
      ? o.highlights as Highlight[]
      : [],
    anchors: Array.isArray(o.anchors) ? o.anchors as Anchor[] : [],
    comments: Array.isArray(o.comments) ? o.comments as Comment[] : [],
  };
}

async function loadSidecarRaw(
  pdfPath: string,
): Promise<{ sidecar: PdfSidecar; mtime: number }> {
  const r = await authedFetch(fileUrl(sidecarPath(pdfPath)));
  if (r.status === 404) return { sidecar: emptySidecar(), mtime: 0 };
  if (!r.ok) throw new Error(`load sidecar ${pdfPath}: ${r.status}`);
  const mtime = Number(r.headers.get("X-Last-Modified") ?? "0") || 0;
  return { sidecar: normalizeSidecar(await r.json()), mtime };
}

export async function loadSidecar(pdfPath: string): Promise<PdfSidecar> {
  return (await loadSidecarRaw(pdfPath)).sidecar;
}

export async function saveSidecar(
  pdfPath: string,
  sidecar: PdfSidecar,
): Promise<void> {
  const res = await putSidecar(pdfPath, sidecar);
  if (res === "stale") throw new Error(`save sidecar ${pdfPath}: stale write`);
}

/** PUT the sidecar; `ifUnmodifiedSince > 0` adds the optimistic-
 *  concurrency guard (server.md) and turns a 409 into "stale". */
async function putSidecar(
  pdfPath: string,
  sidecar: PdfSidecar,
  ifUnmodifiedSince = 0,
): Promise<"ok" | "stale"> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ifUnmodifiedSince > 0) {
    headers["X-If-Unmodified-Since"] = String(ifUnmodifiedSince);
  }
  const r = await authedFetch(fileUrl(sidecarPath(pdfPath)), {
    method: "PUT",
    headers,
    body: JSON.stringify(sidecar, null, 2),
  });
  if (r.status === 409) return "stale";
  if (!r.ok) throw new Error(`save sidecar ${pdfPath}: ${r.status}`);
  return "ok";
}

export async function loadNotes(pdfPath: string): Promise<PdfNotes> {
  const s = await loadSidecar(pdfPath);
  return {
    highlights: s.highlights,
    anchors: s.anchors,
    comments: s.comments,
  };
}

// Serialize sidecar read-modify-write so the viewer's debounced note
// saves and the metadata panel's save can't interleave their GET/PUT
// pairs and clobber each other's arrays.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/** Guarded read-modify-write: the PUT carries X-If-Unmodified-Since so
 *  a SECOND window/tab on the same PDF can't be clobbered (the in-tab
 *  writeChain only serializes within one tab). On 409: re-read,
 *  re-apply, retry. */
async function readModifyWrite(
  pdfPath: string,
  apply: (cur: PdfSidecar) => PdfSidecar,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sidecar, mtime } = await loadSidecarRaw(pdfPath);
    const res = await putSidecar(pdfPath, apply(sidecar), mtime);
    if (res === "ok") return;
  }
  throw new Error(`sidecar write kept conflicting: ${pdfPath}`);
}

export function saveNotes(pdfPath: string, notes: PdfNotes): Promise<void> {
  return serializeWrite(() =>
    readModifyWrite(pdfPath, (cur) => {
      // Heal sidecars the viewer creates implicitly (first highlight on
      // a PDF without one): id anchors history versions; title defaults
      // to the filename per file.md.
      const metadata = { ...cur.metadata };
      if (!metadata.id) metadata.id = newPageId();
      if (!metadata.title) metadata.title = pdfStem(pdfPath);
      return {
        metadata,
        highlights: notes.highlights,
        anchors: notes.anchors,
        comments: notes.comments,
      };
    })
  );
}

/** Rewrite only the four metadata fields, preserving the on-disk
 *  annotation arrays (reloaded fresh so a concurrent note save isn't
 *  lost). Used by the PDF metadata panel. */
export function saveMetadata(
  pdfPath: string,
  metadata: PdfMetadata,
): Promise<void> {
  return serializeWrite(() =>
    readModifyWrite(pdfPath, (cur) => ({ ...cur, metadata }))
  );
}


/** Format an auto-anchor name based on already-used names. */
export function nextAutoAnchorName(existing: Anchor[]): string {
  let n = 1;
  const taken = new Set(existing.map((a) => a.name));
  while (taken.has(`anchor-${n}`)) n++;
  return `anchor-${n}`;
}

// --- Live collaboration on the sidecar (pdf.md: same channel as md) ---
//
// The whole sidecar JSON rides one Y.Text over /.collab/<sidecar>, exactly
// like a markdown body. The server seeds it from disk, fans updates out,
// checkpoints to disk every 5s, and records history. One session is shared
// by the PDF viewer and the metadata panel via ref-counting so they edit
// the same in-memory sidecar. Concurrent structural edits merge at the text
// level (last consistent state wins), acceptable for the single-user /
// few-peer case this targets.

type SidecarListener = (s: PdfSidecar) => void;

type SidecarSession = {
  pdfPath: string;
  handle: CollabHandle;
  current: PdfSidecar;
  listeners: Set<SidecarListener>;
  refs: number;
};

let activeSidecar: SidecarSession | null = null;

function parseSidecarText(raw: string): PdfSidecar {
  if (!raw.trim()) return emptySidecar();
  try {
    return normalizeSidecar(JSON.parse(raw));
  } catch {
    return emptySidecar();
  }
}

function emitSidecar(s: SidecarSession): void {
  for (const l of s.listeners) l(s.current);
}

/** Open (or join) the collab session for `pdfPath`'s sidecar. `onChange`
 *  fires immediately with the current state and again on every remote
 *  update. Returns a release fn; the session closes when the last holder
 *  releases. */
export function openSidecarSession(
  pdfPath: string,
  onChange: SidecarListener,
): { release: () => void; handle: CollabHandle } {
  if (activeSidecar && activeSidecar.pdfPath === pdfPath) {
    const s = activeSidecar;
    s.listeners.add(onChange);
    s.refs += 1;
    onChange(s.current);
    return { release: () => releaseSidecar(s, onChange), handle: s.handle };
  }
  if (activeSidecar) closeSidecar(activeSidecar);
  const handle = connectCollab(sidecarPath(pdfPath));
  const yText = handle.doc.getText("content");
  const session: SidecarSession = {
    pdfPath,
    handle,
    current: emptySidecar(),
    listeners: new Set([onChange]),
    refs: 1,
  };
  activeSidecar = session;
  // Remote (and initial-sync) updates re-parse the JSON. Our own writes
  // carry the "local" origin and are skipped to avoid an echo loop.
  yText.observe((_e, tx) => {
    if (tx.origin === "local") return;
    session.current = parseSidecarText(yText.toString());
    emitSidecar(session);
  });
  onChange(session.current);
  return { release: () => releaseSidecar(session, onChange), handle };
}

function releaseSidecar(s: SidecarSession, cb: SidecarListener): void {
  s.listeners.delete(cb);
  s.refs -= 1;
  if (s.refs <= 0) closeSidecar(s);
}

function closeSidecar(s: SidecarSession): void {
  s.handle.disconnect();
  if (activeSidecar === s) activeSidecar = null;
}

/** Current in-memory sidecar for `pdfPath`, or null if no session. */
export function activeSidecarState(pdfPath: string): PdfSidecar | null {
  return activeSidecar && activeSidecar.pdfPath === pdfPath
    ? activeSidecar.current
    : null;
}

/** Mutate the live sidecar and broadcast it. Replaces the whole Y.Text
 *  with the new JSON under a "local" origin so the observer skips it. */
export function updateSidecarSession(
  pdfPath: string,
  mutate: (s: PdfSidecar) => PdfSidecar,
): void {
  const s = activeSidecar;
  if (!s || s.pdfPath !== pdfPath) return;
  let next = mutate(s.current);
  // Heal a freshly-created sidecar so its identity is stable: without an
  // id every checkpoint write would have the server inject a new one,
  // churning the page_id and fragmenting history. Mirrors the old
  // HTTP save path (id anchors history; title defaults to the filename).
  if (!next.metadata.id) {
    next = {
      ...next,
      metadata: {
        ...next.metadata,
        id: newPageId(),
        title: next.metadata.title || pdfStem(pdfPath),
      },
    };
  }
  s.current = next;
  const json = JSON.stringify(s.current, null, 2);
  const yText = s.handle.doc.getText("content");
  s.handle.doc.transact(() => {
    yText.delete(0, yText.length);
    yText.insert(0, json);
  }, "local");
  emitSidecar(s);
}
