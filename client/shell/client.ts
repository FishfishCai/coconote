import { history } from "@codemirror/commands";
import type { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ClickEvent } from "coconote/type/client";
import type { PageMeta } from "coconote/type/page";
import type { Path } from "../core/util";
import {
  createEditorState,
  rebuildEditorState as rebuildEditorStateFn,
  reconfigureLanguage as reconfigureLanguageFn,
} from "../features/md-editor";
import type { Config } from "../core/config.ts";
import { ContentManager } from "./content_manager.ts";
import { MainUI } from "./editor_ui.tsx";
import {
  initNavigator,
  navigate as navigateFn,
  type NavTarget,
  type OnLoad,
  openUrl as openUrlFn,
  type OpenLocations,
  parseOnLoad,
} from "./navigator.ts";
import { wireModuleLifecycle } from "./lifecycle.ts";
import { DEFAULT_SHORTCUTS } from "../core/shortcuts/index.ts";
import {
  type ConfigEntry,
  getConfig,
  readUserPrefs,
  writeUserPrefs,
} from "../core/config/index.ts";
import { basename, errMessage, notAuthenticatedError } from "../core/util";
import { absFsBase, getAuthToken, HttpSpacePrimitives } from "../core/transport";
import { extractFrontmatter } from "../core/file";
import { kindFromMeta, Space } from "./space.ts";
import type {
  AttachedCollabHandle,
  ReaderZoomHandle,
  WidgetMeta,
} from "../core/ctx/editor.ts";
import type { ClientContext } from "../core/context.ts";

export type { WidgetMeta } from "../core/ctx/editor.ts";

declare global {
  var client: Client;
}

// Reader zoom bounds, shared by the markdown and PDF readers: clamp to
// [0.5, 3.0] and step by 0.1 (per-reader zoom feature).
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Default display title from a path hint (filename without extension),
 *  mirroring the server's `read_meta` filename fallback so title
 *  resolution agrees with /.resolve. */
function titleFromPath(pathHint?: string): string | undefined {
  if (!pathHint) return undefined;
  return basename(pathHint).replace(/\.(md|pdf)$/i, "") || undefined;
}

// Structural deep-equality over JSON-shaped prefs. Used by the cross-window
// settings sync to tell an actual change from a same-value echo - key order
// differs between windows' serializations, so a string compare won't do.
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const ax = a as unknown[];
    const bx = b as unknown[];
    return ax.length === bx.length && ax.every((x, i) => jsonEqual(x, bx[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) =>
    jsonEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )
  );
}

// The Client is the composition root and the live app state: it owns the
// editor session (the CodeMirror view, the reconfigurable compartments, the
// live collab handle, the widget-height cache), the vault-access layer (the
// space primitives, the content manager, the known-file index), and page
// navigation (the session open-locations map + initial-load intent), plus
// the UI, config, and lifecycle hooks, wiring them together in init(). It
// implements ClientContext; consumers import the narrowest ./ctx/* surface
// they actually use.
//
// no-vault: there is no directory index. The known set is the id-closure of
// `recent` U `pin` (from the server config) over each file's frontmatter
// `refs` / `backrefs` (md body, or the PDF's sidecar json). Each file is
// read once to pull its title / tags / refs / backrefs.
export class Client implements ClientContext {
  ui!: MainUI;

  // --- editor session (EditorCtx) ----------------------------------------
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
  // Markdown reader zoom multiplier (default 1). Transient per window, not
  // persisted: localStorage is shared across this origin's Electron windows
  // and would wrongly sync zoom between them. Survives page navigations
  // within the window, resets to 1 on reload.
  private mdZoom = 1;
  // Registered by the mounted PDF viewer so keyboard.ts can drive it.
  pdfZoom?: ReaderZoomHandle;

  // --- vault access (SpaceCtx) -------------------------------------------
  space!: Space;
  httpSpacePrimitives!: HttpSpacePrimitives;
  contentManager!: ContentManager;
  // Known-file index (filled by updatePageListCache) keyed by id. Wiki link
  // rendering / resolution uses the broadcast page list; this set is a fast
  // "is this id reachable" membership test.
  readonly allKnownFiles = new Set<string>();
  knownFilesLoaded = false;

  // --- navigation (NavigationCtx) ----------------------------------------
  /** Session-only cursor/scroll per page id - drives back/forward restore. */
  openLocations: OpenLocations = new Map();
  readonly onLoad: OnLoad = parseOnLoad();

  // Single-slot lifecycle callbacks - each event has exactly one owner.
  onEditorInit?: () => void;
  onPageClick?: (event: ClickEvent) => void;
  onPageSaved?: () => void;

  constructor(
    private parent: Element,
    readonly config: Config,
  ) {}

  // ===== editor session ==================================================

  currentId(): string {
    return this.ui.viewState.current?.meta.id ?? this.onLoadId() ?? "";
  }

