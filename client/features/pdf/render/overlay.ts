// Pure DOM/notes helpers for the PDF viewer: live browser Selection ->
// page-relative highlight payload, the geometric highlight hit-test, and
// painting highlight overlays onto the rendered pages. No React - kept out
// of the viewer so they are independently testable.

import type { Highlight, PdfNotes } from "../../../core/file";

export type SelectionPayload = {
  page: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  text: string;
};

/** A viewport rect -> in-page fractional rect (0..1 from the page's top-left),
 *  the one normalization both highlight sources share so a text selection and
 *  a right-drag rectangle store coordinates the same way (redrawHighlights
 *  reverses it). */
export function toPageFraction(
  rect: { left: number; top: number; width: number; height: number },
  pageRect: DOMRect,
): { x: number; y: number; w: number; h: number } {
  return {
    x: (rect.left - pageRect.left) / pageRect.width,
    y: (rect.top - pageRect.top) / pageRect.height,
    w: rect.width / pageRect.width,
    h: rect.height / pageRect.height,
  };
}

/** Colour-toolbar anchor (top-right of a viewport rect) in coordinates
 *  relative to `wrap` - the .coconote-pdf-viewer, the toolbar's containing
 *  block (pdf_viewer.scss). Shared by the text-selection and rectangle paths. */
export function toolbarAt(
  wrap: HTMLElement,
  right: number,
  top: number,
): { x: number; y: number } {
  const w = wrap.getBoundingClientRect();
  return { x: right - w.left, y: top - w.top - 8 };
}

/**
 * Capture the current selection as a single-page highlight payload.
 * One highlight = one page, so a cross-page selection keeps only the
 * start page's rects (not page N+1 rects under page N's origin).
 */
export function capturePdfSelection(sel: Selection): SelectionPayload | null {
  const range = sel.getRangeAt(0);
  const anchorNode = range.startContainer;
  const pageEl = (anchorNode.nodeType === Node.ELEMENT_NODE
    ? (anchorNode as HTMLElement)
    : anchorNode.parentElement)?.closest(".coconote-pdf-page") as
      | HTMLElement
      | null;
  if (!pageEl) return null;
  const pageNum = Number(pageEl.dataset.pageNum);
  const pageRect = pageEl.getBoundingClientRect();
  const rects: SelectionPayload["rects"] = [];
  for (const r of range.getClientRects()) {
    // Keep only rects whose vertical centre lands on the start page -
    // drops the tail of a cross-page drag.
    const cy = (r.top + r.bottom) / 2;
    if (cy < pageRect.top || cy > pageRect.bottom) continue;
    // In-page fractions (0..1) so highlights stay correct at any render
    // scale or browser zoom (pdf.md: "in-page normalized coords").
    rects.push(toPageFraction(r, pageRect));
  }
  if (rects.length === 0) return null;
  // Clamp the TEXT to the start page too - the full multi-page string
  // would show unhighlighted text in the hover-preview card.
  const clamped = range.cloneRange();
  if (!pageEl.contains(range.endContainer)) {
    clamped.setEnd(pageEl, pageEl.childNodes.length);
  }
  return { page: pageNum, rects, text: clamped.toString().trim() };
}

/**
 * Concatenate the page's text-layer runs whose centre falls inside the
 * viewport rectangle (x0,y0)-(x1,y1). Used to snapshot the text a right-drag
 * rectangle highlight covers, the same way a text selection snapshots its
 * string. Returns "" when the page has no text layer (a scanned image page) -
 * the rectangle highlight stands on its own without a text snapshot.
 */
export function textInPageRect(
  page: HTMLElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  const layer = page.querySelector(".coconote-pdf-text-layer");
  if (!layer) return "";
  const parts: string[] = [];
  for (const span of Array.from(layer.querySelectorAll("span"))) {
    const r = span.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
      parts.push(span.textContent ?? "");
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Geometric hit-test: the highlight at a viewport point, or undefined.
 * Highlight divs are pointer-events:none so text UNDER a highlight stays
 * selectable (pdf.md: the colour picker must pop over already-highlighted
 * regions too), so the context menu and comment hover resolve highlights
 * against the stored fractional rects rather than the painted divs.
 */
export function hitTestHighlight(
  highlights: Highlight[],
  clientX: number,
  clientY: number,
): Highlight | undefined {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const wrap = el?.closest(".coconote-pdf-page") as HTMLElement | null;
  if (!wrap) return undefined;
  const r = wrap.getBoundingClientRect();
  const fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  const pageNum = Number(wrap.dataset.pageNum);
  return highlights.find((h) =>
    h.page === pageNum &&
    h.rects.some((rc) =>
      fx >= rc.x && fx <= rc.x + rc.w && fy >= rc.y && fy <= rc.y + rc.h
    )
  );
}

/**
 * Repaint every highlight overlay inside `scope`. Scoping to one viewer's
 * container keeps multiple viewers from clobbering each other. A null
 * scope (viewer not mounted yet) is a no-op.
 */
export function redrawHighlights(notes: PdfNotes, scope: HTMLElement | null) {
  if (!scope) return;
  const highlightsByPage = new Map<number, Highlight[]>();
  for (const h of notes.highlights) {
    const list = highlightsByPage.get(h.page);
    if (list) list.push(h);
    else highlightsByPage.set(h.page, [h]);
  }
  scope
    .querySelectorAll<HTMLElement>(".coconote-pdf-highlight-overlay")
    .forEach((overlay) => {
      const wrap = overlay.parentElement;
      const pageNum = wrap ? Number(wrap.dataset.pageNum) : NaN;
      overlay.innerHTML = "";
      const hs = highlightsByPage.get(pageNum);
      if (!hs || !wrap) return;
      // rects are 0..1 page fractions - scale to the page's current CSS
      // size (see capturePdfSelection).
      const pw = wrap.clientWidth;
      const ph = wrap.clientHeight;
      for (const h of hs) {
        for (const r of h.rects) {
          // Paint-only: the divs are pointer-events:none so text under a
          // highlight stays selectable. Hover comments and the context
          // menu hit-test geometrically in pdf_viewer.tsx.
          const div = document.createElement("div");
          div.className = `coconote-pdf-highlight coconote-pdf-color-${h.color}`;
          div.dataset.highlightId = h.id;
          div.style.left = `${r.x * pw}px`;
          div.style.top = `${r.y * ph}px`;
          div.style.width = `${r.w * pw}px`;
          div.style.height = `${r.h * ph}px`;
          overlay.appendChild(div);
        }
      }
    });
}
