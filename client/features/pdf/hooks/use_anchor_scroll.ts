// %anchor deep-link scroll: when the viewer opens with an initialAnchor
// (from a %-link nav), scroll its highlighted page into view and flash it,
// once per (path, anchor). Without the guard every notes edit reflashes.

import { useEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";
import type { PdfNotes } from "../../../core/file";

export function useAnchorScroll(opts: {
  containerRef: RefObject<HTMLDivElement>;
  pdfId: string;
  notes: PdfNotes | null;
  initialAnchor: string | undefined;
}) {
  const { containerRef, pdfId, notes, initialAnchor } = opts;
  const anchorScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAnchor || !notes) return;
    const key = `${pdfId}#${initialAnchor}`;
    if (anchorScrolledRef.current === key) return;
    const a = notes.anchors.find((x) => x.name === initialAnchor);
    if (!a) return;
    const h = notes.highlights.find((x) => x.id === a.highlightId);
    if (!h) return;
    const wrap = containerRef.current?.querySelector(
      `.coconote-pdf-page[data-page-num="${h.page}"]`,
    ) as HTMLElement | null;
    if (wrap) {
      anchorScrolledRef.current = key;
      wrap.scrollIntoView({ behavior: "smooth", block: "start" });
      wrap.classList.add("flash");
      setTimeout(() => wrap.classList.remove("flash"), 1400);
    }
  }, [initialAnchor, notes, pdfId]);
}
