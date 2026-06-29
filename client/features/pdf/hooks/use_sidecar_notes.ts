// Sidecar-session glue for the viewer: holds the in-memory PdfNotes, joins
// the live sidecar session (./sidecar/session), repaints overlays on change,
// and debounces local edits into one write. publishCollab wires the room's
// handle into the collab status dot; pending edits flush before release.

import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import type { AttachedCollabHandle, EditorCtx } from "../../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../../core/ctx/space.ts";
import type { PdfNotes } from "../../../core/file";
import { openSidecarSession, updateSidecarSession } from "../sidecar/session.ts";
import { redrawHighlights } from "../render/overlay.ts";

type Client = EditorCtx & SpaceCtx;

const SAVE_DEBOUNCE_MS = 500;

export function useSidecarNotes(
  client: Client,
  pdfId: string,
  containerRef: RefObject<HTMLDivElement>,
) {
  const [notes, setNotes] = useState<PdfNotes | null>(null);
  // Latest notes for async page-mount code (the IIFE in mountPdfPages).
  const notesRef = useRef<PdfNotes | null>(null);

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
    if (pending) updateSidecarSession(pdfId, (s) => ({ ...s, ...pending }));
  };
  const persist = (next: PdfNotes) => {
    setNotes(next);
    pendingNotesRef.current = next;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = self.setTimeout(flushNotes, SAVE_DEBOUNCE_MS);
  };

  useEffect(() => {
    let myHandle: AttachedCollabHandle | undefined;
    const { release } = openSidecarSession(
      client.httpSpacePrimitives,
      pdfId,
      (sc) => {
        setNotes({
          highlights: sc.highlights,
          anchors: sc.anchors,
          comments: sc.comments,
        });
      },
      {
        publishCollab: (h) => {
          myHandle = h;
          client.collabHandle = h;
        },
      },
    );
    return () => {
      flushNotes();
      release();
      // Only clear if we still own it - navigation may have already detached
      // this handle and attached the destination page's.
      if (myHandle && client.collabHandle === myHandle) {
        client.collabHandle = undefined;
      }
    };
  }, [pdfId]);

  useEffect(() => {
    notesRef.current = notes;
    if (notes) redrawHighlights(notes, containerRef.current);
  }, [notes]);

  return { notes, notesRef, persist };
}
