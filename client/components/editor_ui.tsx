import { Confirm, Prompt } from "./basic_modals.tsx";
import { ContentBrowser, loadView } from "./content_browser.tsx";
import { HistoryPanel } from "./history_panel.tsx";
import { Settings } from "./settings.tsx";
import { PdfViewer } from "../pdf/pdf_viewer.tsx";
import { PdfMetadataPanel } from "../pdf/pdf_metadata_panel.tsx";
import {
  activeSidecarState,
  sidecarPath,
  updateSidecarSession,
} from "../pdf/notes_client.ts";
import type { AppViewState } from "../types/ui.ts";
import { h, render as preactRender } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ClientContext as Client,
  CollabUiStatus,
} from "../core/context.ts";
import { getNameFromPath, type Path } from "coconote/lib/ref";
import { installGlobalKeyboard } from "../core/keyboard.ts";
import {
  isMarkdownPath,
  parseToRef,
} from "coconote/lib/ref";
import type { PageMeta } from "coconote/type/page";
import { extractFrontmatter } from "../markdown/frontmatter.ts";

type UiOptions = AppViewState["uiOptions"];
const initialUiOptions: UiOptions = {
  darkMode: undefined,
  editorMode: "render",
  fontSize: 18,
  editorWidth: 40,
  accentColor: "",
  highlightColor: "",
  linkMissingColor: "",
  codeBackgroundColor: "",
  hoverBackgroundColor: "",
  fontText: "",
  fontInterface: "",
  fontMonospace: "",
  snippets: "",
};

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = d / (l > 0.5 ? 2 - max - min : max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: Math.round(hue), s: Math.round(s * 100), l: Math.round(l * 100) };
}

type CurrentPage = { path: Path; meta: PageMeta };
type Modal =
  | { kind: "prompt"; message: string; defaultValue: string; callback: (v: string | undefined) => void }
  | { kind: "confirm"; message: string; callback: (v: boolean) => void }
  | null;

type PdfViewerState = { path: string; anchor?: string } | null;
type Setters = {
  setCurrent(v: CurrentPage | undefined): void;
  setUnsavedChanges(v: boolean): void;
  setAllPages(v: PageMeta[]): void;
  setUiOptions(updater: (prev: UiOptions) => UiOptions): void;
  setModal(v: Modal): void;
  setShowSettings(v: boolean): void;
  setShowContentBrowser(v: boolean): void;
  setPendingContentFilter(v: string): void;
  setContentBrowserView(v: "path" | "tag" | "graph"): void;
  setShowHistory(v: boolean): void;
  setPdfViewer(v: PdfViewerState): void;
  setShowPdfMeta(v: boolean): void;
};

export class MainUI {
  // Read by non-React consumers; refreshed every ViewComponent render.
  viewState: AppViewState = {
    allPages: [],
    unsavedChanges: false,
    uiOptions: initialUiOptions,
    showPrompt: false,
    showConfirm: false,
    showSettings: false,
    showContentBrowser: false,
    pendingContentFilter: "",
    pdfViewer: null,
  };
  private setters!: Setters;

  constructor(private client: Client) {
    installGlobalKeyboard(client, {
      openHistory: () => this.setters?.setShowHistory(true),
      openPdfMetadata: () => this.setters?.setShowPdfMeta(true),
    });
  }

