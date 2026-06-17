// PDF viewer orchestrator (pdf.js). Highlights / anchors / comments live
// in the sidecar (notes_client.ts). Selection, overlay painting, dialogs,
// and the imperative render pipeline live in the pdf_* sibling modules.

import { useEffect, useRef, useState } from "preact/hooks";
import type { EditorCtx as Client } from "../core/ctx/editor.ts";
import { ANCHOR_NAME_RE } from "../markdown/parser/constants.ts";
import { newUuid } from "../lib/uuid.ts";
import {
  type Color,
  type Comment as PdfComment,
  type Highlight,
  HIGHLIGHT_COLORS,
  nextAutoAnchorName,
  openSidecarSession,
  type PdfNotes,
  sidecarPath,
  updateSidecarSession,
} from "./notes_client.ts";
import {
  capturePdfSelection,
  redrawHighlights,
  type SelectionPayload,
} from "./pdf_overlay.ts";
import { mountPdfPages } from "./pdf_page_pipeline.ts";
import { AnchorModal, CommentModal, HighlightContextMenu } from "./pdf_dialogs.tsx";

const ANCHOR_NAME_FULL_RE = new RegExp(`^${ANCHOR_NAME_RE.source}$`);

type Props = {
  client: Client;
  /** PDF path inside the active vault (e.g. `notes/paper.pdf`). */
  path: string;
  /** Optional anchor name to scroll to once loaded (from %-link nav). */
  initialAnchor?: string;
};

const SAVE_DEBOUNCE_MS = 500;

