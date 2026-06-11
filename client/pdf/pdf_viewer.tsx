// PDF viewer rendered via pdf.js. Pages render lazily
// (IntersectionObserver) and release their canvas when out of range.
// Highlights, anchors, and comments live in the sidecar (notes_client.ts).
// Selection, overlay painting, and the dialogs live in sibling modules
// (pdf_text_selection / pdf_overlay / pdf_dialogs); this file is the
// orchestrator + render pipeline.

import { useEffect, useRef, useState } from "preact/hooks";
import { authedFetch } from "../lib/authed_fetch.ts";
import { encodePathSegments } from "../lib/path_url.ts";
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
  updateSidecarSession,
} from "./notes_client.ts";
import {
  capturePdfSelection,
  redrawHighlights,
  type SelectionPayload,
} from "./pdf_overlay.ts";
import { attachTextLayerSelection } from "./pdf_text_selection.ts";
import { AnchorModal, CommentModal, HighlightContextMenu } from "./pdf_dialogs.tsx";

const ANCHOR_NAME_FULL_RE = new RegExp(`^${ANCHOR_NAME_RE.source}$`);

type Props = {
  /** PDF path inside the active vault (e.g. `notes/paper.pdf`). */
  path: string;
  /** Optional anchor name to scroll to once loaded (from %-link nav). */
  initialAnchor?: string;
};

// CSS-pixel scale: page is sized at `pdfPagePt * DISPLAY_SCALE`.
// 1.5 ≈ 920 CSS px wide for a US Letter (612 pt), comfortable read size.
const DISPLAY_SCALE = 1.5;
// Render canvas at SUPERSAMPLE × (CSS pixels × devicePixelRatio).
// On Retina (dpr=2) this gives 3× the CSS pixels per axis (9× the
// pixel count) → crisper than a typical PDF reader. Cost vs plain
// dpr rendering: SUPERSAMPLE² = 2.25× the canvas memory per visible
// page; fine for the virtualised viewer (only ~3 pages live at once).
const SUPERSAMPLE = 1.5;
const SAVE_DEBOUNCE_MS = 500;
/** Render this many off-screen pages on each side of the viewport. */
const VIRTUAL_OVERSCAN = 2;
// Per-canvas pixel ceiling. A very large page (A0 poster, full-page
// scan) supersampled by dpr×SUPERSAMPLE can blow past the browser's max
// canvas size → blank/black canvas or OOM. Clamp the multiplier to stay
// under this (mirrors pdf.js bounding the output scale by
// maxCanvasPixels). Normal pages are well below it and unaffected.
const MAX_CANVAS_PIXELS = 16_777_216;
// Keep a downscaled bitmap for this many recently-released pages so
// scrolling back to them paints instantly while the full render catches
// up. Bounded so a long document can't pin every page's pixels.
const MAX_SNAPSHOTS = 8;

async function importPdfJs() {
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = ".client/pdf.worker.min.mjs";
  return lib;
}

type PageHandle = {
  wrap: HTMLDivElement;
  pageNum: number;
  // Eager fields are filled once we render the page. Until then the
  // wrap is just a placeholder of the right intrinsic size.
  rendered: boolean;
  // Downscaled bitmap of the last render, kept after release() for an
  // instant scroll-back placeholder. Null when not cached / evicted.
  snapshot: HTMLCanvasElement | null;
  render(): Promise<void>;
  release(): void;
};

