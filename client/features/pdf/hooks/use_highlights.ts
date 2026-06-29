// Highlight interaction for the viewer (pdf.md PDF reader). Two cohesive
// halves over the same notes/persist context:
//   - selection -> create: a mouseup with a live selection pops the colour
//     toolbar; picking a colour persists a new highlight.
//   - act on an existing highlight: the left-click action menu, the comment
//     hover tip, and the comment / anchor edit dialogs. The click + hover
//     effects mount once and hit-test the latest notes (notesRef); the edit
//     handlers mutate the live `notes` and persist. Anchor validation is here.

import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { newUuid } from "../../../core/util";
import { ANCHOR_NAME_RE } from "../../../capabilities/markdown/index.ts";
import {
  type Color,
  type Comment as PdfComment,
  type Highlight,
  nextAutoAnchorName,
  type PdfNotes,
} from "../../../core/file";
import {
  capturePdfSelection,
  hitTestHighlight,
  type SelectionPayload,
  textInPageRect,
  toolbarAt,
  toPageFraction,
} from "../render/overlay.ts";

const ANCHOR_NAME_FULL_RE = new RegExp(`^${ANCHOR_NAME_RE.source}$`);

type Toolbar = { x: number; y: number; selection: SelectionPayload };
type ContextMenu = { x: number; y: number; highlight: Highlight };
type HoverTip = { x: number; y: number; body: string };
type CommentDraft = { highlight: Highlight; initial: string };
type AnchorDraft = { highlight: Highlight; initial: string; editing: boolean };

