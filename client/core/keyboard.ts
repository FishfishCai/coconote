// Global keyboard wiring. Splits two responsibilities:
//
//  (1) the 6 spec-named rebindable actions (setting.md §Shortcut) —
//      mode switch / open history / pin / PDF metadata / back-to-content
//      / back-prev;
//  (2) bubbling unfocused keystrokes back into the CodeMirror keymap so
//      typing while focus has drifted to a button still does the right
//      thing in the editor.
//
// Lives here, not in MainUI, so the editor shell only re-renders for
// UI state changes; keyboard wiring sets up once at boot and reads
// state through callbacks.

import { runScopeHandlers } from "@codemirror/view";
import type { ClientContext as Client } from "./context.ts";
import { authedFetch } from "../lib/authed_fetch.ts";
import { activeSidecarState } from "../pdf/notes_client.ts";
import { matchShortcut } from "../lib/shortcuts.ts";
import { reconfigureMode } from "../codemirror/registry.ts";

const MODE_CYCLE = ["render", "source", "read"] as const;

export type KeyboardHooks = {
  openHistory(): void;
  openPdfMetadata(): void;
};

export function installGlobalKeyboard(client: Client, hooks: KeyboardHooks) {
  globalThis.addEventListener("keydown", (ev) => {
    // Someone closer to the event (CodeMirror keymaps, a modal) already
    // handled it — never double-fire an action on top.
    if (ev.defaultPrevented) return;
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
    // typing in inputs / the editor; Cmd//Ctrl combos stay global.
    if (inEditable && !ev.metaKey && !ev.ctrlKey) return;
    if (matchShortcut(ev, "modeSwitch")) {
      ev.preventDefault();
      const cur = client.ui.viewState.uiOptions.editorMode;
      const i = MODE_CYCLE.indexOf(cur);
      const next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
      client.setUiOption("editorMode", next);
      reconfigureMode(client);
      return;
    }
    if (matchShortcut(ev, "historyOpen")) {
      // Works for a markdown page or an open PDF (its sidecar).
      if (client.ui.viewState.current?.path || client.ui.viewState.pdfViewer) {
        ev.preventDefault();
        hooks.openHistory();
      }
      return;
    }
    if (matchShortcut(ev, "pinVersion")) {
      const pv = client.ui.viewState.pdfViewer;
      const id = pv
        ? activeSidecarState(pv.path)?.metadata.id
        : client.ui.viewState.current?.meta?.id;
      if (id) {
        ev.preventDefault();
        void authedFetch(`/.history/${encodeURIComponent(id)}/pin`, {
          method: "POST",
        }).catch((e) => console.error(`Pin failed: ${e}`));
      }
      return;
    }
    if (matchShortcut(ev, "pdfMetadataPanel")) {
      // pdf.md §Metadata panel: only active while the PDF viewer is up.
      if (client.ui.viewState.pdfViewer) {
        ev.preventDefault();
        hooks.openPdfMetadata();
      }
      return;
    }
    if (matchShortcut(ev, "backToContent")) {
      ev.preventDefault();
      client.navigateRoute({ kind: "content", view: "path" });
      return;
    }
    if (matchShortcut(ev, "backPrev")) {
      ev.preventDefault();
      globalThis.history.back();
      return;
    }

    // Fall-through: forward editor-scope shortcuts when the editor
    // doesn't have focus but the keystroke wasn't grabbed by a real
    // form control or another editable region. NEVER while an overlay
    // view is shown — the editor is hidden then and still points at the
    // previous page; forwarding Backspace/Enter would silently edit it.
    const vs = client.ui.viewState;
    if (vs.showContentBrowser || vs.showSettings || vs.pdfViewer) return;
    if (!client.editorView) return;
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
    if (!client.editorView) return;
    const target = ev.target as Element | null;
    if (!target || !target.closest?.(".cm-content")) return;
    setTimeout(() => client.editorView.dispatch({}));
  });
}
