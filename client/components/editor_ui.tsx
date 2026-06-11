import { Confirm, Prompt } from "./basic_modals.tsx";
import { CollabStatusDot } from "./collab_status_dot.tsx";
import { ContentBrowser, loadView } from "./content_browser.tsx";
import { HistoryPanel } from "./history_panel.tsx";
import { Settings } from "./settings.tsx";
import { useAppearance } from "./use_appearance.ts";
import { PdfViewer } from "../pdf/pdf_viewer.tsx";
import { PdfMetadataPanel } from "../pdf/pdf_metadata_panel.tsx";
import {
  activeSidecarState,
  type PdfSidecar,
  sidecarPath,
  updateSidecarSession,
} from "../pdf/notes_client.ts";
import { safeJsonParse } from "../lib/json.ts";
import type { AppViewState } from "../types/ui.ts";
import { h, render as preactRender } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
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
  // Read by non-React consumers, refreshed every ViewComponent render.
  viewState: AppViewState = {
    allPages: [],
    unsavedChanges: false,
    uiOptions: initialUiOptions,
    showPrompt: false,
    showConfirm: false,
    showSettings: false,
    showContentBrowser: false,
    pdfViewer: null,
  };
  private setters!: Setters;
  private lastPagesSig: string | undefined;

  constructor(private client: Client) {
    installGlobalKeyboard(client, {
      openHistory: () => this.setters.setShowHistory(true),
      openPdfMetadata: () => this.setters.setShowPdfMeta(true),
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
    // The 10s poll usually returns an unchanged list: skip the
    // setAllPages re-render cascade then (the signature covers every
    // field, computed after the lastOpened carry-over).
    const sig = JSON.stringify(allPages);
    if (sig === this.lastPagesSig) return;
    this.lastPagesSig = sig;
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
      showConfirm: modal?.kind === "confirm",
      showSettings,
      showContentBrowser,
      pdfViewer,
    };

    useEffect(() => {
      if (!current) return;
      const fallback = getNameFromPath(current.path);
      // First 1KB only - runs on every save.
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

    useAppearance(uiOptions);

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

    return (
      <>
        {modal?.kind === "prompt" && (
          <Prompt
            message={modal.message}
            defaultValue={modal.defaultValue}
            callback={modal.callback}
          />
        )}
        {modal?.kind === "confirm" && (
          <Confirm message={modal.message} callback={modal.callback} />
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
                client={this.client}
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
                client={this.client}
                id={sid}
                targetPath={sidecarPath(pdfPath)}
                applyRestore={(txt) => {
                  const sc = safeJsonParse<PdfSidecar>(txt);
                  if (sc !== undefined) updateSidecarSession(pdfPath, () => sc);
                }}
                onClose={() => setShowHistory(false)}
                onRestored={() => void this.client.updatePageListCache()}
              />
            );
          })()}
          {showHistory && !pdfViewer && current?.path && current?.meta?.id && (
            <HistoryPanel
              client={this.client}
              id={current.meta.id}
              targetPath={current.path}
              onClose={() => setShowHistory(false)}
              onRestored={() => {
                void this.client.contentManager.loadPage({ path: current.path });
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