export function PdfViewer({ client, path, initialAnchor }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<PdfNotes | null>(null);
  // Latest notes for async page-mount code that captured state at mount
  // time (the page-builder IIFE inside mountPdfPages).
  const notesRef = useRef<PdfNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolbar, setToolbar] = useState<
    { x: number; y: number; selection: SelectionPayload } | null
  >(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; highlight: Highlight } | null
  >(null);
  // Themed comment / anchor input modals - window.prompt is no-oped by
  // Electron.
  const [commentDraft, setCommentDraft] = useState<
    { highlight: Highlight; initial: string } | null
  >(null);
  const [anchorDraft, setAnchorDraft] = useState<
    { highlight: Highlight; initial: string; editing: boolean } | null
  >(null);

  // Debounce a rapid burst (colour cycling, bulk delete) into one write.
  const saveTimerRef = useRef<number | null>(null);
  const pendingNotesRef = useRef<PdfNotes | null>(null);
  const flushNotes = () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingNotesRef.current;
    pendingNotesRef.current = null;
    if (pending) updateSidecarSession(path, (s) => ({ ...s, ...pending }));
  };
  const persist = (next: PdfNotes) => {
    setNotes(next);
    pendingNotesRef.current = next;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = self.setTimeout(flushNotes, SAVE_DEBOUNCE_MS);
  };

  // Live sidecar session (pdf.md): collab + server-side persistence and
  // history. The callback fires on initial sync and every remote change.
  // Flush pending local edits before releasing so the last change
  // reaches the doc and the server checkpoint.
  useEffect(() => {
    const { release, handle } = openSidecarSession(path, (sc) => {
      setNotes({
        highlights: sc.highlights,
        anchors: sc.anchors,
        comments: sc.comments,
      });
    });
    // Drive the shared top-right status dot, like the markdown editor.
    // disconnect is a no-op: the session's own ref-counted release()
    // owns teardown, so navigator's detach only clears the dot.
    const scPath = sidecarPath(path);
    client.collabHandle = {
      path: scPath,
      extension: [],
      disconnect: () => {},
      status: handle.status,
      synced: handle.synced,
      onStatusChange: handle.onStatusChange,
    };
    return () => {
      flushNotes();
      release();
      if (client.collabHandle?.path === scPath) {
        client.collabHandle = undefined;
      }
    };
  }, [path]);

  // Virtualised render pipeline (pdf_page_pipeline.ts). destroy() flips
  // its cancelled flag, so every await checkpoint bails.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const pipeline = mountPdfPages(c, path, {
      getNotes: () => notesRef.current,
      onError: setError,
    });
    return () => pipeline.destroy();
  }, [path]);

  // Selection toolbar: mouseup with a non-collapsed selection pops the
  // colour picker (pdf.md), otherwise dismiss it.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setToolbar(null);
        return;
      }
      const payload = capturePdfSelection(sel);
      if (!payload) {
        setToolbar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      // Toolbar is absolutely positioned inside .coconote-pdf-viewer
      // (its containing block - see pdf_viewer.scss position:relative),
      // so coordinates must be relative to THAT element, not the window.
      const wrapRect = c.parentElement?.getBoundingClientRect();
      const baseX = wrapRect?.left ?? 0;
      const baseY = wrapRect?.top ?? 0;
      setToolbar({
        x: rect.right - baseX,
        y: rect.top - baseY - 8,
        selection: payload,
      });
    };
    c.addEventListener("mouseup", onMouseUp);
    return () => c.removeEventListener("mouseup", onMouseUp);
  }, [path]);

  useEffect(() => {
    notesRef.current = notes;
    if (notes) redrawHighlights(notes, containerRef.current);
  }, [notes]);

  // Scroll to anchor once per (path, anchor) - without the guard every
  // notes edit reflashes the page.
  const anchorScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAnchor || !notes) return;
    const key = `${path}#${initialAnchor}`;
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
  }, [initialAnchor, notes, path]);

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
      highlights: notes.highlights.map((h) =>
        h.id === id ? { ...h, color } : h
      ),
    });
    setContextMenu(null);
  };

  // pdf.md right-click "set / rename anchor". Pre-fill with the current
  // name when renaming, else the next auto name.
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

  // Geometric hit-test: highlight divs are pointer-events:none so text
  // UNDER a highlight stays selectable (pdf.md: the colour picker must
  // pop over already-highlighted regions too). Context menu and comment
  // hover both resolve highlights against the stored fractional rects.
  const highlightAtPoint = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY) as
      | HTMLElement
      | null;
    const wrap = el?.closest(".coconote-pdf-page") as HTMLElement | null;
    if (!wrap) return undefined;
    const r = wrap.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - r.top) / r.height;
    const pageNum = Number(wrap.dataset.pageNum);
    return notesRef.current?.highlights.find((h) =>
      h.page === pageNum &&
      h.rects.some((rc) =>
        fx >= rc.x && fx <= rc.x + rc.w && fy >= rc.y && fy <= rc.y + rc.h
      )
    );
  };

  // Highlight action menu on left click (pdf.md PDF reader). Mounted
  // once - notesRef supplies the latest highlights. A click that ends a
  // text-selection drag is ignored (that gesture belongs to the colour
  // toolbar), and a click off any highlight closes an open menu.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onClick = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const hl = highlightAtPoint(e.clientX, e.clientY);
      if (!hl) {
        setContextMenu(null);
        return;
      }
      setContextMenu({ x: e.clientX, y: e.clientY, highlight: hl });
    };
    c.addEventListener("click", onClick);
    return () => c.removeEventListener("click", onClick);
  }, []);

  // pdf.md: a highlight's comment is "shown on hover". The native title
  // tooltip can't work on pointer-events:none divs, so hover is the same
  // geometric hit-test painting a small fixed-position tip.
  const [hoverTip, setHoverTip] = useState<
    { x: number; y: number; body: string } | null
  >(null);
  const hoverIdRef = useRef<string | null>(null);
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onMove = (e: MouseEvent) => {
      const hl = highlightAtPoint(e.clientX, e.clientY);
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

  return (
    <div class="coconote-pdf-viewer">
      {error && <div class="coconote-pdf-error-banner">{error}</div>}
      <div class="coconote-pdf-scroll" ref={containerRef} />
      {toolbar && (
        <div
          class="coconote-pdf-toolbar"
          style={{ left: `${toolbar.x}px`, top: `${toolbar.y}px` }}
        >
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              class={`coconote-pdf-color-btn coconote-pdf-color-${c}`}
              onClick={() => addHighlight(c)}
              title={c}
            />
          ))}
        </div>
      )}
      {hoverTip && (
        <div
          class="coconote-pdf-comment-tip"
          style={{ left: `${hoverTip.x}px`, top: `${hoverTip.y}px` }}
        >
          {hoverTip.body}
        </div>
      )}
      {contextMenu && (
        <HighlightContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasComment={!!notes?.comments.some(
            (c) => c.highlightId === contextMenu.highlight.id,
          )}
          onClose={() => setContextMenu(null)}
          onAnchor={() => openAnchorModal(contextMenu.highlight)}
          hasAnchor={!!notes?.anchors.some(
            (a) => a.highlightId === contextMenu.highlight.id,
          )}
          onComment={() => openCommentModal(contextMenu.highlight)}
          onColor={(c) => changeColor(contextMenu.highlight.id, c)}
          onRemove={() => removeHighlight(contextMenu.highlight.id)}
        />
      )}
      {commentDraft && (
        <CommentModal
          initial={commentDraft.initial}
          onCancel={() => setCommentDraft(null)}
          onSubmit={submitComment}
        />
      )}
      {anchorDraft && (
        <AnchorModal
          initial={anchorDraft.initial}
          editing={anchorDraft.editing}
          validate={(name) => {
            if (!name) return "Anchor name cannot be empty.";
            if (!ANCHOR_NAME_FULL_RE.test(name)) {
              return `"${name}" is not a valid anchor name (no wikilink will resolve it).`;
            }
            const collides = notes?.anchors.some(
              (a) => a.name === name && a.highlightId !== anchorDraft.highlight.id,
            );
            if (collides) return `Anchor "${name}" is already in use.`;
            return null;
          }}
          onCancel={() => setAnchorDraft(null)}
          onSubmit={submitAnchor}
        />
      )}
    </div>
  );
}