  currentPath(): Path {
    return (this.ui.viewState.current?.meta.path ?? "") as Path;
  }

  currentTitle(): string {
    return this.ui.viewState.current?.meta.title ?? "";
  }

  currentName(): string {
    const meta = this.ui.viewState.current?.meta;
    if (meta?.title) return meta.title;
    if (meta?.path) return meta.path.split("/").pop()!.replace(/\.(md|pdf)$/i, "");
    return "untitled";
  }

  currentPageMeta(): PageMeta | undefined {
    return this.ui.viewState.current?.meta;
  }

  isReadOnlyMode(): boolean {
    // Edit availability is per-file: the server stamps each file's
    // X-Permission (ro/rw), surfaced here as PageMeta.perm.
    return this.currentPageMeta()?.perm === "ro";
  }

  focus() {
    const vs = this.ui.viewState;
    if (vs.showConfirm || vs.showPrompt) return;
    this.editorView.focus();
  }

  save(immediate = false): Promise<void> {
    return this.contentManager.save(immediate);
  }

  rebuildEditorState() {
    rebuildEditorStateFn(this);
  }

  reconfigureLanguage() {
    reconfigureLanguageFn(this);
  }

  // Markdown reader zoom. --editor-zoom multiplies the font-size setting
  // in editor.scss (CodeMirror-safe: a transform:scale would break its
  // coordinate math). Mirrors use_appearance.ts: written on documentElement.
  private applyMdZoom() {
    document.documentElement.style.setProperty(
      "--editor-zoom",
      String(this.mdZoom),
    );
  }

  zoomIn() {
    this.mdZoom = clampZoom(this.mdZoom + ZOOM_STEP);
    this.applyMdZoom();
  }

  zoomOut() {
    this.mdZoom = clampZoom(this.mdZoom - ZOOM_STEP);
    this.applyMdZoom();
  }

  zoomReset() {
    this.mdZoom = 1;
    this.applyMdZoom();
  }

