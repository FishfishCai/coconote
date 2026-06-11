// HTTP client for PDF sidecars (`.<filename>.json` next to the PDF).
// pdf.md: the sidecar is a regular on-disk JSON file with shape
//   { metadata: {id, coconote, title, tag}, highlights, anchors, comments }
// Read/write goes through the standard `/.file/<sidecar-path>` endpoint.

import { authedFetch } from "../lib/authed_fetch.ts";
import { newPageId } from "../lib/id.ts";
import { pdfSidecarPath } from "../lib/path_url.ts";
import { fileUrl } from "../spaces/constants.ts";
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

// Single sidecar-naming rule lives in lib/path_url.ts; re-exported under
// the name this module's callers already use.
export const sidecarPath = pdfSidecarPath;

function pdfStem(pdfPath: string): string {
  return (pdfPath.split("/").pop() ?? pdfPath).replace(/\.pdf$/i, "");
}

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

export async function loadSidecar(pdfPath: string): Promise<PdfSidecar> {
  const r = await authedFetch(fileUrl(sidecarPath(pdfPath)));
  if (r.status === 404) return emptySidecar();
  if (!r.ok) throw new Error(`load sidecar ${pdfPath}: ${r.status}`);
  return normalizeSidecar(await r.json());
}

/** Plain overwrite of the sidecar. Used by the include / rename paths
 *  that create or move a sidecar outside the live collab session (which
 *  owns persistence while a PDF is open). */
export async function saveSidecar(
  pdfPath: string,
  sidecar: PdfSidecar,
): Promise<void> {
  const r = await authedFetch(fileUrl(sidecarPath(pdfPath)), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sidecar, null, 2),
  });
  if (!r.ok) throw new Error(`save sidecar ${pdfPath}: ${r.status}`);
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
