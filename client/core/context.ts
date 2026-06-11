// Sub-context interfaces let plugins depend only on the surface they
// touch - Client implements ClientContext. A plugin importing only
// `EditorCtx` declares it doesn't care about space or navigation.

import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ClickEvent } from "coconote/type/client";
import type { PageMeta } from "coconote/type/page";
import type { Path, Ref } from "coconote/lib/ref";
import type { Config } from "./config.ts";
import type { Space } from "./space.ts";
import type { ContentManager } from "./content_manager.ts";
import type { MainUI } from "../components/editor_ui.tsx";
import type { OpenLocations } from "./navigator.ts";
import type { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";

export type WidgetMeta = { height: number; block: boolean };

// Type-only re-export: erased at build time, so the yjs bundle is still
// only pulled in by the lazy collab import.
export type CollabUiStatus = import("../collab/collab_extension.ts").CollabStatus;

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

export interface UICtx {
  ui: MainUI;
  setUiOption(key: string, value: unknown): void;
  /** Update the URL bar to `/.content/<view>` / `/.setting` without
   *  going through the page-resolution path (content.md / setting.md
   *  prescribe URLs for these panels). */
  navigateRoute(
    route: { kind: "content"; view: "path" | "tag" | "graph" } | {
      kind: "setting";
    },
  ): void;
}

export interface SpaceCtx {
  space: Space;
  httpSpacePrimitives: HttpSpacePrimitives;
  readonly allKnownFiles: ReadonlySet<string>;
  knownFilesLoaded: boolean;
  contentManager: ContentManager;
  reloadEditor(): Promise<void> | void;
  /** Re-fetch the local + remote page list and broadcast it through
   *  `ui.updatePageList`. Cheap (~1 HTTP round trip). Call after any
   *  mutation the content browser should reflect. */
  updatePageListCache(): Promise<void>;
}

export interface NavigationCtx {
  openLocations: OpenLocations;
  readonly onLoadRef: Ref | null;
  navigate(
    ref: Ref | null,
    replaceState?: boolean,
  ): Promise<void> | void;
  openUrl(url: string): void;
}

export interface LifecycleCtx {
  onEditorInit?: () => void;
  onPageClick?: (event: ClickEvent) => void;
  onPageSaved?: () => void;
}

export interface ConfigCtx {
  readonly config: Config;
}

export interface ClientContext
  extends EditorCtx, UICtx, SpaceCtx, NavigationCtx, LifecycleCtx, ConfigCtx {}