  // ===== vault access ====================================================

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
      // welcome.md: remote browser clients present the auth token -
      // boot.ts's token gate stored it and seeded the module state.
      getAuthToken(),
    );
    this.space = new Space(this.httpSpacePrimitives);
  }

  async updatePageListCache() {
    try {
      const cfg = await getConfig();
      const seeds = [...(cfg.pin ?? []), ...(cfg.recent ?? [])];
      const pages = await this.buildClosure(seeds);
      this.allKnownFiles.clear();
      for (const p of pages.values()) this.allKnownFiles.add(p.id);
      this.knownFilesLoaded = true;
      this.ui.updatePageList([...pages.values()]);
    } catch (e) {
      console.warn("Could not build page list", e);
    }
  }

  /** BFS from `seeds` (id, path pairs) along each file's frontmatter
   *  refs/backrefs (id lists). Each id is read once for its metadata. */
  private async buildClosure(
    seeds: ConfigEntry[],
  ): Promise<Map<string, PageMeta>> {
    const pages = new Map<string, PageMeta>();
    const pathHints = new Map<string, string>();
    for (const s of seeds) {
      if (s.id && s.path) pathHints.set(s.id, s.path);
    }
    const queue: string[] = [];
    const enqueue = (id: string) => {
      if (id && !pages.has(id) && !queue.includes(id)) queue.push(id);
    };
    for (const s of seeds) enqueue(s.id);

    while (queue.length) {
      const id = queue.shift()!;
      const meta = await this.readPageMeta(id, pathHints.get(id));
      if (!meta) continue;
      pages.set(id, meta);
      for (const r of meta.refs ?? []) enqueue(r);
      for (const b of meta.backrefs ?? []) enqueue(b);
    }
    return pages;
  }

  /** Read one file's metadata by id (title / tags / refs / backrefs +
   *  perm / mtime). md frontmatter comes from the body; PDF metadata from
   *  the sidecar json (loadable only when the path hint gives the stem).
   *  Returns null when the file can't be read. */
  private async readPageMeta(
    id: string,
    pathHint?: string,
  ): Promise<PageMeta | null> {
    const sp = this.httpSpacePrimitives;
    const hintIsPdf = !!pathHint && /\.pdf$/i.test(pathHint);
    try {
      if (hintIsPdf) return await this.readPdfMeta(id, pathHint!);

      // md (hint says so) or unknown kind - GET classifies by content type.
      const { data, meta } = await sp.readFile({ id });
      const kind = kindFromMeta(meta.contentType, pathHint);
      if (kind === "pdf") {
        // A pdf reached by id without a path hint: no stem to load the
        // sidecar, so record a minimal entry.
        return {
          id: meta.id ?? id,
          path: pathHint,
          kind: "pdf",
          created: new Date(meta.created).toISOString(),
          lastModified: new Date(meta.lastModified).toISOString(),
          perm: meta.perm,
          title: titleFromPath(pathHint),
        };
      }
      const fm = extractFrontmatter(new TextDecoder().decode(data));
      return {
        id: meta.id ?? id,
        path: pathHint,
        kind: "md",
        created: new Date(meta.created).toISOString(),
        lastModified: new Date(meta.lastModified).toISOString(),
        perm: meta.perm,
        title: fm.title ?? titleFromPath(pathHint),
        tags: fm.tags,
        refs: fm.refs,
        backrefs: fm.backrefs,
        contentHash: meta.contentHash,
      };
    } catch {
      // File may be gone or out of the refs boundary - drop it from the
      // index rather than failing the whole rebuild.
      return null;
    }
  }

  private async readPdfMeta(
    id: string,
    pathHint: string,
  ): Promise<PageMeta | null> {
    const sp = this.httpSpacePrimitives;
    try {
      const head = await sp.getFileMeta({ id });
      const stem = basename(pathHint).replace(/\.pdf$/i, "");
      let metadata:
        | { title?: string; tags?: string[]; tag?: string[]; backrefs?: string[] }
        | undefined;
      try {
        const { data } = await sp.readFile({ id, asset: `${stem}.json` });
        const parsed = JSON.parse(new TextDecoder().decode(data));
        metadata = parsed?.metadata;
      } catch {
        // No sidecar yet (or unreadable) - fall back to the filename title.
      }
      return {
        id: head.id ?? id,
        path: pathHint,
        kind: "pdf",
        created: new Date(head.created).toISOString(),
        lastModified: new Date(head.lastModified).toISOString(),
        perm: head.perm,
        title: metadata?.title || titleFromPath(pathHint),
        tags: metadata?.tags ?? metadata?.tag,
        backrefs: metadata?.backrefs,
      };
    } catch {
      return null;
    }
  }

  // ===== navigation ======================================================

  onLoadId(): string | undefined {
    return this.onLoad?.kind === "id" ? this.onLoad.id : undefined;
  }

  navigate(target: NavTarget | null, replaceState = false) {
    return navigateFn(this, target, replaceState);
  }

  openUrl(url: string) {
    return openUrlFn(url);
  }

  // ===== ui options ======================================================

  setUiOption(key: string, value: unknown) {
    this.applyUiOption(key, value, /*persist=*/ true);
  }

  // Apply one UI option to the live UI state + Config. `persist` decides
  // whether it is also written back to localStorage: edits made in THIS
  // window persist (true); options mirrored in from another window via the
  // `storage` event must not (false), otherwise both windows would echo the
  // write back to each other in a loop.
  private applyUiOption(key: string, value: unknown, persist: boolean) {
    // Merge partial shortcut maps with the defaults so a caller that
    // knows only some bindings doesn't clobber the rest.
    if (key === "shortcuts" && value && typeof value === "object") {
      value = { ...DEFAULT_SHORTCUTS, ...(value as Record<string, unknown>) };
    }
    this.ui.setUiOptionState(key, value);
    this.config.set(["ui", key], value);
    if (!persist) return;
    try {
      const prefs = { ...(this.config.get("ui") ?? {}) };
      writeUserPrefs(prefs);
    } catch (_) { /* quota / disabled - ignore */ }
  }

  // setting.md L104: one set of settings is shared across windows/tabs. The
  // boot `storage` listener calls this when another window rewrote the prefs
  // blob. Re-read it and re-apply every option live: appearance reacts to the
  // UI state, and the single trailing write bumps this window's userPrefs
  // version so matchShortcut's combo cache refreshes (shortcuts go live too).
  // The equality guard skips when already in sync, which also stops the
  // trailing write from bouncing back and forth between the two windows.
  syncPrefsFromStorage() {
    const incoming = readUserPrefs();
    const current = (this.config.get("ui") ?? {}) as Record<string, unknown>;
    if (jsonEqual(incoming, current)) return;
    for (const [k, v] of Object.entries(incoming)) {
      this.applyUiOption(k, v, /*persist=*/ false);
    }
    try {
      writeUserPrefs({ ...(this.config.get("ui") ?? {}) });
    } catch (_) { /* quota / disabled - ignore */ }
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

    // Must run before initNavigator: the first navigate's title->id
    // resolution needs the page list populated. Without the await it
    // would race the page-list build and mark links missing.
    await this.updatePageListCache();

    await initNavigator(this);
    this.systemReady = true;
    this.rebuildEditorState();

    this.onEditorInit?.();

    // Drop boot-time undo entries so Cmd+Z can't revert the initial doc
    // load. Under a live collab session Yjs owns undo - leave the CM
    // history disabled then (attach_to_editor manages it).
    this.editorView.dispatch({
      effects: this.undoHistoryCompartment.reconfigure([]),
    });
    if (!this.collabHandle) {
      this.editorView.dispatch({
        effects: this.undoHistoryCompartment.reconfigure([history()]),
      });
    }
  }
}
