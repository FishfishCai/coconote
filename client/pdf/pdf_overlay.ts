// Pure DOM/notes helpers for the PDF viewer: turning a live browser
// Selection into a page-relative highlight payload, and painting the
// highlight overlays back onto the rendered pages. No React — kept
// separate from pdf_viewer.tsx so they're independently testable.

import type { Highlight, PdfNotes } from "./notes_client.ts";

export type SelectionPayload = {
  page: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  text: string;
};

/**
 * Capture the current selection as a single-page highlight payload.
 * The highlight model is one highlight = one page, so when a selection
 * crosses a page boundary we keep only the rects on the start page
 * (rather than silently storing page N+1 rects under page N's origin).
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
    // Keep only rects whose vertical centre lands on the start page —
    // drops the tail of a cross-page drag.
    const cy = (r.top + r.bottom) / 2;
    if (cy < pageRect.top || cy > pageRect.bottom) continue;
    // Store as in-page fractions (0..1) so highlights stay correct at any
    // render scale or browser zoom (pdf.md: "in-page normalized coords").
    rects.push({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    });
  }
  if (rects.length === 0) return null;
  // Clamp the TEXT to the start page too — rects already dropped the
  // cross-page tail, and storing the full multi-page string would show
  // unhighlighted text in the hover-preview card.
  const clamped = range.cloneRange();
  if (!pageEl.contains(range.endContainer)) {
    clamped.setEnd(pageEl, pageEl.childNodes.length);
  }
  return { page: pageNum, rects, text: clamped.toString().trim() };
}

/**
 * Repaint every highlight overlay inside `scope`. Scoped to one viewer's
 * container so multiple viewers don't clobber each other's overlays; a
 * null scope (viewer not mounted yet) is a no-op.
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
      // rects are 0..1 fractions of the page; scale to the page's current
      // CSS size (see capturePdfSelection).
      const pw = wrap.clientWidth;
      const ph = wrap.clientHeight;
      for (const h of hs) {
        for (const r of h.rects) {
          // Paint-only: the divs are pointer-events:none so text under a
          // highlight stays selectable; hover comments and the context
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
