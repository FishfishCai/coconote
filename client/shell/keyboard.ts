// Global keyboard wiring: (1) the spec-named rebindable actions
// (setting.md Shortcut), (2) bubbling unfocused keystrokes back into
// the CodeMirror keymap. Lives outside MainUI so it wires once at boot
// and the editor shell only re-renders for UI state changes.

import { runScopeHandlers } from "@codemirror/view";
import type { ClientContext as Client } from "../core/context.ts";
import type { ReaderZoomHandle } from "../core/ctx/editor.ts";
import { getConfig, patchConfig } from "../core/config/index.ts";
import { exportHtml, exportPdfOfPdf } from "../features/export";
import { matchShortcut, zoomDirection } from "../core/shortcuts/index.ts";
import { electronShell } from "./lifecycle.ts";
import { reconfigureMode } from "../features/md-editor";

const MODE_CYCLE = ["render", "source", "read"] as const;

export type KeyboardHooks = {
  openHistory(): void;
  openPdfMetadata(): void;
  openRecent(): void;
  openGraph(): void;
  /** Open the single push / pull flow for the current file; the modal picks
   *  the remote and the direction. design.md folds push + pull into one. */
  openPushPull(): void;
};

/** The file currently shown: an open PDF wins over the last markdown page
 *  (which `current` still holds while a PDF is up). `id` is the addressing
 *  identity, `path` the on-disk hint (may be "" for closure-only files). */
function visibleFile(client: Client): { id: string; path: string } | null {
  const pv = client.ui.viewState.pdfViewer;
  if (pv) return { id: pv.id, path: pv.path };
  const meta = client.ui.viewState.current?.meta;
  if (meta) return { id: meta.id, path: meta.path ?? "" };
  return null;
}

/** Toggle the current file in the config pin list (design.md pinFile):
 *  addPin {id,path} when absent, removePin {id} when already pinned. */
async function togglePinFile(id: string, path: string): Promise<void> {
  const cfg = await getConfig();
  const pinned = (cfg.pin ?? []).some((e) => e.id === id);
  await patchConfig(pinned ? { removePin: id } : { addPin: { id, path } });
}

/** Per-reader zoom. Returns true once the event was a Cmd/Ctrl zoom combo
 *  (always after preventDefault, so native whole-app zoom never fires),
 *  routing to whichever reader is the single active pane. The reserved
 *  combo table + recorder guard live in core/shortcuts (shared with the
 *  settings rebinder). */
function handleZoomKey(ev: KeyboardEvent, client: Client): boolean {
  const dir = zoomDirection(ev);
  if (dir === null) return false;
  ev.preventDefault();
  const vs = client.ui.viewState;
  // A modal overlay (Setting / recent) is a zoom no-op while open (need.txt
  // item 4): the preventDefault above already killed the native whole-app
  // zoom, so just return. The `!showSettings` guard keeps a Setting modal
  // floating over a PDF from zooming it. Otherwise an open PDF takes the
  // keys, else the markdown reader (whose zoom methods live flat on the
  // client: Client.zoomIn / zoomOut / zoomReset).
  let reader: ReaderZoomHandle | undefined;
  if (vs.pdfViewer && !vs.showSettings) reader = client.pdfZoom;
  else if (vs.showSettings || vs.showRecent) return true;
  else reader = client;
  if (dir === 1) reader?.zoomIn();
  else if (dir === -1) reader?.zoomOut();
  else reader?.zoomReset();
  return true;
}