  setLoadedPage(path: Path, meta: PageMeta) {
    this.setters.setCurrent({ path, meta });
  }
  markPageChanged() {
    this.setters.setUnsavedChanges(true);
  }
  markPageSaved() {
    this.setters.setUnsavedChanges(false);
  }
  updatePageList(allPages: PageMeta[]) {
    const prevByName = new Map(this.viewState.allPages.map((p) => [p.name, p]));
    for (const pm of allPages) {
      const old = prevByName.get(pm.name);
      if (old?.lastOpened) pm.lastOpened = old.lastOpened;
    }
    this.setters.setAllPages(allPages);
    const cur = this.viewState.current;
    if (cur && isMarkdownPath(cur.path)) {
      const fresh = allPages.find(
        (p) => parseToRef(p.name)?.path === cur.path,
      );
      if (fresh) this.setters.setCurrent({ path: cur.path, meta: fresh });
    }
  }
  setUiOptionState(key: string, value: unknown) {
    this.setters.setUiOptions((prev) => ({ ...prev, [key]: value }));
  }
  showSettings() {
    this.setters.setShowSettings(true);
  }
  hideSettings() {
    this.setters.setShowSettings(false);
  }
  showContentBrowser(filter = "") {
    this.setters.setPendingContentFilter(filter);
    this.setters.setShowContentBrowser(true);
  }
  hideContentBrowser() {
    this.setters.setShowContentBrowser(false);
  }
  /** Persist + reflect the active Content view (path / tag / graph) so
   *  /.content/<view> URLs survive reload (content.md). */
  setContentBrowserView(view: "path" | "tag" | "graph") {
    this.setters.setContentBrowserView(view);
    try {
      localStorage.setItem("coconote.contentBrowserView", view);
    } catch {/* quota */}
  }
  showHistory() {
    this.setters.setShowHistory(true);
  }
  hideHistory() {
    this.setters.setShowHistory(false);
  }
  showPdfViewer(path: string, anchor?: string) {
    this.setters.setPdfViewer({ path, anchor });
    this.setters.setShowSettings(false);
    this.setters.setShowContentBrowser(false);
  }
  hidePdfViewer() {
    this.setters.setPdfViewer(null);
  }