export function PdfViewer({ path, initialAnchor }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<PdfNotes | null>(null);
  // Latest notes accessible from async page-mount code that can't see
  // the React state directly (the page builder runs in an IIFE inside
  // useEffect, captured at mount time).
  const notesRef = useRef<PdfNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolbar, setToolbar] = useState<
    { x: number; y: number; selection: SelectionPayload } | null
  >(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; highlight: Highlight } | null
  >(null);
  // Themed comment / anchor input modals — replace window.prompt, which
  // Electron no-ops by default.
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

  // Live sidecar session: real-time collab plus server-side persistence
  // and history (pdf.md). The callback fires on the initial sync and on
  // every remote change. Flush a pending local edit before releasing so
  // the last change reaches the doc and the server checkpoint.
  useEffect(() => {
    const { release } = openSidecarSession(path, (sc) => {
      setNotes({
        highlights: sc.highlights,
        anchors: sc.anchors,
        comments: sc.comments,
      });
    });
    return () => {
      flushNotes();
      release();
    };
  }, [path]);

  // Build page placeholders + virtualised render pipeline.
  const pagesRef = useRef<PageHandle[]>([]);
  const loadingTaskRef = useRef<{ destroy(): Promise<void> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let dprMql: MediaQueryList | null = null;
    let cleanupDpr: (() => void) | null = null;
    const c = containerRef.current;
    if (!c) return;
    c.innerHTML = "";
    pagesRef.current = [];
    (async () => {
      try {
        const pdfjs = await importPdfJs();
        const buf = await authedFetch(`/.file/${encodePathSegments(path)}`).then(
          (r) => r.arrayBuffer(),
        );
        if (cancelled) return;
        // pdf.js v6 needs all four side-band resource URLs for
        // full-fidelity rendering (matches the official viewer.html and
        // zotero/reader config). The files ship under .client/ — see
        // build/build_client.ts for what each directory provides.
        const task = pdfjs.getDocument({
          data: buf,
          cMapUrl: ".client/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: ".client/standard_fonts/",
          iccUrl: ".client/iccs/",
          wasmUrl: ".client/wasm/",
        });
        loadingTaskRef.current = task;
        const doc = await task.promise;
        if (cancelled) return;

        // Most-recently-released pages whose snapshot bitmap is retained
        // for scroll-back; front = oldest, evicted past MAX_SNAPSHOTS.
        const snapshotLRU: PageHandle[] = [];

        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: DISPLAY_SCALE });
          const wrap = document.createElement("div");
          wrap.className = "coconote-pdf-page";
          wrap.dataset.pageNum = String(n);
          // O(1) index lookup from IO callback (avoids findIndex scan).
          wrap.dataset.pageIdx = String(n - 1);
          wrap.style.width = `${viewport.width}px`;
          wrap.style.height = `${viewport.height}px`;
          // Empty overlay slot so highlight redraw can find it even
          // before the page itself paints.
          const overlay = document.createElement("div");
          overlay.className = "coconote-pdf-highlight-overlay";
          overlay.style.width = `${viewport.width}px`;
          overlay.style.height = `${viewport.height}px`;
          wrap.appendChild(overlay);
          c.appendChild(wrap);

          let detachSelection: (() => void) | null = null;
          let renderTask: { promise: Promise<void>; cancel(): void } | null = null;
          // pdf.js memoises getTextContent on the page proxy, but caching
          // the resolved value here skips the re-walk/alloc when a page
          // re-enters view on scroll-back.
          let textContent: Awaited<ReturnType<typeof page.getTextContent>> | null = null;
          let placeholder: HTMLCanvasElement | null = null;
          const handle: PageHandle = {
            wrap,
            pageNum: n,
            rendered: false,
            snapshot: null,
            async render() {
              if (handle.rendered || cancelled) return;
              handle.rendered = true;
              // Instant scroll-back: paint the cached downscaled bitmap
              // immediately while the full-res render runs.
              if (handle.snapshot) {
                placeholder = handle.snapshot;
                placeholder.style.width = `${viewport.width}px`;
                placeholder.style.height = `${viewport.height}px`;
                wrap.insertBefore(placeholder, overlay);
              }
              const canvas = document.createElement("canvas");
              // CSS size = the viewport size (logical pixels). Canvas
              // pixel buffer = CSS size × dpr × SUPERSAMPLE, clamped so a
              // huge page can't exceed the max canvas size; the browser
              // downscales it to CSS size for sharper-than-native output.
              const dpr = globalThis.devicePixelRatio || 1;
              const maxMult = Math.sqrt(
                MAX_CANVAS_PIXELS / (viewport.width * viewport.height),
              );
              const pixelMult = Math.min(dpr * SUPERSAMPLE, maxMult);
              canvas.width = Math.floor(viewport.width * pixelMult);
              canvas.height = Math.floor(viewport.height * pixelMult);
              canvas.style.width = `${viewport.width}px`;
              canvas.style.height = `${viewport.height}px`;
              // alpha:false → faster compositing + correct white backdrop
              // for opaque pages (matches pdf.js / zotero).
              const ctx = canvas.getContext("2d", { alpha: false });
              if (!ctx) {
                handle.rendered = false;
                return;
              }
              const hiResViewport = page.getViewport({
                scale: DISPLAY_SCALE * pixelMult,
              });
              renderTask = page.render({
                canvas,
                canvasContext: ctx,
                viewport: hiResViewport,
              });
              try {
                await renderTask.promise;
              } catch (e) {
                // release() cancels in-flight renders on scroll-away;
                // that rejection is expected, anything else is real.
                if (cancelled || !handle.rendered) return;
                throw e;
              } finally {
                renderTask = null;
              }
              if (cancelled || !handle.rendered) return;
              // Swap the snapshot placeholder for the real canvas in one
              // synchronous step so no frame paints both (or neither).
              if (placeholder) {
                placeholder.remove();
                placeholder = null;
              }
              wrap.insertBefore(canvas, overlay);
              const textLayerDiv = document.createElement("div");
              textLayerDiv.className = "coconote-pdf-text-layer";
              textLayerDiv.style.width = `${viewport.width}px`;
              textLayerDiv.style.height = `${viewport.height}px`;
              wrap.insertBefore(textLayerDiv, overlay);
              if (!textContent) textContent = await page.getTextContent();
              if (cancelled || !handle.rendered) {
                textLayerDiv.remove();
                return;
              }
              await new pdfjs.TextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
              }).render();
              if (cancelled || !handle.rendered) {
                textLayerDiv.remove();
                return;
              }
              detachSelection = attachTextLayerSelection(textLayerDiv);
            },
            release() {
              if (!handle.rendered) return;
              handle.rendered = false;
              // Abort an in-flight render so a fast scroll doesn't stack
              // up renders onto detached canvases.
              renderTask?.cancel();
              renderTask = null;
              detachSelection?.();
              detachSelection = null;
              placeholder = null;
              // Snapshot the rendered canvas (downscaled to CSS size) for
              // an instant placeholder on scroll-back; LRU-bounded.
              const real = wrap.querySelector(
                "canvas:not(.coconote-pdf-snapshot)",
              ) as HTMLCanvasElement | null;
              if (real && real.width > 0) {
                const snap = document.createElement("canvas");
                snap.className = "coconote-pdf-snapshot";
                snap.width = Math.round(viewport.width);
                snap.height = Math.round(viewport.height);
                const sctx = snap.getContext("2d", { alpha: false });
                if (sctx) {
                  sctx.drawImage(real, 0, 0, snap.width, snap.height);
                  handle.snapshot = snap;
                  const i = snapshotLRU.indexOf(handle);
                  if (i !== -1) snapshotLRU.splice(i, 1);
                  snapshotLRU.push(handle);
                  while (snapshotLRU.length > MAX_SNAPSHOTS) {
                    const evicted = snapshotLRU.shift();
                    if (evicted) evicted.snapshot = null;
                  }
                }
              }
              // Drop heavy canvas + textLayer; keep overlay.
              for (const child of Array.from(wrap.children)) {
                if (!child.classList.contains("coconote-pdf-highlight-overlay")) {
                  wrap.removeChild(child);
                }
              }
            },
          };
          pagesRef.current.push(handle);
        }

        // Virtualise: maintain a long-lived `visible` set of page
        // indices that ARE currently intersecting (IntersectionObserver
        // only delivers entries whose state changed, so stable-visible
        // pages aren't in every callback batch). After mutating the set,
        // render [lo, hi] and release everything else.
        const visible = new Set<number>();
        const applyVisible = () => {
          if (visible.size === 0) {
            for (const p of pagesRef.current) p.release();
            return;
          }
          let min = Infinity;
          let max = -1;
          for (const i of visible) {
            if (i < min) min = i;
            if (i > max) max = i;
          }
          const lo = Math.max(0, min - VIRTUAL_OVERSCAN);
          const hi = Math.min(pagesRef.current.length - 1, max + VIRTUAL_OVERSCAN);
          for (let i = 0; i < pagesRef.current.length; i++) {
            if (i >= lo && i <= hi) void pagesRef.current[i].render();
            else pagesRef.current[i].release();
          }
        };
        observer = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const w = e.target as HTMLDivElement;
              const idx = Number(w.dataset.pageIdx);
              if (e.isIntersecting) visible.add(idx);
              else visible.delete(idx);
            }
            applyVisible();
          },
          { root: c, rootMargin: "300px 0px" },
        );
        for (const p of pagesRef.current) observer.observe(p.wrap);

        // Re-render at the new ratio when the window moves between a
        // retina and non-retina display (otherwise already-rendered
        // pages stay soft/oversharp until scrolled out and back). A
        // resolution media query fires once when dpr leaves its current
        // value, so we re-arm after each change.
        const onDprChange = () => {
          for (const p of pagesRef.current) p.release();
          applyVisible();
          armDprWatch();
        };
        const armDprWatch = () => {
          dprMql?.removeEventListener("change", onDprChange);
          dprMql = matchMedia(`(resolution: ${globalThis.devicePixelRatio}dppx)`);
          dprMql.addEventListener("change", onDprChange);
        };
        armDprWatch();
        cleanupDpr = () => dprMql?.removeEventListener("change", onDprChange);
        // Notes may have loaded before page overlays were mounted; in
        // that case the [notes] redraw effect found 0 overlays and drew
        // nothing. Draw again now that overlays exist.
        if (notesRef.current) redrawHighlights(notesRef.current, containerRef.current);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

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
      // (its containing block — see pdf_viewer.scss position:relative),
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

    return () => {
      cancelled = true;
      c.removeEventListener("mouseup", onMouseUp);
      observer?.disconnect();
      cleanupDpr?.();
      // release() each page so its text-layer selection listeners
      // unregister (otherwise the module-level registry pins detached
      // DOM and the global selectionchange handler keeps firing).
      for (const p of pagesRef.current) p.release();
      pagesRef.current = [];
      const task = loadingTaskRef.current;
      loadingTaskRef.current = null;
      if (task) void task.destroy().catch(() => {});
    };
  }, [path]);

  // Redraw highlight overlays whenever `notes` (or the page set) changes.
  useEffect(() => {
    notesRef.current = notes;
    if (notes) redrawHighlights(notes, containerRef.current);
  }, [notes]);

  // Scroll to anchor once on first matching (path, anchor) — without
  // the guard, every notes edit reflashes the page.
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

  // pdf.md right-click "add / edit comment". One comment per highlightId;
  // opening the modal is a UI step, the persist happens in submitComment.
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
  // UNDER a highlight stays selectable (pdf.md: "selecting text pops up
  // a colour picker" — including over already-highlighted regions), so
  // both the context menu and the comment hover resolve highlights from
  // the cursor position against the stored fractional rects.
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

  // Right-click a highlight to open its action menu (set anchor / comment
  // / recolour / remove) — pdf.md §PDF reader. boot.ts's global handler
  // only preventDefaults the native menu (no stopPropagation), so this
  // delegated contextmenu listener still fires. Mounted once; notesRef
  // supplies the latest highlight set. A right-click off any highlight
  // closes an open menu.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onContextMenu = (e: MouseEvent) => {
      const hl = highlightAtPoint(e.clientX, e.clientY);
      if (!hl) {
        setContextMenu(null);
        return;
      }
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, highlight: hl });
    };
    c.addEventListener("contextmenu", onContextMenu);
    return () => c.removeEventListener("contextmenu", onContextMenu);
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
      if (id === hoverIdRef.current) return; // unchanged — no re-render
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
