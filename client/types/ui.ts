import type { PageMeta } from "coconote/type/page";
import type { Path } from "coconote/lib/ref";

// Read by non-React consumers via `ui.viewState`, mutations must go through MainUI.
export type AppViewState = {
  current?: { path: Path; meta: PageMeta };
  allPages: PageMeta[];
  unsavedChanges: boolean;
  uiOptions: {
    darkMode?: boolean;
    /**
     * read   = render-only, not editable, cursor hidden, widgets always unfolded
     * source = raw markdown, no widget rendering at all
     * render = default editing experience: widgets unfold under cursor
     */
    editorMode: EditorMode;
    fontSize: number;
    editorWidth: number;
    /** Empty string = default token from theme.scss, drives the accent ramp. */
    accentColor: string;
    highlightColor: string;
    linkMissingColor: string;
    codeBackgroundColor: string;
    /** Row-hover tint used in Settings + similar list rows. */
    hoverBackgroundColor: string;
    /** font-family stacks, empty = theme default. */
    fontText: string;
    fontInterface: string;
    fontMonospace: string;
    /** Raw JSON for the snippet list (LaTeX-suite shape). */
    snippets: string;
  };
  showPrompt: boolean;
  showConfirm: boolean;
  showSettings: boolean;
  showContentBrowser: boolean;
  /** PDF viewer state (path + optional anchor), null when no PDF is
   *  open. Read by keyboard.ts to gate the metadata-panel shortcut. */
  pdfViewer: { path: string; anchor?: string } | null;
};

export type EditorMode = "read" | "source" | "render";

// Shape of GET /.config consumed at boot (server-rs handlers/config.rs).
export type BootConfig = {
  readOnly: boolean;
  /** Raw text of snippet.json on disk (editor.md Snippet, same lookup
   *  path as coconote.yaml). Empty when the file isn't present. */
  snippets?: string;
};
