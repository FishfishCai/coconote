// Imperative pdf.js render pipeline: page placeholders, lazy
// render/release around the viewport (IntersectionObserver), snapshot LRU
// for instant scroll-back, devicePixelRatio watching. Driven via
// mountPdfPages() by the viewer, which owns notes/UI state.

import { authedFetch, fileUrl } from "../../../core/transport";
import type { PdfNotes } from "../../../core/file";
import { redrawHighlights } from "./overlay.ts";
import { attachTextLayerSelection } from "./text_selection.ts";

// CSS-pixel scale. 1.5 = ~920 CSS px wide for US Letter (612 pt),
// comfortable read size.
const DISPLAY_SCALE = 1.5;
// Canvas pixel buffer = CSS px x dpr x SUPERSAMPLE. On Retina (dpr=2)
// that is 3x per axis -> crisper than a typical PDF reader. Cost:
// SUPERSAMPLE^2 = 2.25x canvas memory per visible page, fine with only
// ~3 pages live at once.
const SUPERSAMPLE = 1.5;
/** Render this many off-screen pages on each side of the viewport. */
const VIRTUAL_OVERSCAN = 2;
// Per-canvas pixel ceiling: a huge page (A0 poster, full-page scan) x
// dpr x SUPERSAMPLE can exceed the browser max canvas size -> blank/black
// canvas or OOM. Clamp the multiplier (mirrors pdf.js maxCanvasPixels).
// Normal pages are well below it.
const MAX_CANVAS_PIXELS = 16_777_216;
// Released pages keeping a downscaled bitmap for instant scroll-back
// paint. Bounded so a long document can't pin every page's pixels.
const MAX_SNAPSHOTS = 8;
// Live-zoom bounds (per-reader zoom feature), shared with the markdown
// reader's clamp in editor.ts.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

async function importPdfJs() {
  const lib = await import("pdfjs-dist");
  // ROOT-absolute (leading slash): the worker resolves resource URLs
  // relative to ITS OWN location (/.client/pdf.worker.min.mjs), so a
  // bare ".client/..." became "/.client/.client/..." in the worker and
  // 404'd to the SPA index.html - see the side-band URLs in load() below.
  lib.GlobalWorkerOptions.workerSrc = "/.client/pdf.worker.min.mjs";
  return lib;
}

type PageHandle = {
  wrap: HTMLDivElement;
  pageNum: number;
  // Until rendered, the wrap is just a placeholder of the right intrinsic size.
  rendered: boolean;
  // Downscaled last render kept after release() for instant scroll-back.
  // Null when not cached / evicted.
  snapshot: HTMLCanvasElement | null;
  render(): Promise<void>;
  release(): void;
  // Recompute viewport from the current zoom and re-apply the placeholder
  // + overlay sizes. Runs on every page (even unrendered) so the scroll
  // height stays correct after a zoom change.
  resize(): void;
};

export type PdfPipelineHooks = {
  /** Latest sidecar notes, for the overlay draw once page wraps exist. */
  getNotes(): PdfNotes | null;
  /** Surface a fatal load/render error to the UI. */
  onError(message: string): void;
};

export type PdfPipelineHandle = {
  /** Cancel all in-flight async work (every await checkpoint re-checks
   *  the shared cancelled flag), release every page, and destroy the
   *  pdf.js loading task. */
  destroy(): void;
  /** Live zoom (per-reader zoom feature). Clamps z to [0.5, 3.0], resizes
   *  every page placeholder so the scroll height is right, then re-renders
   *  the visible pages at the new scale and redraws highlights. */
  setZoom(z: number): void;
};

/** Builds page placeholders for the pdf `id` inside `container` (cleared
 *  first) and starts the virtualised render pipeline. */
