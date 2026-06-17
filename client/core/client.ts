import { history } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Ref } from "coconote/lib/ref";
import type { ClickEvent } from "coconote/type/client";
import { createEditorState } from "../codemirror/editor_state.ts";
import type { Config } from "./config.ts";
import { ContentManager } from "./content_manager.ts";
import { MainUI } from "../components/editor_ui.tsx";
import { initNavigator, type SpecialRoute } from "./navigator.ts";
import { wireModuleLifecycle } from "./lifecycle.ts";
import { DEFAULT_SHORTCUTS } from "../lib/shortcuts.ts";
import { writeUserPrefs } from "../lib/user_prefs.ts";
import { errMessage, notAuthenticatedError } from "../lib/constants.ts";
import { EditorService } from "./services/editor.ts";
import { VaultService } from "./services/vault.ts";
import { NavService } from "./services/nav.ts";
import type { ClientContext } from "./context.ts";

export type { WidgetMeta } from "./ctx/editor.ts";

declare global {
  var client: Client;
}

const fetchFileListInterval = 10000;

// The Client is the composition root: it owns the per-domain services
// (editor / vault / nav) plus the UI, config, and lifecycle hooks, and
// wires them together in init(). It implements the flat ClientContext by
// delegating to the services, so existing call sites keep working while
// consumers migrate to the nested `client.editor` / `.vault` / `.nav` API.
export class Client implements ClientContext {
  readonly editor: EditorService;
  readonly vault: VaultService;
  readonly nav: NavService;

  ui!: MainUI;

  // Single-slot lifecycle callbacks - each event has exactly one owner.
  onEditorInit?: () => void;
  onPageClick?: (event: ClickEvent) => void;
  onPageSaved?: () => void;

  constructor(
    private parent: Element,
    readonly config: Config,
  ) {
    this.editor = new EditorService(this);
    this.vault = new VaultService(this);
    this.nav = new NavService(this);
  }

  // --- flat ClientContext delegation (EditorCtx) -------------------------
  get editorView() {
    return this.editor.editorView;
  }
  set editorView(v) {
    this.editor.editorView = v;
  }
  get undoHistoryCompartment() {
    return this.editor.undoHistoryCompartment;
  }
  set undoHistoryCompartment(v) {
    this.editor.undoHistoryCompartment = v;
  }
  get markdownLanguageCompartment() {
    return this.editor.markdownLanguageCompartment;
  }
  set markdownLanguageCompartment(v) {
    this.editor.markdownLanguageCompartment = v;
  }
  get renderModeCompartment() {
    return this.editor.renderModeCompartment;
  }
  set renderModeCompartment(v) {
    this.editor.renderModeCompartment = v;
  }
  get editModeCompartment() {
    return this.editor.editModeCompartment;
  }
  set editModeCompartment(v) {
    this.editor.editModeCompartment = v;
  }
  get collabCompartment() {
    return this.editor.collabCompartment;
  }
  set collabCompartment(v) {
    this.editor.collabCompartment = v;
  }
  get collabHandle() {
    return this.editor.collabHandle;
  }
  set collabHandle(v) {
    this.editor.collabHandle = v;
  }
  get widgetMeta() {
    return this.editor.widgetMeta;
  }
  set widgetMeta(v) {
    this.editor.widgetMeta = v;
  }
  get systemReady() {
    return this.editor.systemReady;
  }
  set systemReady(v) {
    this.editor.systemReady = v;
  }
  currentPath() {
    return this.editor.currentPath();
  }
  currentName() {
    return this.editor.currentName();
  }
  currentPageMeta() {
    return this.editor.currentPageMeta();
  }
  isReadOnlyMode() {
    return this.editor.isReadOnlyMode();
  }
  focus() {
    this.editor.focus();
  }
  save(immediate = false) {
    return this.editor.save(immediate);
  }
  rebuildEditorState() {
    this.editor.rebuildEditorState();
  }
  reconfigureLanguage() {
    this.editor.reconfigureLanguage();
  }

