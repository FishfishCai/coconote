// EditorCtx: the editor surface a plugin touches (CodeMirror view +
// compartments, current page, save/rebuild). A plugin importing only this
// declares it does not care about space or navigation.

import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { PageMeta } from "coconote/type/page";
import type { Path } from "coconote/lib/ref";

export type WidgetMeta = { height: number; block: boolean };

// Type-only re-export: erased at build time, so the yjs bundle is still
// only pulled in by the lazy collab import.
export type CollabUiStatus = import("../../collab/collab_extension.ts").CollabStatus;

/**
 * Live collab session bound to a page. `extension` lets
 * rebuildEditorState reseed the compartment instead of losing the
 * connection on every settings edit.
 */
export type AttachedCollabHandle = {
  disconnect(): void;
  path: string;
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
  currentPath(): Path;
  currentName(): string;
  currentPageMeta(): PageMeta | undefined;
  isReadOnlyMode(): boolean;
  focus(): void;
  save(immediate?: boolean): Promise<void>;
  rebuildEditorState(): void;
  reconfigureLanguage(): void;
}
