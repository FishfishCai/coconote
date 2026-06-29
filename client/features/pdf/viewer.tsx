// PDF viewer orchestrator (pdf.js). A thin shell: it owns the DOM refs and
// wires the feature hooks (./hooks) to the dialog components (./dialogs).
// Highlights / anchors / comments live in the sidecar (./sidecar); the
// imperative pdf.js render pipeline and the pure DOM helpers live in
// ./render. All the logic is in the hooks - this file just renders.

import { useRef, useState } from "preact/hooks";
import type { EditorCtx } from "../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../core/ctx/space.ts";
import {
  AnchorModal,
  CommentHoverTip,
  CommentModal,
  HighlightContextMenu,
  SelectionToolbar,
} from "./dialogs.tsx";
import { useSidecarNotes } from "./hooks/use_sidecar_notes.ts";
import { usePdfPipeline } from "./hooks/use_pdf_pipeline.ts";
import { useHighlights } from "./hooks/use_highlights.ts";
import { useAnchorScroll } from "./hooks/use_anchor_scroll.ts";

type Client = EditorCtx & SpaceCtx;

type Props = {
  client: Client;
  /** The PDF file id - addresses both the rendered bytes and the sidecar
   *  (annotations), so the viewer needs no path. */
  pdfId: string;
  /** Optional anchor name to scroll to once loaded (from %-link nav). */
  initialAnchor?: string;
};

export function PdfViewer({ client, pdfId, initialAnchor }: Props) {
  // Outer wrapper, so the native-zoom-suppressing Ctrl/Cmd+wheel listener
  // covers the whole viewer, not just the scrolling page area.
  const viewerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { notes, notesRef, persist } = useSidecarNotes(
    client,
    pdfId,
    containerRef,
  );
  usePdfPipeline({
    client,
    pdfId,
    viewerRef,
    containerRef,
    getNotes: () => notesRef.current,
    onError: setError,
  });
  useAnchorScroll({ containerRef, pdfId, notes, initialAnchor });
  const {
    toolbar,
    addHighlight,
    contextMenu,
    hoverTip,
    commentDraft,
    anchorDraft,
    closeMenu,
    removeHighlight,
    changeColor,
    openAnchorModal,
    submitAnchor,
    cancelAnchor,
    validateAnchorName,
    openCommentModal,
    submitComment,
    cancelComment,
  } = useHighlights({ containerRef, pdfId, notes, notesRef, persist });

  return (
    <div class="coconote-pdf-viewer" ref={viewerRef}>
      {error && <div class="coconote-pdf-error-banner">{error}</div>}
      <div class="coconote-pdf-scroll" ref={containerRef} />
      {toolbar && (
        <SelectionToolbar x={toolbar.x} y={toolbar.y} onPick={addHighlight} />
      )}
      {hoverTip && (
        <CommentHoverTip x={hoverTip.x} y={hoverTip.y} body={hoverTip.body} />
      )}
      {contextMenu && (
        <HighlightContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasAnchor={!!notes?.anchors.some(
            (a) => a.highlightId === contextMenu.highlight.id,
          )}
          hasComment={!!notes?.comments.some(
            (c) => c.highlightId === contextMenu.highlight.id,
          )}
          onClose={closeMenu}
          onAnchor={() => openAnchorModal(contextMenu.highlight)}
          onComment={() => openCommentModal(contextMenu.highlight)}
          onColor={(c) => changeColor(contextMenu.highlight.id, c)}
          onRemove={() => removeHighlight(contextMenu.highlight.id)}
        />
      )}
      {commentDraft && (
        <CommentModal
          initial={commentDraft.initial}
          onCancel={cancelComment}
          onSubmit={submitComment}
        />
      )}
      {anchorDraft && (
        <AnchorModal
          initial={anchorDraft.initial}
          editing={anchorDraft.editing}
          validate={validateAnchorName}
          onCancel={cancelAnchor}
          onSubmit={submitAnchor}
        />
      )}
    </div>
  );
}
