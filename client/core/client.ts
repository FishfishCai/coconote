import { history } from "@codemirror/commands";
import type { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  getNameFromPath,
  type Path,
  type Ref,
} from "coconote/lib/ref";
import type { ClickEvent } from "coconote/type/client";
import type { PageMeta } from "coconote/type/page";
import {
  buildMarkdownLanguageExtension,
  createEditorState,
} from "../codemirror/editor_state.ts";
import type { Config } from "./config.ts";
import { ContentManager } from "./content_manager.ts";
import { MainUI } from "../components/editor_ui.tsx";
import {
  initNavigator,
  navigate as navigateFn,
  navigateSpecialRoute,
  openUrl as openUrlFn,
  type OpenLocations,
  parseRefFromURI,
  type SpecialRoute,
} from "./navigator.ts";
import { Space } from "./space.ts";
import { absFsBase } from "../spaces/constants.ts";
import { writeUserPrefs } from "../lib/user_prefs.ts";
import { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";
import { wireModuleLifecycle } from "./lifecycle.ts";
import { getAuthToken } from "../lib/authed_fetch.ts";
import { DEFAULT_SHORTCUTS } from "../lib/shortcuts.ts";
import { errMessage, notAuthenticatedError } from "../lib/constants.ts";
import type {
  AttachedCollabHandle,
  ClientContext,
  WidgetMeta,
} from "./context.ts";

export type { WidgetMeta };

declare global {
  var client: Client;
}

const fetchFileListInterval = 10000;

export class Client implements ClientContext {
  space!: Space;
  httpSpacePrimitives!: HttpSpacePrimitives;
  ui!: MainUI;

  editorView!: EditorView;
  undoHistoryCompartment?: Compartment;
  markdownLanguageCompartment?: Compartment;
  renderModeCompartment?: Compartment;
  editModeCompartment?: Compartment;
  collabCompartment?: Compartment;
  // Live collab session — kept so loadPage can disconnect before the
  // doc swap AND rebuildEditorState can reseed the compartment with
  // the same yCollab extension instead of dropping it.
  collabHandle?: AttachedCollabHandle;

  contentManager!: ContentManager;
  // Seeds CM's heightMap via WidgetType.estimatedHeight before async measure.
  widgetMeta = new Map<string, WidgetMeta>();

  // Opt-in page index. Used by wiki link rendering to mark missing /
  // ambiguous targets. Populated by updatePageListCache.
  readonly allKnownFiles = new Set<string>();
  knownFilesLoaded = false;

  systemReady = false;
  readonly fullIndexCompleted = true;
  readonly pageListLoaded = true;

  /** Session-only map of cursor/scroll per page; drives back/forward restore. */
  openLocations: OpenLocations = new Map();
  onLoadRef: Ref | null;

  // Single-slot lifecycle callbacks — each event has exactly one owner.
  onEditorInit?: () => void;
  onPageClick?: (event: ClickEvent) => void;
  onPageSaved?: () => void;

  constructor(
    private parent: Element,
    readonly config: Config,
  ) {
    this.onLoadRef = parseRefFromURI();
  }

  async init() {
    this.contentManager = new ContentManager(this);
    this.initSpace();

    this.ui = new MainUI(this);
    this.ui.render(this.parent);

    wireModuleLifecycle(this);

    this.editorView = new EditorView({
      state: createEditorState(this, "", "", true),
      parent: document.getElementById("coconote-editor")!,
    });
    this.focus();

    try {
      await this.httpSpacePrimitives.ping();
    } catch (e: unknown) {
      if (errMessage(e) === notAuthenticatedError.message) {
        console.warn("Not authenticated, boot token gate will handle it");
        return;
      }
      console.warn("Could not reach remote server", e);
    }

    // Must run before initNavigator: in multi-root mode the initial URL
    // (`/test-page`) lacks a root prefix, and resolveWikiLinkPath needs
    // allKnownFiles to map it to the real `<root>/test-page.md`. Without
    // this await the first navigate races the page-list fetch and the
    // server returns 404.
    await this.updatePageListCache();

    await initNavigator(this);
    this.systemReady = true;
    this.rebuildEditorState();

    this.onEditorInit?.();

    // Drop boot-time undo entries so Cmd+Z can't revert the initial doc
    // load. Under a live collab session Yjs owns undo — leave the CM
    // history disabled then (attach_to_editor manages it).
    this.editorView.dispatch({
      effects: this.undoHistoryCompartment?.reconfigure([]),
    });
    if (!this.collabHandle) {
      this.editorView.dispatch({
        effects: this.undoHistoryCompartment?.reconfigure([history()]),
      });
    }

    setInterval(() => {
      void this.updatePageListCache();
    }, fetchFileListInterval);
  }

  initSpace() {
    this.httpSpacePrimitives = new HttpSpacePrimitives(
      absFsBase(),
      (message, actionOrRedirectHeader) => {
        alert(message);
        if (actionOrRedirectHeader === "reload") {
          location.reload();
        } else if (typeof actionOrRedirectHeader === "string") {
          location.href = actionOrRedirectHeader;
        }
      },
      // welcome.md: remote browser clients present the auth token —
      // boot.ts's token gate stored it and seeded the module state.
      getAuthToken(),
    );
    this.space = new Space(this.httpSpacePrimitives);
  }

  async updatePageListCache() {
    try {
      const [localPages, remotePages] = await Promise.all([
        this.space.fetchPageList(),
        // Lazy: imported here so the bundle doesn't pull remote code on
        // boot if no remote vaults are configured.
        import("../lib/remote_index.ts").then((m) => m.fetchAllRemotePages()),
      ]);
      const allPages = localPages.concat(remotePages);
      this.allKnownFiles.clear();
      for (const p of allPages) {
        // md page names are extensionless; pdf names keep .pdf — naively
        // appending .md would index phantom "doc.pdf.md" entries and
        // break unqualified [[doc.pdf]] navigation.
        this.allKnownFiles.add(
          p.name.toLowerCase().endsWith(".pdf") ? p.name : `${p.name}.md`,
        );
      }
      this.knownFilesLoaded = true;
      this.ui.updatePageList(allPages);
    } catch (e) {
      console.warn("Could not fetch page list", e);
    }
  }

  currentPath(): Path {
    return (this.ui.viewState.current?.path ?? this.onLoadRef?.path ??
      "") as Path;
  }

  currentName(): string {
    const p = this.ui.viewState.current?.path ?? this.onLoadRef?.path;
    return p ? getNameFromPath(p) : "";
  }

  currentPageMeta(): PageMeta | undefined {
    return this.ui.viewState.current?.meta;
  }

  save(immediate = false): Promise<void> {
    return this.contentManager.save(immediate);
  }

  reconfigureLanguage() {
    if (this.markdownLanguageCompartment) {
      this.editorView.dispatch({
        effects: this.markdownLanguageCompartment.reconfigure(
          buildMarkdownLanguageExtension(this),
        ),
      });
    }
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
    } catch (_) { /* quota / disabled — ignore */ }
  }

  rebuildEditorState() {
    const editorView = this.editorView;
    const previousSelection = editorView.state.selection;
    const previousScrollTop = editorView.scrollDOM.scrollTop;
    editorView.setState(
      createEditorState(
        this,
        this.currentName(),
        editorView.state.sliceDoc(),
        this.currentPageMeta()?.perm === "ro",
        previousSelection,
      ),
    );
    editorView.scrollDOM.scrollTop = previousScrollTop;
    // Block widgets from the old state can linger in the DOM after setState;
    // requestMeasure forces the view to reconcile decorations against the
    // new state's StateFields.
    editorView.requestMeasure();
    queueMicrotask(() => {
      editorView.requestMeasure();
      editorView.dispatch({});
    });
  }

  isReadOnlyMode(): boolean {
    return this.config.get<boolean>(["_boot", "readOnly"], false) ||
      this.currentPageMeta()?.perm === "ro";
  }

  reloadEditor() {
    return this.contentManager.reloadEditor();
  }

  focus() {
    const vs = this.ui?.viewState;
    if (!vs) return;
    if (vs.showConfirm || vs.showPrompt) return;
    this.editorView.focus();
  }

  navigate(ref: Ref | null, replaceState = false) {
    return navigateFn(this, ref, replaceState);
  }

  navigateRoute(route: SpecialRoute) {
    navigateSpecialRoute(this, route);
  }

  openUrl(url: string) {
    return openUrlFn(this, url);
  }
}