export function mountPdfPages(
  container: HTMLElement,
  id: string,
  hooks: PdfPipelineHooks,
): PdfPipelineHandle {
  let cancelled = false;
  let observer: IntersectionObserver | null = null;
  let dprMql: MediaQueryList | null = null;
  let cleanupDpr: (() => void) | null = null;
  let loadingTask: { destroy(): Promise<void> } | null = null;
  let pages: PageHandle[] = [];
  // Live zoom on top of DISPLAY_SCALE (per-reader zoom feature). Starts at
  // 1 (zoom is per-window transient and resets on PDF switch). setZoom
  // mutates this, then each page's viewport recomputes at DISPLAY_SCALE*zoom.
  let zoom = 1;
  // Hoisted so setZoom (on the returned handle) can re-run it. The real
  // implementation is assigned inside the async IIFE once `pages` exist.
  let applyVisible = () => {};
  container.innerHTML = "";
  (async () => {
    try {
      const [pdfjs, buf] = await Promise.all([
        importPdfJs(),
        authedFetch(fileUrl(id)).then((r) => r.arrayBuffer()),
      ]);
      if (cancelled) return;
      // pdf.js v6 needs all four side-band resource URLs for full
      // fidelity (matches official viewer.html / zotero reader). Files
      // ship under .client/ - see build/build_client.ts.
      const task = pdfjs.getDocument({
        data: buf,
        // ROOT-absolute (leading slash). pdf.js forwards these to the WORKER,
        // which resolves them relative to its own /.client/ location; a bare
        // ".client/cmaps/" became "/.client/.client/cmaps/" and 404'd to the
        // SPA index.html, so the wasm decoders (JBIG2 / OpenJPEG / ICC) got
        // HTML and failed to compile - image-only scanned PDFs then rendered
        // a silent all-white page.
        cMapUrl: "/.client/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/.client/standard_fonts/",
        iccUrl: "/.client/iccs/",
        wasmUrl: "/.client/wasm/",
      });
      loadingTask = task;
      const doc = await task.promise;
      if (cancelled) return;

      // Pages retaining a snapshot: front = oldest, evicted past MAX_SNAPSHOTS.
      const snapshotLRU: PageHandle[] = [];

      // Fetch page proxies in parallel, then size placeholders
      // synchronously in page order.
      const pageProxies = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
      );
      if (cancelled) return;

      for (let n = 1; n <= doc.numPages; n++) {
        const page = pageProxies[n - 1];
        // Mutable: handle.resize() recomputes it from the live zoom, and
        // render() / the text layer / snapshot all derive their sizes from
        // it, so they all scale once it reflects the zoom.
        let viewport = page.getViewport({ scale: DISPLAY_SCALE * zoom });
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
        container.appendChild(wrap);

        let detachSelection: (() => void) | null = null;
        let renderTask: { promise: Promise<void>; cancel(): void } | null = null;
        // pdf.js memoises getTextContent, but caching the resolved value
        // skips the re-walk/alloc when a page re-enters view.
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
            // Paint the cached snapshot immediately while full-res renders.
            if (handle.snapshot) {
              placeholder = handle.snapshot;
              placeholder.style.width = `${viewport.width}px`;
              placeholder.style.height = `${viewport.height}px`;
              wrap.insertBefore(placeholder, overlay);
            }
            const canvas = document.createElement("canvas");
            // Canvas buffer = CSS size x dpr x SUPERSAMPLE, clamped to
            // the max canvas size. The browser downscales to CSS size
            // for sharper-than-native output.
            const dpr = globalThis.devicePixelRatio || 1;
            const maxMult = Math.sqrt(
              MAX_CANVAS_PIXELS / (viewport.width * viewport.height),
            );
            const pixelMult = Math.min(dpr * SUPERSAMPLE, maxMult);
            canvas.width = Math.floor(viewport.width * pixelMult);
            canvas.height = Math.floor(viewport.height * pixelMult);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            // alpha:false -> faster compositing + correct white backdrop
            // for opaque pages (matches pdf.js / zotero).
            const ctx = canvas.getContext("2d", { alpha: false });
            if (!ctx) {
              handle.rendered = false;
              return;
            }
            const hiResViewport = page.getViewport({
              scale: DISPLAY_SCALE * zoom * pixelMult,
            });
            renderTask = page.render({
              canvas,
              canvasContext: ctx,
              viewport: hiResViewport,
            });
            try {
              await renderTask.promise;
            } catch (e) {
              // release() cancels in-flight renders on scroll-away. That
              // rejection is expected, anything else is real (and surfaces
              // via the .catch on the render() call in applyVisible).
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
            // Snapshot the canvas (downscaled to CSS size) for an
            // instant scroll-back placeholder. LRU-bounded.
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
            // Drop heavy canvas + textLayer, keep overlay.
            for (const child of Array.from(wrap.children)) {
              if (!child.classList.contains("coconote-pdf-highlight-overlay")) {
                wrap.removeChild(child);
              }
            }
          },
          resize() {
            viewport = page.getViewport({ scale: DISPLAY_SCALE * zoom });
            wrap.style.width = `${viewport.width}px`;
            wrap.style.height = `${viewport.height}px`;
            overlay.style.width = `${viewport.width}px`;
            overlay.style.height = `${viewport.height}px`;
          },
        };
        pages.push(handle);
      }

      // Long-lived set of intersecting page indices: IntersectionObserver
      // only delivers entries whose state CHANGED, so stable-visible
      // pages aren't in every callback batch. After each mutation render
      // [lo, hi] and release everything else.
      const visible = new Set<number>();
      // Assign the hoisted outer binding so the returned handle.setZoom
      // can re-run it after a zoom change.
      applyVisible = () => {
        if (visible.size === 0) {
          for (const p of pages) p.release();
          return;
        }
        let min = Infinity;
        let max = -1;
        for (const i of visible) {
          if (i < min) min = i;
          if (i > max) max = i;
        }
        const lo = Math.max(0, min - VIRTUAL_OVERSCAN);
        const hi = Math.min(pages.length - 1, max + VIRTUAL_OVERSCAN);
        for (let i = 0; i < pages.length; i++) {
          if (i >= lo && i <= hi) {
            // Surface a real render failure instead of a silent blank page.
            void pages[i].render().catch((e) =>
              console.error(`[coconote-pdf] page ${i + 1} render failed:`, e)
            );
          } else pages[i].release();
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
        { root: container, rootMargin: "300px 0px" },
      );
      for (const p of pages) observer.observe(p.wrap);

      // Re-render when the window moves between retina and non-retina
      // displays (else rendered pages stay soft/oversharp until scrolled
      // out and back). The resolution media query fires once when dpr
      // leaves its current value, so re-arm after each change.
      const onDprChange = () => {
        for (const p of pages) p.release();
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
      // Notes may have loaded before overlays mounted (the [notes]
      // redraw effect then drew nothing). Draw again now overlays exist.
      const notes = hooks.getNotes();
      if (notes) redrawHighlights(notes, container);
    } catch (e) {
      if (!cancelled) hooks.onError(String(e));
    }
  })();

  return {
    destroy() {
      cancelled = true;
      observer?.disconnect();
      cleanupDpr?.();
      // release() each page so its text-layer selection listeners
      // unregister (otherwise the module-level registry pins detached
      // DOM and the global selectionchange handler keeps firing).
      for (const p of pages) p.release();
      pages = [];
      const task = loadingTask;
      loadingTask = null;
      if (task) void task.destroy().catch(() => {});
    },
    setZoom(z: number) {
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
      // Resize EVERY page (placeholder + overlay) so the scroll height is
      // right, then release rendered pages and re-render the visible ones
      // at the new scale.
      for (const p of pages) p.resize();
      for (const p of pages) p.release();
      applyVisible();
      // Overlay sizes changed, so redraw highlights against them.
      const notes = hooks.getNotes();
      if (notes) redrawHighlights(notes, container);
    },
  };
}