  // --- flat ClientContext delegation (SpaceCtx) --------------------------
  get space() {
    return this.vault.space;
  }
  set space(v) {
    this.vault.space = v;
  }
  get httpSpacePrimitives() {
    return this.vault.httpSpacePrimitives;
  }
  set httpSpacePrimitives(v) {
    this.vault.httpSpacePrimitives = v;
  }
  get contentManager() {
    return this.vault.contentManager;
  }
  set contentManager(v) {
    this.vault.contentManager = v;
  }
  get allKnownFiles() {
    return this.vault.allKnownFiles;
  }
  get knownFilesLoaded() {
    return this.vault.knownFilesLoaded;
  }
  set knownFilesLoaded(v) {
    this.vault.knownFilesLoaded = v;
  }
  reloadEditor() {
    return this.vault.reloadEditor();
  }
  updatePageListCache() {
    return this.vault.updatePageListCache();
  }

  // --- flat ClientContext delegation (NavigationCtx / UICtx route) -------
  get openLocations() {
    return this.nav.openLocations;
  }
  set openLocations(v) {
    this.nav.openLocations = v;
  }
  get onLoadRef() {
    return this.nav.onLoadRef;
  }
  navigate(ref: Ref | null, replaceState = false) {
    return this.nav.navigate(ref, replaceState);
  }
  navigateRoute(route: SpecialRoute) {
    this.nav.navigateRoute(route);
  }
  openUrl(url: string) {
    return this.nav.openUrl(url);
  }

  setUiOption(key: string, value: unknown) {
    // Merge partial shortcut maps with the defaults so a caller that
    // knows only some bindings doesn't clobber the rest.
    if (key === "shortcuts" && value && typeof value === "object") {
      value = { ...DEFAULT_SHORTCUTS, ...(value as Record<string, unknown>) };
    }
    this.ui.setUiOptionState(key, value);
    this.config.set(["ui", key], value);
    try {
      const prefs = { ...(this.config.get("ui") ?? {}) };
      writeUserPrefs(prefs);
    } catch (_) { /* quota / disabled - ignore */ }
  }

  async init() {
    this.vault.contentManager = new ContentManager(this);
    this.vault.initSpace();

    this.ui = new MainUI(this);
    this.ui.render(this.parent);

    wireModuleLifecycle(this);

    this.editor.editorView = new EditorView({
      state: createEditorState(this, "", "", true),
      parent: document.getElementById("coconote-editor")!,
    });
    this.focus();

    try {
      await this.vault.httpSpacePrimitives.ping();
    } catch (e: unknown) {
      if (errMessage(e) === notAuthenticatedError.message) {
        console.warn("Not authenticated, boot token gate will handle it");
        return;
      }
      console.warn("Could not reach remote server", e);
    }

    // Must run before initNavigator: in multi-root mode the initial URL
    // (`/test-page`) lacks a root prefix and resolveWikiLinkPath needs
    // allKnownFiles to find `<root>/test-page.md`. Without the await the
    // first navigate races the page-list fetch and 404s.
    await this.updatePageListCache();

    await initNavigator(this);
    this.editor.systemReady = true;
    this.rebuildEditorState();

    this.onEditorInit?.();

    // Drop boot-time undo entries so Cmd+Z can't revert the initial doc
    // load. Under a live collab session Yjs owns undo - leave the CM
    // history disabled then (attach_to_editor manages it).
    this.editor.editorView.dispatch({
      effects: this.editor.undoHistoryCompartment.reconfigure([]),
    });
    if (!this.editor.collabHandle) {
      this.editor.editorView.dispatch({
        effects: this.editor.undoHistoryCompartment.reconfigure([history()]),
      });
    }

    setInterval(() => {
      void this.updatePageListCache();
    }, fetchFileListInterval);
  }
}
