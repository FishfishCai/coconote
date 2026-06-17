// EditorService: the editor session - owns the CodeMirror view, the
// reconfigurable compartments, the live collab handle, and the widget-height
// cache, plus the current-page/save/rebuild operations. Reaches the other
// services through the Client composition root for cross-domain needs (ui,
// config, nav.onLoadRef, vault.contentManager).

import type { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getNameFromPath, type Path } from "coconote/lib/ref";
import type { PageMeta } from "coconote/type/page";
import {
  rebuildEditorState as rebuildEditorStateFn,
  reconfigureLanguage as reconfigureLanguageFn,
} from "../../codemirror/editor_state.ts";
import type { AttachedCollabHandle, EditorCtx, WidgetMeta } from "../ctx/editor.ts";
import type { Client } from "../client.ts";

export class EditorService implements EditorCtx {
  editorView!: EditorView;
  undoHistoryCompartment!: Compartment;
  markdownLanguageCompartment!: Compartment;
  renderModeCompartment!: Compartment;
  editModeCompartment!: Compartment;
  collabCompartment!: Compartment;
  // Live collab session - kept so loadPage can disconnect before the
  // doc swap AND rebuildEditorState can reseed the compartment with
  // the same yCollab extension instead of dropping it.
  collabHandle?: AttachedCollabHandle;
  // Seeds CM's heightMap via WidgetType.estimatedHeight before async measure.
  widgetMeta = new Map<string, WidgetMeta>();
  systemReady = false;

  constructor(private client: Client) {}

  currentPath(): Path {
    return (this.client.ui.viewState.current?.path ?? this.client.nav.onLoadRef?.path ??
      "") as Path;
  }

  currentName(): string {
    const p = this.client.ui.viewState.current?.path ?? this.client.nav.onLoadRef?.path;
    return p ? getNameFromPath(p) : "";
  }

  currentPageMeta(): PageMeta | undefined {
    return this.client.ui.viewState.current?.meta;
  }

  isReadOnlyMode(): boolean {
    return this.client.config.get<boolean>(["_boot", "readOnly"], false) ||
      this.currentPageMeta()?.perm === "ro";
  }

  focus() {
    const vs = this.client.ui.viewState;
    if (vs.showConfirm || vs.showPrompt) return;
    this.editorView.focus();
  }

  save(immediate = false): Promise<void> {
    return this.client.vault.contentManager.save(immediate);
  }

  rebuildEditorState() {
    rebuildEditorStateFn(this.client);
  }

  reconfigureLanguage() {
    reconfigureLanguageFn(this.client);
  }
}
