// Pure export assembly shared by the client export (lib/export.ts) and
// the MCP server's export tools (mcp/src/export.ts): callout
// segmentation, the export page scaffold, woff2 inlining, and PDF
// highlight baking. No DOM and no client context in here.

import { htmlEscapeAttr } from "../../capabilities/markdown/index.ts";
import type { Color, Highlight } from "../../core/file";
import {
  findCalloutBounds,
  parseCalloutOpener,
  resolveTemplate,
} from "../../core/util";

export type Segment =
  | { kind: "md"; text: string }
  | { kind: "callout"; keyword: string; label: string | null; text: string };

/** Split a markdown body into plain segments and well-formed callouts,
 *  mirroring the editor's line-based callout scan (core/util/callout.ts).
 *  Unknown keywords and unclosed callouts stay plain markdown. */
export function splitCallouts(body: string): Segment[] {
  const lines = body.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const getLine = (n: number) =>
    n >= 1 && n <= lines.length
      ? { text: lines[n - 1], from: offsets[n - 1], to: offsets[n - 1] + lines[n - 1].length }
      : null;

  const segs: Segment[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length > 0) {
      segs.push({ kind: "md", text: plain.join("\n") });
      plain = [];
    }
  };
  for (let n = 1; n <= lines.length; n++) {
    const opener = parseCalloutOpener(lines[n - 1]);
    const bounds = opener && resolveTemplate(opener.keyword)
      ? findCalloutBounds(getLine, n)
      : null;
    if (opener && bounds) {
      flushPlain();
      segs.push({
        kind: "callout",
        keyword: opener.keyword,
        label: opener.label,
        text: lines.slice(n, bounds.closerLineNo - 1).join("\n"),
      });
      n = bounds.closerLineNo;
    } else {
      plain.push(lines[n - 1]);
    }
  }
  flushPlain();
  return segs;
}

/** Render the page body to HTML: markdown through `renderMd`, callouts
 *  wrapped in their normal head / body / suffix structure with one
 *  document-wide counter for numbered templates. */
export function renderExportBody(
  body: string,
  renderMd: (text: string) => string,
): string {
  let counter = 0;
  const parts: string[] = [];
  for (const seg of splitCallouts(body)) {
    if (seg.kind === "md") {
      parts.push(renderMd(seg.text));
      continue;
    }
    const t = resolveTemplate(seg.keyword)!;
    const number = t.numbered ? ++counter : null;
    const base = number != null ? `${t.title} ${number}` : t.title ?? seg.keyword;
    const head = seg.label
      ? `${base} (${seg.label})${number != null ? "." : ""}`
      : number != null
      ? `${base}.`
      : base;
    const bodyClass = "coconote-callout-body" +
      (t.italic ? " coconote-callout-italic" : "");
    const suffix = t.suffix
      ? `<span class="coconote-callout-suffix coconote-callout-${t.cssClass}-suffix">${
        htmlEscapeAttr(t.suffix.trim())
      }</span>`
      : "";
    parts.push(
      `<section class="coconote-export-callout coconote-callout-${t.cssClass}">` +
        `<div class="coconote-callout-head">${htmlEscapeAttr(head)}</div>` +
        `<div class="${bodyClass}">${renderMd(seg.text)}${suffix}</div>` +
        `</section>`,
    );
  }
  return parts.join("\n");
}

/** Heading text -> in-page anchor id, for `[[#heading]]` fragments. */
export function slugify(s: string): string {
  return s.trim().replace(/\s+/g, "-");
}

/** Inline every `url(...woff2)` in `css` via `loadFont` (data URI or
 *  null to keep the original reference). Fonts load in parallel. */
export async function inlineWoff2(
  css: string,
  loadFont: (ref: string) => Promise<string | null>,
): Promise<string> {
  const urlRe = /url\(["']?([^)"']+\.woff2)["']?\)/g;
  const refs = [...new Set([...css.matchAll(urlRe)].map((m) => m[1]))];
  const fonts = new Map<string, string>();
  await Promise.all(refs.map(async (ref) => {
    const data = await loadFont(ref);
    if (data) fonts.set(ref, data);
  }));
  return css.replace(urlRe, (full, ref) => {
    const data = fonts.get(ref);
    return data ? `url(${data})` : full;
  });
}

// Export page layout: a centered light-theme article reusing the app's
// prose look (.coconote-hover-preview-content styles plain rendered
// HTML, the editor's own prose rules are CM-line scoped).
const EXPORT_CSS = `
html, body { height: auto; width: auto; overflow: visible; }
body {
  background: var(--background-primary);
  color: var(--text-normal);
  font-family: var(--font-text);
  font-size: var(--editor-font-size);
  line-height: 1.55;
}
.coconote-export-page { max-width: var(--editor-width); margin: 0 auto; padding: 2.5rem 1.5rem; }
.coconote-export-page img { max-width: 100%; }
.coconote-export-page span.wiki-link { color: var(--text-accent); }
.coconote-export-callout {
  border: 1px solid var(--background-modifier-border-hover);
  border-radius: 6px;
  padding: 0.4em 1.4rem;
  margin: 0.8em 0;
  font-family: "STIXTwoText", "Latin Modern Roman", Cambria, Georgia, "Times New Roman", serif;
}
.coconote-export-callout .coconote-callout-head { font-weight: 700; }
.coconote-export-callout .coconote-callout-italic { font-style: italic; }
.coconote-export-callout.coconote-callout-proof { border: 0; border-radius: 0; padding: 0; }
.coconote-export-callout.coconote-callout-proof .coconote-callout-body { padding-left: 2em; }
@page { margin: 18mm 16mm; }
@media print { .coconote-export-page { padding: 0; max-width: none; } }
`;

