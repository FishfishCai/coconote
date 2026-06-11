// pdfjs-dist (legacy node build) text extraction with positions, used
// by read_pdf_text and add_pdf_highlight. pdfjs item geometry:
// transform[4]/[5] is the baseline origin in BOTTOM-UP page units, the
// highlight sidecar wants page fractions 0..1 from the TOP-LEFT
// (client/pdf/notes_client.ts Highlight.rects), so y converts as
// yTop = (pageHeight - itemTop) / pageHeight.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type RawItem = { str: string; x: number; y: number; w: number; h: number; eol: boolean };

export type PdfPage = {
  page: number;
  width: number;
  height: number;
  /** Concatenated page text: item strs joined, newline on hasEOL. */
  text: string;
  /** Char span of every item inside `text`, for quote -> rect mapping. */
  spans: Array<{ start: number; end: number; item: RawItem }>;
};

export type Rect = { x: number; y: number; w: number; h: number };

export async function loadPdfPages(bytes: Uint8Array, only?: number[]): Promise<{
  numPages: number;
  pages: PdfPage[];
}> {
  // pdfjs transfers (detaches) the buffer it is handed - pass a copy so
  // callers can keep using theirs.
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  try {
    const wanted = only && only.length > 0 ? only : null;
    if (wanted) {
      const bad = wanted.filter((p) => p < 1 || p > doc.numPages);
      if (bad.length > 0) {
        throw new Error(`page(s) ${bad.join(", ")} out of range: the PDF has ${doc.numPages} page(s).`);
      }
    }
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (wanted && !wanted.includes(n)) continue;
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let text = "";
      const spans: PdfPage["spans"] = [];
      for (const it of tc.items as Array<{
        str: string;
        transform: number[];
        width: number;
        height: number;
        hasEOL?: boolean;
      }>) {
        const item: RawItem = {
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height,
          eol: it.hasEOL === true,
        };
        spans.push({ start: text.length, end: text.length + item.str.length, item });
        text += item.str;
        if (item.eol) text += "\n";
      }
      pages.push({ page: n, width: vp.width, height: vp.height, text, spans });
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

export type QuoteMatch = { page: number; text: string; rects: Rect[] };

/** Find every occurrence of `quote` (whitespace-insensitive, spanning
 *  adjacent items on one page) and compute its top-left-normalized
 *  highlight rects, one per visual line. */
export function findQuote(pages: PdfPage[], quote: string): QuoteMatch[] {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("quote is empty.");
  const re = new RegExp(
    words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
    "g",
  );
  const out: QuoteMatch[] = [];
  for (const p of pages) {
    for (const m of p.text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      out.push({ page: p.page, text: m[0].replace(/\s+/g, " "), rects: matchRects(p, start, end) });
    }
  }
  return out;
}

/** Rects for the text span [start, end) of one page: per overlapped
 *  item, trim the width proportionally to the character overlap, then
 *  merge items that share a baseline into one rect per visual line. */
function matchRects(p: PdfPage, start: number, end: number): Rect[] {
  type Piece = { x0: number; x1: number; yBase: number; h: number };
  const pieces: Piece[] = [];
  for (const { start: s, end: e, item } of p.spans) {
    if (e <= start || s >= end || item.str.length === 0) continue;
    const from = Math.max(start, s) - s;
    const to = Math.min(end, e) - s;
    if (item.str.slice(from, to).trim() === "") continue;
    const perChar = item.w / item.str.length;
    pieces.push({
      x0: item.x + perChar * from,
      x1: item.x + perChar * to,
      yBase: item.y,
      h: item.h,
    });
  }
  // Group by baseline (tolerance 2pt) - one rect per visual line.
  const lines: Piece[][] = [];
  for (const piece of pieces) {
    const line = lines.find((l) => Math.abs(l[0].yBase - piece.yBase) < 2);
    if (line) line.push(piece);
    else lines.push([piece]);
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return lines.map((line) => {
    const x0 = Math.min(...line.map((c) => c.x0));
    const x1 = Math.max(...line.map((c) => c.x1));
    const top = Math.max(...line.map((c) => c.yBase + c.h));
    const bottom = Math.min(...line.map((c) => c.yBase));
    return {
      x: clamp(x0 / p.width),
      y: clamp((p.height - top) / p.height),
      w: clamp((x1 - x0) / p.width),
      h: clamp((top - bottom) / p.height),
    };
  });
}
