// Render-pipeline + per-reader zoom glue for the viewer: mounts the pdf.js
// pipeline (../render/page_pipeline), owns the transient zoom (Cmd/Ctrl
// +/-/0, routed here by keyboard.ts via client.pdfZoom), and suppresses the
// native Ctrl/Cmd+wheel page-zoom so a trackpad pinch never zooms the app.

import { useEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";
import type { EditorCtx } from "../../../core/ctx/editor.ts";
import type { PdfNotes } from "../../../core/file";
import { mountPdfPages, type PdfPipelineHandle } from "../render/page_pipeline.ts";

// Per-reader zoom: transient per viewer instance, clamped to [0.5, 3.0] in
// 0.1 steps. Matches the markdown reader bounds.
const PDF_ZOOM_MIN = 0.5;
const PDF_ZOOM_MAX = 3.0;
const PDF_ZOOM_STEP = 0.1;
const clampPdfZoom = (z: number) =>
  Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, z));

export function usePdfPipeline(opts: {
  client: EditorCtx;
  pdfId: string;
  viewerRef: RefObject<HTMLDivElement>;
  containerRef: RefObject<HTMLDivElement>;
  getNotes: () => PdfNotes | null;
  onError: (message: string) => void;
}) {
  const { client, pdfId, viewerRef, containerRef, getNotes, onError } = opts;
  // zoomRef lets the stable keyboard handle read the current level without
  // closing over a stale render.
  const zoomRef = useRef(1);
  const pipelineRef = useRef<PdfPipelineHandle | null>(null);

  // Virtualised render pipeline. destroy() flips its cancelled flag, so every
  // await checkpoint bails. A PDF switch remounts the viewer (keyed by id in
  // editor_ui.tsx), so zoom starts back at 100% - per-window transient.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const pipeline = mountPdfPages(c, pdfId, { getNotes, onError });
    pipelineRef.current = pipeline;
    return () => {
      pipeline.destroy();
      pipelineRef.current = null;
    };
  }, [pdfId]);

  // Apply a new zoom: capture the reading position as a scrollTop ratio,
  // resize via the pipeline, then restore the ratio against the new scroll
  // height so the same content stays in view across the resize.
  const applyZoom = (next: number) => {
    const z = clampPdfZoom(next);
    if (z === zoomRef.current) return;
    const c = containerRef.current;
    const ratio = c && c.scrollHeight > 0 ? c.scrollTop / c.scrollHeight : 0;
    zoomRef.current = z;
    pipelineRef.current?.setZoom(z);
    if (c) c.scrollTop = ratio * c.scrollHeight;
  };

  // Expose this viewer's zoom to the global keyboard handler while mounted.
  // applyZoom closes over fresh refs, so a stable handle is fine.
  useEffect(() => {
    client.pdfZoom = {
      zoomIn: () => applyZoom(zoomRef.current + PDF_ZOOM_STEP),
      zoomOut: () => applyZoom(zoomRef.current - PDF_ZOOM_STEP),
      zoomReset: () => applyZoom(1),
    };
    return () => {
      if (client.pdfZoom) client.pdfZoom = undefined;
    };
  }, [client]);

  // Ctrl/Cmd+wheel is the browser's native page-zoom gesture (and a macOS
  // trackpad pinch dispatches wheel+ctrlKey). Passive:false is required for
  // preventDefault to apply.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
    };
    v.addEventListener("wheel", onWheel, { passive: false });
    return () => v.removeEventListener("wheel", onWheel);
  }, [pdfId]);
}
