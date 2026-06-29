// EditorCtx: the editor surface a plugin touches (CodeMirror view +
// compartments, current page, save/rebuild). A plugin importing only this
// declares it does not care about space or navigation.

import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { PageMeta } from "coconote/type/page";
import type { Path } from "../util";
import type { CollabStatus } from "../../capabilities/collab/index.ts";

export type WidgetMeta = { height: number; block: boolean };

// A reader's zoom controls. The markdown editor implements these on the
// Client directly. The PDF viewer registers its own handle while
// mounted (pdfZoom) so the global keyboard handler can drive whichever
// reader is active. See keyboard.ts and the per-reader zoom feature.
export type ReaderZoomHandle = {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
};

// Type-only re-export (import type above): erased at build time, so the yjs
// bundle is still only pulled in by the lazy collab import.
export type CollabUiStatus = CollabStatus;

/**
 * Live collab session bound to a page. `extension` lets
 * rebuildEditorState reseed the compartment instead of losing the
 * connection on every settings edit.
 */
export type AttachedCollabHandle = {
  disconnect(): void;
  /** The file id this session is bound to. */
  id: string;
  extension: Extension;
  status: () => CollabUiStatus;
  /** True once the initial SyncStep2 landed (content authoritative). */
  synced: () => boolean;
  onStatusChange: (cb: (s: CollabUiStatus) => void) => () => void;
};

export interface EditorCtx {
  editorView: EditorView;
  undoHistoryCompartment: Compartment;
  markdownLanguageCompartment: Compartment;
  renderModeCompartment: Compartment;
  editModeCompartment: Compartment;
  collabCompartment: Compartment;
  collabHandle?: AttachedCollabHandle;
  widgetMeta: Map<string, WidgetMeta>;
  systemReady: boolean;
  // The mounted PDF viewer's zoom controls, or undefined when no PDF is
  // open. Set/cleared by PdfViewer, called by keyboard.ts. (The markdown
  // reader's zoom is driven through the zoomIn/Out/Reset methods below,
  // which act on the Client's private mdZoom field.)
  pdfZoom?: ReaderZoomHandle;
  /** The current page's file id (the addressing identity), or "" when no
   *  page is loaded. */
  currentId(): string;
  /** The current page's on-disk path hint, or "" when unknown. */
  currentPath(): Path;
  /** The current page's display title, or "" when unknown. */
  currentTitle(): string;
  /** A human display name for the current page (title, else a basename of
   *  the path hint, else "untitled") - used as an export filename. */
  currentName(): string;
  currentPageMeta(): PageMeta | undefined;
  isReadOnlyMode(): boolean;
  focus(): void;
  save(immediate?: boolean): Promise<void>;
  rebuildEditorState(): void;
  reconfigureLanguage(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}
