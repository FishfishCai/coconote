// Imperative pdf.js render pipeline: page placeholders, lazy
// render/release around the viewport (IntersectionObserver), snapshot LRU
// for instant scroll-back, devicePixelRatio watching. Driven via
// mountPdfPages() by pdf_viewer.tsx, which owns notes/UI state.

import { authedFetch } from "../lib/authed_fetch.ts";
import { fileUrl } from "../spaces/constants.ts";
import type { PdfNotes } from "./notes_client.ts";
import { redrawHighlights } from "./pdf_overlay.ts";
import { attachTextLayerSelection } from "./pdf_text_selection.ts";

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

async function importPdfJs() {
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = ".client/pdf.worker.min.mjs";
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
};

/** Builds page placeholders for `path` inside `container` (cleared
 *  first) and starts the virtualised render pipeline. */
export function mountPdfPages(
  container: HTMLElement,
  path: string,
  hooks: PdfPipelineHooks,
): PdfPipelineHandle {
  let cancelled = false;
  let observer: IntersectionObserver | null = null;
  let dprMql: MediaQueryList | null = null;
  let cleanupDpr: (() => void) | null = null;
  let loadingTask: { destroy(): Promise<void> } | null = null;
  let pages: PageHandle[] = [];
  container.innerHTML = "";
  (async () => {
    try {
      const [pdfjs, buf] = await Promise.all([
        importPdfJs(),
        authedFetch(fileUrl(path)).then((r) => r.arrayBuffer()),
      ]);
      if (cancelled) return;
      // pdf.js v6 needs all four side-band resource URLs for full
      // fidelity (matches official viewer.html / zotero reader). Files
      // ship under .client/ - see build/build_client.ts.
      const task = pdfjs.getDocument({
        data: buf,
        cMapUrl: ".client/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: ".client/standard_fonts/",
        iccUrl: ".client/iccs/",
        wasmUrl: ".client/wasm/",
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
              // release() cancels in-flight renders on scroll-away. That
              // rejection is expected, anything else is real.
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
        };
        pages.push(handle);
      }

      // Long-lived set of intersecting page indices: IntersectionObserver
      // only delivers entries whose state CHANGED, so stable-visible
      // pages aren't in every callback batch. After each mutation render
      // [lo, hi] and release everything else.
      const visible = new Set<number>();
      const applyVisible = () => {
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
          if (i >= lo && i <= hi) void pages[i].render();
          else pages[i].release();
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
  };
}