export function useHighlights(opts: {
  containerRef: RefObject<HTMLDivElement>;
  pdfId: string;
  notes: PdfNotes | null;
  notesRef: RefObject<PdfNotes | null>;
  persist: (next: PdfNotes) => void;
}) {
  const { containerRef, pdfId, notes, notesRef, persist } = opts;
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [hoverTip, setHoverTip] = useState<HoverTip | null>(null);
  // Themed comment / anchor input modals - window.prompt is no-oped by Electron.
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [anchorDraft, setAnchorDraft] = useState<AnchorDraft | null>(null);

  // --- selection -> create ------------------------------------------------

  // mouseup with a non-collapsed selection pops the colour picker, else
  // dismiss it. The toolbar is positioned relative to .coconote-pdf-viewer
  // (its containing block - see pdf_viewer.scss).
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onMouseUp = (e: MouseEvent) => {
      // The right button drives the rectangle highlight below, not text
      // selection - leave its toolbar alone.
      if (e.button === 2) return;
      const sel = window.getSelection();
      const payload = sel && !sel.isCollapsed ? capturePdfSelection(sel) : null;
      if (!payload) {
        setToolbar(null);
        return;
      }
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      setToolbar({ ...toolbarAt(c.parentElement!, rect.right, rect.top), selection: payload });
    };
    c.addEventListener("mouseup", onMouseUp);
    return () => c.removeEventListener("mouseup", onMouseUp);
  }, [pdfId]);

  // Right-button drag draws a rectangle that highlights an arbitrary region
  // (design.md). It feeds the SAME SelectionPayload + colour toolbar as a
  // text selection, so naming / comment / colour / persistence are shared,
  // and it works on scanned image pages with no selectable text. (The native
  // context menu is already suppressed app-wide in shell/boot.ts.)
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    type Drag = { page: HTMLElement; sx: number; sy: number; box: HTMLDivElement };
    let drag: Drag | null = null;
    // (x0,y0)-(x1,y1) from the drag start to the cursor, clamped to the page.
    // `r` is re-read each event so a mid-drag wheel scroll still tracks.
    const boxOf = (d: Drag, e: MouseEvent, r: DOMRect) => ({
      x0: Math.max(Math.min(d.sx, e.clientX), r.left),
      y0: Math.max(Math.min(d.sy, e.clientY), r.top),
      x1: Math.min(Math.max(d.sx, e.clientX), r.right),
      y1: Math.min(Math.max(d.sy, e.clientY), r.bottom),
    });
    const detach = () => {
      globalThis.removeEventListener("mousemove", onMove);
      globalThis.removeEventListener("mouseup", onUp);
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      // The right button was released outside the window (no mouseup
      // delivered): abort so the rubber band doesn't follow a button-less
      // cursor and the next click can't finalize a phantom drag.
      if ((e.buttons & 2) === 0) {
        drag.box.remove();
        drag = null;
        detach();
        return;
      }
      const r = drag.page.getBoundingClientRect();
      const { x0, y0, x1, y1 } = boxOf(drag, e, r);
      const s = drag.box.style;
      s.left = `${x0 - r.left}px`;
      s.top = `${y0 - r.top}px`;
      s.width = `${Math.max(0, x1 - x0)}px`;
      s.height = `${Math.max(0, y1 - y0)}px`;
    };
    const onUp = (e: MouseEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      detach();
      const r = d.page.getBoundingClientRect();
      const { x0, y0, x1, y1 } = boxOf(d, e, r);
      d.box.remove();
      if (x1 - x0 < 6 || y1 - y0 < 6) return setToolbar(null); // near-click
      setToolbar({
        ...toolbarAt(c.parentElement!, x1, y0),
        selection: {
          page: Number(d.page.dataset.pageNum),
          rects: [
            toPageFraction({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }, r),
          ],
          text: textInPageRect(d.page, x0, y0, x1, y1),
        },
      });
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const page = (e.target as HTMLElement)?.closest?.(
        ".coconote-pdf-page",
      ) as HTMLElement | null;
      const overlay = page?.querySelector(
        ".coconote-pdf-highlight-overlay",
      ) as HTMLElement | null;
      if (!overlay) return;
      e.preventDefault();
      const box = document.createElement("div");
      box.className = "coconote-pdf-rubberband";
      overlay.appendChild(box);
      drag = { page: page!, sx: e.clientX, sy: e.clientY, box };
      setToolbar(null);
      // Window listeners only for the duration of the drag (removed in
      // detach), so they aren't firing on every pointer event otherwise.
      globalThis.addEventListener("mousemove", onMove);
      globalThis.addEventListener("mouseup", onUp);
    };
    c.addEventListener("mousedown", onDown);
    return () => {
      c.removeEventListener("mousedown", onDown);
      detach();
    };
  }, [pdfId]);

  const addHighlight = (color: Color) => {
    if (!toolbar || !notes) return;
    const hl: Highlight = {
      id: newUuid(),
      page: toolbar.selection.page,
      rects: toolbar.selection.rects,
      color,
      text: toolbar.selection.text,
    };
    persist({ ...notes, highlights: [...notes.highlights, hl] });
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  };

  // --- act on an existing highlight ---------------------------------------

  const removeHighlight = (id: string) => {
    if (!notes) return;
    persist({
      ...notes,
      highlights: notes.highlights.filter((h) => h.id !== id),
      anchors: notes.anchors.filter((a) => a.highlightId !== id),
      comments: notes.comments.filter((c) => c.highlightId !== id),
    });
    setContextMenu(null);
  };

  const changeColor = (id: string, color: Color) => {
    if (!notes) return;
    persist({
      ...notes,
      highlights: notes.highlights.map((h) => (h.id === id ? { ...h, color } : h)),
    });
    setContextMenu(null);
  };

  // pdf.md right-click "set / rename anchor". Pre-fill the current name when
  // renaming, else the next auto name.
  const openAnchorModal = (hl: Highlight) => {
    if (!notes) return;
    const existing = notes.anchors.find((a) => a.highlightId === hl.id);
    setAnchorDraft({
      highlight: hl,
      initial: existing?.name ?? nextAutoAnchorName(notes.anchors),
      editing: !!existing,
    });
    setContextMenu(null);
  };

  const submitAnchor = (name: string) => {
    if (!notes || !anchorDraft) return;
    const hl = anchorDraft.highlight;
    const filtered = notes.anchors.filter((a) => a.highlightId !== hl.id);
    persist({ ...notes, anchors: [...filtered, { highlightId: hl.id, name }] });
    setAnchorDraft(null);
  };

  /** Returns an error message for an invalid anchor name, or null if valid. */
  const validateAnchorName = (name: string): string | null => {
    if (!name) return "Anchor name cannot be empty.";
    if (!ANCHOR_NAME_FULL_RE.test(name)) {
      return `"${name}" is not a valid anchor name (no wikilink will resolve it).`;
    }
    const collides = notes?.anchors.some(
      (a) => a.name === name && a.highlightId !== anchorDraft?.highlight.id,
    );
    if (collides) return `Anchor "${name}" is already in use.`;
    return null;
  };

  // pdf.md right-click "add / edit comment". One comment per highlightId.
  const openCommentModal = (hl: Highlight) => {
    if (!notes) return;
    const existing = notes.comments.find((c) => c.highlightId === hl.id);
    setCommentDraft({ highlight: hl, initial: existing?.body ?? "" });
    setContextMenu(null);
  };

  const submitComment = (body: string) => {
    if (!notes || !commentDraft) return;
    const hl = commentDraft.highlight;
    const trimmed = body.trim();
    const others = notes.comments.filter((c) => c.highlightId !== hl.id);
    if (trimmed === "") {
      persist({ ...notes, comments: others });
    } else {
      const c: PdfComment = { highlightId: hl.id, body: trimmed, ts: Date.now() };
      persist({ ...notes, comments: [...others, c] });
    }
    setCommentDraft(null);
  };

  // Action menu on left click (mounted once - notesRef has the latest). A
  // click ending a selection drag belongs to the toolbar and is ignored; a
  // click off any highlight closes an open menu.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onClick = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const hl = hitTestHighlight(
        notesRef.current?.highlights ?? [],
        e.clientX,
        e.clientY,
      );
      setContextMenu(hl ? { x: e.clientX, y: e.clientY, highlight: hl } : null);
    };
    c.addEventListener("click", onClick);
    return () => c.removeEventListener("click", onClick);
  }, []);

  // A highlight's comment "shown on hover" (pdf.md): the native title tooltip
  // can't work on pointer-events:none divs, so hover is the same geometric
  // hit-test painting a small fixed-position tip.
  const hoverIdRef = useRef<string | null>(null);
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onMove = (e: MouseEvent) => {
      const hl = hitTestHighlight(
        notesRef.current?.highlights ?? [],
        e.clientX,
        e.clientY,
      );
      const comment = hl
        ? notesRef.current?.comments.find((x) => x.highlightId === hl.id)
        : undefined;
      const id = comment ? hl!.id : null;
      if (id === hoverIdRef.current) return; // unchanged - no re-render
      hoverIdRef.current = id;
      setHoverTip(
        comment ? { x: e.clientX + 12, y: e.clientY + 14, body: comment.body } : null,
      );
    };
    const onLeave = () => {
      hoverIdRef.current = null;
      setHoverTip(null);
    };
    c.addEventListener("mousemove", onMove);
    c.addEventListener("mouseleave", onLeave);
    return () => {
      c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return {
    toolbar,
    addHighlight,
    contextMenu,
    hoverTip,
    commentDraft,
    anchorDraft,
    closeMenu: () => setContextMenu(null),
    removeHighlight,
    changeColor,
    openAnchorModal,
    submitAnchor,
    cancelAnchor: () => setAnchorDraft(null),
    validateAnchorName,
    openCommentModal,
    submitComment,
    cancelComment: () => setCommentDraft(null),
  };
}
