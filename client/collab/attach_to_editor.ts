// Wire a Yjs collab session into the editor for `path`. Owns the
// y-codemirror.next invariant (yText empty->full delta at pos 0 must
// land in an empty editor or the doc duplicates on save) and the 3s
// safety net seeding from HTTP when the WebSocket never produces text.

import { history } from "@codemirror/commands";
import type { EditorCtx as Client } from "../core/ctx/editor.ts";
import { externalUpdate } from "../codemirror/editor_state.ts";

const FALLBACK_MS = 3000;

/**
 * Attach a collab session for `path`. The caller has already setState'd
 * an empty doc so the first SYNC_STEP_2 lands cleanly. If collab yields
 * no text within 3s, `fallbackText` is dispatched in and the handle torn
 * down so subsequent edits save via the regular PUT path.
 */
export function attachCollab(client: Client, path: string, fallbackText: string): void {
  const fallbackTimer = setTimeout(() => {
    if (client.currentPath() !== path) return;
    // Initial sync arrived -> session healthy, content authoritative
    // even when EMPTY. Tearing it down here would silently downgrade a
    // live session to HTTP saves.
    const h = client.collabHandle;
    if (h?.path === path && h.synced()) return;
    if (client.editorView.state.doc.length !== 0) return;
    if (h?.path === path) {
      h.disconnect();
      client.collabHandle = undefined;
      client.editorView.dispatch({
        effects: client.collabCompartment.reconfigure([]),
      });
    }
    client.editorView.dispatch({
      changes: { from: 0, to: 0, insert: fallbackText },
      annotations: [externalUpdate.of(true)],
    });
  }, FALLBACK_MS);

  import("./collab_extension.ts").then(({ connectCollab }) => {
    if (client.currentPath() !== path) {
      clearTimeout(fallbackTimer);
      return;
    }
    // Defensive: a race between setState and another dispatch could
    // leave non-empty text - re-empty so SYNC_STEP_2 lands on a blank.
    const view = client.editorView;
    if (view.state.doc.length !== 0) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        annotations: [externalUpdate.of(true)],
      });
    }
    const h = connectCollab(path);
    client.collabHandle = {
      disconnect: h.disconnect,
      path,
      extension: h.extension,
      status: h.status,
      synced: h.synced,
      onStatusChange: h.onStatusChange,
    };
    view.dispatch({
      effects: [
        client.collabCompartment.reconfigure(h.extension),
        // Yjs owns undo for the session (editor.md "Yjs-aware under
        // collab") - CodeMirror's history would let Cmd+Z revert PEERS'
        // edits since remote transactions enter it too.
        client.undoHistoryCompartment.reconfigure([]),
      ],
    });
    // The server's SyncStep2 populates yText - the y-sync observer
    // dispatches inserts into the (currently empty) editor.
  }).catch(() => {
    // Module import failed - fallbackTimer will catch this.
  });
}

/** Disconnect any current collab session and clear the editor's
 *  collab compartment. Safe to call when no session is live. */
export function detachCollab(client: Client): void {
  if (!client.collabHandle) return;
  client.collabHandle.disconnect();
  client.collabHandle = undefined;
  client.editorView.dispatch({
    effects: [
      client.collabCompartment.reconfigure([]),
      // Restore CodeMirror's own undo history outside collab.
      client.undoHistoryCompartment.reconfigure([history()]),
    ],
  });
}
