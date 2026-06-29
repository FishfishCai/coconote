// PDF sidecar DATA MODEL: the in-memory shape of the annotations json that
// lives inside a PDF's companion asset, plus the pure parse / serialize /
// normalize helpers. The sidecar holds
//   { metadata: {id, title, tags, backrefs}, highlights, names, comments }
// (the named-highlight records live under `names`). This module is pure -
// no I/O, no collab; the live session (Yjs + HTTP) is in ./session.ts.

// The `?asset=` sentinel for "this pdf's sidecar": the server resolves it to
// the pdf's real `<stem>.json` from the id alone, so every sidecar reader
// addresses it by id with no path. Mirrors SIDECAR_SENTINEL on the server
// (handlers/fs/mod.rs).
export const SIDECAR_ASSET = "@sidecar";

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

// pdf.md L249 `names`: { name, highlightId }. No `id` field - highlightId is
// the join key. Kept named `Anchor` internally (the %name link feature and
// ANCHOR_NAME validation reuse that identifier); only the stored json key and
// the user-facing labels say "name".
export type Anchor = {
  highlightId: string;
  name: string;
};

// pdf.md: { highlightId, body, ts }.
export type Comment = {
  highlightId: string;
  body: string;
  ts: number;
};

// file.md: PDF frontmatter is id / title / tags / backrefs (no refs).
export type PdfMetadata = {
  id?: string;
  title: string;
  tags: string[];
  backrefs: string[];
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

export function emptySidecar(): PdfSidecar {
  return {
    metadata: { title: "", tags: [], backrefs: [] },
    highlights: [],
    anchors: [],
    comments: [],
  };
}

/** Shape-harden a parsed sidecar. file.md sanctions hand-created
 *  sidecars, so missing arrays / metadata fields are normal, not
 *  corruption. The named-highlight records are read from `names`. */
function normalizeSidecar(raw: unknown): PdfSidecar {
  if (!raw || typeof raw !== "object") return emptySidecar();
  const o = raw as {
    metadata?: Partial<PdfMetadata>;
    highlights?: unknown;
    names?: unknown;
    comments?: unknown;
  };
  const tags = Array.isArray(o.metadata?.tags) ? o.metadata.tags : [];
  // pdf.md L249 key is `names`.
  const names = Array.isArray(o.names) ? o.names : [];
  return {
    metadata: {
      id: typeof o.metadata?.id === "string" ? o.metadata.id : undefined,
      title: typeof o.metadata?.title === "string" ? o.metadata.title : "",
      tags,
      backrefs: Array.isArray(o.metadata?.backrefs) ? o.metadata.backrefs : [],
    },
    highlights: Array.isArray(o.highlights)
      ? o.highlights as Highlight[]
      : [],
    anchors: names as Anchor[],
    comments: Array.isArray(o.comments) ? o.comments as Comment[] : [],
  };
}

/** Parse sidecar json TEXT (the Y.Text content, or an HTTP body) into the
 *  in-memory model. Empty / malformed text yields an empty sidecar. */
export function parseSidecar(text: string): PdfSidecar {
  if (!text || text.trim() === "") return emptySidecar();
  try {
    return normalizeSidecar(JSON.parse(text));
  } catch {
    return emptySidecar();
  }
}

/** Serialize the in-memory model to sidecar json TEXT. The named-highlight
 *  records are written under `names` (pdf.md L249). This is both the Y.Text
 *  room content and the HTTP-fallback body, so both write paths stay
 *  byte-identical and the history diff is coherent json-vs-json. */
export function serializeSidecar(s: PdfSidecar): string {
  return JSON.stringify(
    {
      metadata: {
        id: s.metadata.id,
        title: s.metadata.title,
        tags: s.metadata.tags,
        backrefs: s.metadata.backrefs,
      },
      highlights: s.highlights,
      names: s.anchors,
      comments: s.comments,
    },
    null,
    2,
  );
}

export function nextAutoAnchorName(existing: Anchor[]): string {
  let n = 1;
  const taken = new Set(existing.map((a) => a.name));
  while (taken.has(`anchor-${n}`)) n++;
  return `anchor-${n}`;
}