export function installGlobalKeyboard(client: Client, hooks: KeyboardHooks) {
  globalThis.addEventListener("keydown", (ev) => {
    // Someone closer to the event (CodeMirror keymaps, a modal) already
    // handled it - never double-fire an action on top.
    if (ev.defaultPrevented) return;
    // Per-reader zoom. Fixed (non-rebindable) bindings, like undo/copy.
    // We ALWAYS preventDefault these combos in every pane so native
    // Electron/Chromium whole-app zoom never fires - then route to the
    // active reader (Setting / Content are a no-op past the preventDefault).
    if (handleZoomKey(ev, client)) return;
    const target = ev.target as HTMLElement | null;
    const inEditable = !!target && (
      !!target.closest?.(".cm-textfield") ||
      !!target.closest?.(".cm-content") ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    );
    // A modifier-less custom binding (e.g. bare "p") must not hijack
    // typing in inputs / the editor - Cmd/Ctrl combos stay global.
    if (inEditable && !ev.metaKey && !ev.ctrlKey) return;
    if (matchShortcut(ev, "cycleMode")) {
      ev.preventDefault();
      const cur = client.ui.viewState.uiOptions.editorMode;
      const i = MODE_CYCLE.indexOf(cur);
      const next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
      client.setUiOption("editorMode", next);
      reconfigureMode(client);
      return;
    }
    if (matchShortcut(ev, "historyOpen")) {
      // Works for a markdown page or an open PDF (its sidecar history).
      if (visibleFile(client)) {
        ev.preventDefault();
        hooks.openHistory();
      }
      return;
    }
    if (matchShortcut(ev, "pinFile")) {
      // Toggle the current file in the config pin list (design.md pinFile).
      // Stored as {id, path}; removal is by id.
      const file = visibleFile(client);
      if (file) {
        ev.preventDefault();
        void togglePinFile(file.id, file.path).catch((e) =>
          console.error(`Pin toggle failed: ${e}`)
        );
      }
      return;
    }
    if (matchShortcut(ev, "newWindow")) {
      // Open a FRESH window on the empty state, not a copy of this page (an
      // empty path loads the root, which lands on the "press Cmd+P" view).
      // Desktop: route through the preserved coconote_open_window IPC
      // (globalThis.open is denied by the main process). Browser: open root
      // in a new tab.
      ev.preventDefault();
      const shell = electronShell();
      if (shell) {
        void shell.invoke("coconote_open_window", { path: "" })
          .catch((e) => console.error(`New window failed: ${e}`));
      } else {
        globalThis.open(document.baseURI, "_blank");
      }
      return;
    }
    if (matchShortcut(ev, "pdfMetadataPanel")) {
      // pdf.md Metadata panel: only active while the PDF viewer is up.
      if (client.ui.viewState.pdfViewer) {
        ev.preventDefault();
        hooks.openPdfMetadata();
      }
      return;
    }
    if (matchShortcut(ev, "exportPage")) {
      // Export acts on the open page: a PDF downloads with highlights
      // baked in, an md page downloads as self-contained HTML.
      // Inactive on the Content / Setting views.
      const onPage = !client.ui.viewState.showRecent &&
        !client.ui.viewState.showSettings;
      const pv = client.ui.viewState.pdfViewer;
      if (onPage && (pv || client.ui.viewState.current)) {
        ev.preventDefault();
        void (pv
          ? exportPdfOfPdf(client, pv.path)
          : exportHtml(client, client.currentName()))
          .catch((e) => console.error(`Export failed: ${e}`));
      }
      return;
    }
    if (matchShortcut(ev, "openRecent")) {
      ev.preventDefault();
      client.ui.showRecent();
      return;
    }
    if (matchShortcut(ev, "openGraph")) {
      // Relation graph opens for the visible file - a pdf is a linkable
      // file with backrefs too (visibleFile picks the open pdf over the
      // last md page).
      if (visibleFile(client)) {
        ev.preventDefault();
        hooks.openGraph();
      }
      return;
    }
    if (matchShortcut(ev, "pushPull")) {
      // Push / pull the current file to / from a remote instance (design.md
      // sync). One entry point: the modal picks the remote and the
      // direction. Always the current file, so the hook resolves id/title.
      if (visibleFile(client)) {
        ev.preventDefault();
        hooks.openPushPull();
      }
      return;
    }
    if (matchShortcut(ev, "backPrev")) {
      ev.preventDefault();
      globalThis.history.back();
      return;
    }
    if (matchShortcut(ev, "forwardNext")) {
      ev.preventDefault();
      globalThis.history.forward();
      return;
    }
    if (matchShortcut(ev, "openSettings")) {
      // Setting is a modal overlay (like recent), opened by its shortcut -
      // no URL/route, just the open-state.
      ev.preventDefault();
      client.ui.showSettings();
      return;
    }

    // Fall-through: forward editor-scope shortcuts when the editor lacks
    // focus and no editable region grabbed the keystroke. NEVER while an
    // overlay view is shown - the editor is hidden then and still points
    // at the previous page, so forwarding Backspace/Enter would silently
    // edit it.
    const vs = client.ui.viewState;
    if (vs.showRecent || vs.showSettings || vs.pdfViewer) return;
    if (client.editorView.hasFocus) return;
    if (!target || inEditable) return;
    if (runScopeHandlers(client.editorView, ev, "editor")) {
      ev.preventDefault();
    }
  });

  // Force CM dispatch on mouseup inside the editor so selection-driven
  // decorators (math / image widgets that unfold on cursor entry)
  // re-evaluate. Skipped elsewhere to avoid a full reconcile on every
  // chrome click.
  globalThis.addEventListener("mouseup", (ev) => {
    const target = ev.target as Element | null;
    if (!target || !target.closest?.(".cm-content")) return;
    setTimeout(() => client.editorView.dispatch({}));
  });
}