  prompt(message: string, defaultValue = ""): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.setters.setModal({
        kind: "prompt",
        message,
        defaultValue,
        callback: (value) => {
          this.setters.setModal(null);
          this.client.focus();
          resolve(value);
        },
      });
    });
  }

  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.setters.setModal({
        kind: "confirm",
        message,
        callback: (value) => {
          this.setters.setModal(null);
          this.client.focus();
          resolve(value);
        },
      });
    });
  }

  ViewComponent() {
    const [current, setCurrent] = useState<CurrentPage | undefined>(undefined);
    const [unsavedChanges, setUnsavedChanges] = useState(false);
    const [allPages, setAllPages] = useState<PageMeta[]>([]);
    const [uiOptions, setUiOptions] = useState<UiOptions>(initialUiOptions);
    const [modal, setModal] = useState<Modal>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showContentBrowser, setShowContentBrowser] = useState(false);
    const [pendingContentFilter, setPendingContentFilter] = useState("");
    const [contentBrowserView, setContentBrowserViewState] = useState<
      "path" | "tag" | "graph"
    >(loadView);
    const [showHistory, setShowHistory] = useState(false);
    const [pdfViewer, setPdfViewer] = useState<PdfViewerState>(null);
    const [showPdfMeta, setShowPdfMeta] = useState(false);

    this.setters = {
      setCurrent,
      setUnsavedChanges,
      setAllPages,
      setUiOptions,
      setModal,
      setShowSettings,
      setShowContentBrowser,
      setPendingContentFilter,
      setContentBrowserView: setContentBrowserViewState,
      setShowHistory,
      setPdfViewer,
      setShowPdfMeta,
    };
    this.viewState = {
      current,
      allPages,
      unsavedChanges,
      uiOptions,
      showPrompt: modal?.kind === "prompt",
      promptMessage: modal?.kind === "prompt" ? modal.message : undefined,
      promptDefaultValue: modal?.kind === "prompt" ? modal.defaultValue : undefined,
      promptCallback: modal?.kind === "prompt" ? modal.callback : undefined,
      showConfirm: modal?.kind === "confirm",
      confirmMessage: modal?.kind === "confirm" ? modal.message : undefined,
      confirmCallback: modal?.kind === "confirm" ? modal.callback : undefined,
      showSettings,
      showContentBrowser,
      pendingContentFilter,
      pdfViewer,
    };

    useEffect(() => {
      if (!current) return;
      const fallback = getNameFromPath(current.path);
      // First 1KB only — runs on every save.
      const recompute = () => {
        const head = this.client.editorView?.state.sliceDoc(0, 1024) ?? "";
        const fm = extractFrontmatter(head);
        document.title = fm.title || fallback;
      };
      recompute();
      this.client.onPageSaved = recompute;
      return () => {
        if (this.client.onPageSaved === recompute) {
          this.client.onPageSaved = undefined;
        }
      };
    }, [current]);

    useEffect(() => {
      if (uiOptions.darkMode === undefined) return;
      document.documentElement.dataset.theme = uiOptions.darkMode ? "dark" : "light";
      // Persist so the inline <head> script in index.html avoids the
      // light->dark first-paint flash on next load.
      try {
        localStorage.setItem("coconote.darkMode", uiOptions.darkMode ? "1" : "0");
      } catch { /* ignore quota / disabled storage */ }
    }, [uiOptions.darkMode]);

    useEffect(() => {
      document.documentElement.dataset.editorMode = uiOptions.editorMode;
    }, [uiOptions.editorMode]);

    useEffect(() => {
      document.documentElement.style.setProperty(
        "--editor-font-size",
        `${uiOptions.fontSize}px`,
      );
    }, [uiOptions.fontSize]);

    useEffect(() => {
      document.documentElement.style.setProperty(
        "--editor-width",
        `${uiOptions.editorWidth}rem`,
      );
    }, [uiOptions.editorWidth]);

    // Skip initial mount: rebuilding state during boot races with
    // initNavigator's loadPage and can clobber the just-loaded document.
    const snippetsInited = useRef(false);
    useEffect(() => {
      if (!snippetsInited.current) {
        snippetsInited.current = true;
        return;
      }
      void import("../codemirror/plugins/snippets/snippets.ts").then((m) => {
        m.invalidateSnippetsCache();
        this.client.rebuildEditorState();
      });
    }, [uiOptions.snippets]);

    // Empty string clears the override so the theme default re-applies.
    useEffect(() => {
      const root = document.documentElement;
      const set = (cssVar: string, value: string) => {
        if (value) root.style.setProperty(cssVar, value);
        else root.style.removeProperty(cssVar);
      };
      // Split accent hex -> HSL so the theme can derive hover/selection
      // shades by tweaking lightness.
      if (uiOptions.accentColor) {
        const hsl = hexToHsl(uiOptions.accentColor);
        if (hsl) {
          root.style.setProperty("--accent-h", String(hsl.h));
          root.style.setProperty("--accent-s", `${hsl.s}%`);
          root.style.setProperty("--accent-l", `${hsl.l}%`);
        }
      } else {
        root.style.removeProperty("--accent-h");
        root.style.removeProperty("--accent-s");
        root.style.removeProperty("--accent-l");
      }
      set("--editor-highlight-background-color", uiOptions.highlightColor);
      set("--editor-wiki-link-missing-color", uiOptions.linkMissingColor);
      // setting.md: "Code background" covers inline AND fenced blocks —
      // the stylesheet uses a separate var for block surfaces.
      set("--editor-code-background-color", uiOptions.codeBackgroundColor);
      set("--editor-code-block-background-color", uiOptions.codeBackgroundColor);
      // CSS uses --background-secondary-alt for button / settings-group /
      // content-browser hovers (setting.md "Hover background").
      set("--background-secondary-alt", uiOptions.hoverBackgroundColor);
      set("--font-text", uiOptions.fontText);
      set("--font-interface", uiOptions.fontInterface);
      set("--font-monospace", uiOptions.fontMonospace);
    }, [
      uiOptions.accentColor,
      uiOptions.highlightColor,
      uiOptions.linkMissingColor,
      uiOptions.codeBackgroundColor,
      uiOptions.hoverBackgroundColor,
      uiOptions.fontText,
      uiOptions.fontInterface,
      uiOptions.fontMonospace,
    ]);

    return (
      <>
        {modal?.kind === "prompt" && (
          <Prompt
            message={modal.message}
            defaultValue={modal.defaultValue}
            darkMode={uiOptions.darkMode}
            callback={(value) => {
              setModal(null);
              modal.callback(value);
            }}
          />
        )}
        {modal?.kind === "confirm" && (
          <Confirm
            message={modal.message}
            callback={(value) => {
              setModal(null);
              modal.callback(value);
            }}
          />
        )}
        <div id="coconote-content">
          {/* 32px draggable strip for Electron's hidden-inset title bar
              (-webkit-app-region: drag in the CSS). Inert in a browser. */}
          <div className="coconote-window-drag" />
          <CollabStatusDot client={this.client} />
          <div id="coconote-main">
            <div
              id="coconote-editor"
              style={(showSettings || showContentBrowser || pdfViewer)
                ? { display: "none" }
                : undefined}
            />
            {showSettings && (
              <Settings client={this.client} uiOptions={uiOptions} />
            )}
            {showContentBrowser && !showSettings && !pdfViewer && (
              <ContentBrowser
                client={this.client}
                view={contentBrowserView}
                initialFilter={pendingContentFilter}
              />
            )}
            {pdfViewer && !showSettings && (
              <PdfViewer
                // Key by path only: an in-document %anchor jump must
                // scroll the mounted viewer (anchorScrolledRef), not
                // remount + re-render the whole PDF.
                key={pdfViewer.path}
                path={pdfViewer.path}
                initialAnchor={pdfViewer.anchor}
              />
            )}
          </div>
          {showHistory && pdfViewer && (() => {
            // PDF history: keyed by the sidecar's page id, previewed
            // against the live sidecar, and restored through the collab
            // session (writing to disk directly would fight the open room).
            const pdfPath = pdfViewer.path;
            const sid = activeSidecarState(pdfPath)?.metadata.id;
            if (!sid) return null;
            return (
              <HistoryPanel
                id={sid}
                targetPath={sidecarPath(pdfPath)}
                applyRestore={(txt) => {
                  try {
                    const sc = JSON.parse(txt);
                    updateSidecarSession(pdfPath, () => sc);
                  } catch { /* skip a non-JSON snapshot */ }
                }}
                onClose={() => setShowHistory(false)}
                onRestored={() => void this.client.updatePageListCache?.()}
              />
            );
          })()}
          {showHistory && !pdfViewer && current?.path && current?.meta?.id && (
            <HistoryPanel
              id={current.meta.id}
              targetPath={current.path}
              onClose={() => setShowHistory(false)}
              onRestored={() => {
                void this.client.contentManager?.loadPage({ path: current.path });
              }}
            />
          )}
          {showPdfMeta && pdfViewer && (
            <PdfMetadataPanel
              pdfPath={pdfViewer.path}
              onClose={() => setShowPdfMeta(false)}
              onSaved={() => void this.client.updatePageListCache()}
            />
          )}
        </div>
      </>
    );
  }

  render(container: Element) {
    container.innerHTML = "";
    preactRender(h(this.ViewComponent.bind(this), {}), container);
  }
}

// Live collab WS state dot (editor.md §Collaboration "green / yellow").
// Subscribes to the handle's onStatusChange; a short interval re-bind
// covers the case where loadPage swaps in a new handle.
function CollabStatusDot({ client }: { client: Client }) {
  const [status, setStatus] = useState<CollabUiStatus>("connecting");
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let currentHandle: unknown = null;
    const bind = () => {
      const h = client.collabHandle;
      if (h === currentHandle) return;
      unsub?.();
      currentHandle = h;
      if (!h) {
        setStatus("disposed");
        unsub = undefined;
        return;
      }
      setStatus(h.status?.() ?? "connecting");
      unsub = h.onStatusChange?.(setStatus);
    };
    bind();
    const id = window.setInterval(bind, 500);
    return () => {
      unsub?.();
      window.clearInterval(id);
    };
  }, [client]);
  const title = status === "connected"
    ? "Collab: connected"
    : status === "disposed"
    ? "Collab: off"
    : "Collab: reconnecting…";
  return (
    <span
      className={`coconote-collab-status coconote-collab-status-${status}`}
      title={title}
      aria-label={title}
    />
  );
}