/** The full self-contained export document around an already
 *  post-processed body (light theme, app CSS + export layout inline). */
export function exportDocumentHtml(
  title: string,
  css: string,
  bodyHtml: string,
): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscapeAttr(title)}</title>
<style>${css}</style>
<style>${EXPORT_CSS}</style>
</head>
<body>
<article class="coconote-export-page coconote-hover-preview-content">
${bodyHtml}
</article>
</body>
</html>
`;
}

// pdf_viewer.scss five-colour palette, as 0..1 RGB for pdf-lib.
const HIGHLIGHT_RGB: Record<Color, [number, number, number]> = {
  yellow: [1, 0.945, 0.463],
  green: [0.682, 0.835, 0.506],
  blue: [0.506, 0.831, 0.98],
  pink: [0.973, 0.733, 0.816],
  orange: [1, 0.8, 0.502],
};

/** A copy of `pdfData` with the sidecar's annotations baked in (pdf.md L256
 *  "export with highlights and 批注", where 批注 = highlights + comments +
 *  names, L90): highlight colour rects, the highlight's name as a small
 *  label above it, and the comment as a pdf text/note annotation by it. A
 *  missing or malformed sidecar yields the PDF unchanged. */
export async function bakeHighlights(
  pdfData: Uint8Array,
  sidecarJson: string | null,
): Promise<Uint8Array> {
  let highlights: Highlight[] = [];
  let comments: Array<{ highlightId?: unknown; body?: unknown }> = [];
  let names: Array<{ highlightId?: unknown; name?: unknown }> = [];
  if (sidecarJson) {
    try {
      const parsed = JSON.parse(sidecarJson);
      if (Array.isArray(parsed?.highlights)) highlights = parsed.highlights;
      if (Array.isArray(parsed?.comments)) comments = parsed.comments;
      // pdf.md L249 key is `names`.
      names = Array.isArray(parsed?.names) ? parsed.names : [];
    } catch {
      // Malformed sidecar: export the PDF without annotations.
    }
  }
  const { PDFDocument, PDFHexString, rgb, StandardFonts } = await import(
    "pdf-lib"
  );
  const doc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const pages = doc.getPages();

  const commentByHl = new Map<string, string>();
  for (const c of comments) {
    if (typeof c?.highlightId === "string" && typeof c?.body === "string") {
      commentByHl.set(c.highlightId, c.body);
    }
  }
  const nameByHl = new Map<string, string>();
  for (const n of names) {
    if (typeof n?.highlightId === "string" && typeof n?.name === "string") {
      nameByHl.set(n.highlightId, n.name);
    }
  }
  // A standard (non-embedded) font for the name labels, embedded only when
  // at least one highlight is named.
  const labelFont = nameByHl.size > 0
    ? await doc.embedFont(StandardFonts.Helvetica)
    : null;

  for (const h of highlights) {
    const page = pages[h.page - 1];
    if (!page || !Array.isArray(h.rects)) continue;
    const { width, height } = page.getSize();
    const [r, g, b] = HIGHLIGHT_RGB[h.color] ?? HIGHLIGHT_RGB.yellow;
    // Sidecar rects are page fractions with a top-left origin (pdf.md),
    // pdf-lib's origin is bottom-left: flip y.
    for (const rect of h.rects) {
      page.drawRectangle({
        x: rect.x * width,
        y: height * (1 - rect.y - rect.h),
        width: rect.w * width,
        height: rect.h * height,
        color: rgb(r, g, b),
        opacity: 0.35,
      });
    }
    // Anchor the name label and comment note to the highlight's first rect.
    const first = h.rects[0];
    if (!first) continue;
    const leftX = first.x * width;
    const topY = height * (1 - first.y);
    const rightX = (first.x + first.w) * width;

    const name = labelFont ? nameByHl.get(h.id) : undefined;
    if (name && labelFont) {
      try {
        page.drawText(name, {
          x: leftX,
          y: Math.min(topY + 1, height - 8),
          size: 7,
          font: labelFont,
          color: rgb(0.15, 0.15, 0.15),
        });
      } catch {
        // Unencodable label (outside WinAnsi) - skip just this label.
      }
    }
    const body = commentByHl.get(h.id);
    if (body) {
      // A Text (sticky-note) annotation holds the full comment, shown on
      // hover/click in pdf readers - no glyph encoding or wrapping needed.
      const nx = Math.min(rightX, width - 18);
      const ny = Math.min(topY, height - 18);
      const annot = doc.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Name: "Comment",
        Rect: [nx, ny, nx + 18, ny + 18],
        Contents: PDFHexString.fromText(body),
        Open: false,
        C: [1, 0.85, 0.3],
      });
      page.node.addAnnot(doc.context.register(annot));
    }
  }
  return await doc.save();
}
