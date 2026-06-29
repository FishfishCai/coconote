import { Confirm, Prompt } from "../core/ui";
import { SyncModal } from "../features/sync";
import { CollabStatusDot } from "./collab_status_dot.tsx";
import { ModeDot } from "./mode_dot.tsx";
import { RecentList } from "../features/recent";
import { GraphOverlay } from "../features/graph";
import { HistoryPanel } from "../features/history";
import { Settings, useAppearance } from "../features/settings";
import {
  activeSidecarState,
  emptySidecar,
  parseSidecar,
  PdfMetadataPanel,
  PdfViewer,
  serializeSidecar,
  updateSidecarSession,
} from "../features/pdf";
import type { AppViewState } from "../types/ui.ts";
import { h, render as preactRender } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import type { Path } from "../core/util";
import { installGlobalKeyboard } from "./keyboard.ts";
import type { PageMeta } from "coconote/type/page";
import { extractFrontmatter } from "../core/file";
import { getAllShortcuts } from "../core/shortcuts";

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
  | { kind: "sync"; id: string; title: string }
  | null;

type PdfViewerState = { id: string; path: string; anchor?: string } | null;
type Setters = {
  setCurrent(v: CurrentPage | undefined): void;
  setUnsavedChanges(v: boolean): void;
  setAllPages(v: PageMeta[]): void;
  setUiOptions(updater: (prev: UiOptions) => UiOptions): void;
  setModal(v: Modal): void;
  setShowSettings(v: boolean): void;
  setShowRecent(v: boolean): void;
  setShowGraph(v: boolean): void;
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
    showRecent: false,
    pdfViewer: null,
  };
  private setters!: Setters;
  private lastPagesSig: string | undefined;

  constructor(private client: Client) {
    installGlobalKeyboard(client, {
      openHistory: () => this.setters.setShowHistory(true),
      openPdfMetadata: () => this.setters.setShowPdfMeta(true),
      openRecent: () => this.showRecent(),
      openGraph: () => this.setters.setShowGraph(true),
      // push/pull is always for the current page, so resolve the visible
      // file's id/title here and hand it to the merged sync modal (which
      // picks the remote and the direction).
      openPushPull: () => this.openSync(),
    });
  }

  private openSync() {
    // When a PDF is open it is the visible file (current still holds the
    // last markdown page), so the PDF wins as the push/pull target.
    const pv = this.viewState.pdfViewer;
    const id = pv?.id ?? this.viewState.current?.meta.id;
    if (!id) return;
    const title = pv
      ? (pv.path.split("/").pop()?.replace(/\.pdf$/i, "") || pv.id)
      : (this.viewState.current?.meta.title ?? this.client.currentName());
    this.setters.setModal({ kind: "sync", id, title });
  }

  setLoadedPage(meta: PageMeta) {
    this.setters.setCurrent({ path: (meta.path ?? "") as Path, meta });
  }
  markPageChanged() {
    this.setters.setUnsavedChanges(true);
  }
  markPageSaved() {
    this.setters.setUnsavedChanges(false);
  }
  updatePageList(allPages: PageMeta[]) {
    const prevById = new Map(this.viewState.allPages.map((p) => [p.id, p]));
    for (const pm of allPages) {
      const old = prevById.get(pm.id);
      if (old?.lastOpened) pm.lastOpened = old.lastOpened;
    }
    // A rebuild often returns an unchanged list: skip the setAllPages
    // re-render cascade then (the signature covers every field, computed
    // after the lastOpened carry-over).
    const sig = JSON.stringify(allPages);
    if (sig === this.lastPagesSig) return;
    this.lastPagesSig = sig;
    this.setters.setAllPages(allPages);
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
  showRecent() {
    this.setters.setShowRecent(true);
  }
  hideRecent() {
    this.setters.setShowRecent(false);
  }
  showHistory() {
    this.setters.setShowHistory(true);
  }
  hideHistory() {
    this.setters.setShowHistory(false);
  }
  showPdfViewer(id: string, path?: string, anchor?: string) {
    this.setters.setPdfViewer({ id, path: path ?? "", anchor });
    this.setters.setShowSettings(false);
    this.setters.setShowRecent(false);
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
    const [showRecent, setShowRecent] = useState(false);
    const [showGraph, setShowGraph] = useState(false);
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
      setShowRecent,
      setShowGraph,
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
      showRecent,
      pdfViewer,
    };

    useEffect(() => {
      if (!current) return;
      const fallback = current.meta.title ?? this.client.currentName();
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
      void import("../features/md-editor/plugins/snippets/snippets.ts").then((m) => {
        m.invalidateSnippetsCache();
        this.client.rebuildEditorState();
      });
    }, [uiOptions.snippets]);

    // Shown in the empty state so the hint matches the user's real binding.
    const recentKey = getAllShortcuts().openRecent.replace(
      "Mod",
      /Mac|iP(hone|ad|od)/i.test(navigator.platform) ? "Cmd" : "Ctrl",
    );
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
          <Confirm
            message={modal.message}
            callback={modal.callback}
          />
        )}
        {modal?.kind === "sync" && (
          <SyncModal
            client={this.client}
            fileId={modal.id}
            title={modal.title}
            onClose={() => setModal(null)}
          />
        )}
        <div id="coconote-content">
          {/* 32px draggable strip for Electron's hidden-inset title bar
              (-webkit-app-region: drag in the CSS). Inert in a browser. */}
          <div className="coconote-window-drag" />
          <ModeDot
            mode={uiOptions.editorMode}
            isMarkdownEditor={!pdfViewer && !!current}
          />
          <CollabStatusDot client={this.client} />
          <div id="coconote-main">
            <div
              id="coconote-editor"
              style={(pdfViewer || !current) ? { display: "none" } : undefined}
            />
            {!pdfViewer && !current && (
              // Nothing open: a quiet, non-editable prompt instead of a blank
              // editable canvas. The editor above is hidden in this state.
              <div className="coconote-empty-state">
                <p>
                  Press <kbd>{recentKey}</kbd> to open recent
                </p>
                <p className="coconote-empty-state-sub">or drop a file here</p>
              </div>
            )}
            {pdfViewer && (
              <PdfViewer
                // Key by id only: an in-document %anchor jump must
                // scroll the mounted viewer (anchorScrolledRef), not
                // remount + re-render the whole PDF.
                key={pdfViewer.id}
                client={this.client}
                pdfId={pdfViewer.id}
                initialAnchor={pdfViewer.anchor}
              />
            )}
          </div>
          {/* Setting is a modal overlay like recent/history (shares the one
              Modal base): the editor / pdf pane stays mounted underneath. */}
          {showSettings && (
            <Settings
              client={this.client}
              uiOptions={uiOptions}
              onClose={() => setShowSettings(false)}
            />
          )}
          {showRecent && (
            <RecentList
              client={this.client}
              onClose={() => setShowRecent(false)}
            />
          )}
          {showGraph && (pdfViewer || current?.meta) && (
            <GraphOverlay
              client={this.client}
              // A pdf is a linkable file with backrefs, so the graph opens
              // for the visible pdf too (it wins over the last md page).
              startId={pdfViewer ? pdfViewer.id : current!.meta.id}
              onClose={() => setShowGraph(false)}
            />
          )}
          {showHistory && pdfViewer && (
            <HistoryPanel
              client={this.client}
              targetId={pdfViewer.id}
              // Diff the selected snapshot against the live sidecar json
              // (GET /.file?id=<pdf> would return the pdf binary).
              currentText={() =>
                serializeSidecar(activeSidecarState(pdfViewer.id) ?? emptySidecar())}
              applyRestore={(txt) => {
                // Restore flows through the live room so the open session and
                // disk stay coherent (a raw disk restore would be clobbered
                // by the next checkpoint). updateSidecarSession keys by id.
                updateSidecarSession(pdfViewer.id, () => parseSidecar(txt));
              }}
              onClose={() => setShowHistory(false)}
              onRestored={() => void this.client.updatePageListCache()}
            />
          )}
          {showHistory && !pdfViewer && current?.meta && (
            <HistoryPanel
              client={this.client}
              targetId={current.meta.id}
              onClose={() => setShowHistory(false)}
              onRestored={() => {
                void this.client.contentManager.loadPage({ id: current.meta.id });
              }}
            />
          )}
          {showPdfMeta && pdfViewer && (
            <PdfMetadataPanel
              client={this.client}
              pdfId={pdfViewer.id}
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
