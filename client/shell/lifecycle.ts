import type { ClientContext as Client } from "../core/context.ts";
import type { ClickEvent } from "coconote/type/client";
import {
  addParentPointers,
  findParentMatching,
  nodeAtPos,
  type ParseTree,
} from "coconote/lib/tree";
import { parseToRef } from "../capabilities/links/index.ts";
import { resolveTitle } from "../capabilities/links/index.ts";
import { isInRefs } from "../capabilities/links/index.ts";
import { extractFrontmatter } from "../core/file";
import { parseMarkdown } from "../capabilities/markdown/index.ts";
import { reconfigureMode } from "../features/md-editor";
import type { NavTarget } from "./navigator.ts";

export type Shell = {
  isElectron?: boolean;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Subscribe to OS file-open paths the main process forwards (double-click
   *  / "Open with"). Buffered in preload until the renderer registers, so an
   *  early send during boot isn't lost. */
  onOpenPath?: (cb: (path: string) => void) => void;
  /** electron >= 32 webUtils: the absolute OS path of a dropped File (the
   *  removed File.path replacement), for the drag-into-window open path. */
  getPathForFile?: (file: File) => string;
};

/** The Electron preload bridge, or null in a plain browser. Exported so the
 *  global keyboard handler can reuse the coconote_open_window IPC for the
 *  in-app "new window" shortcut. */
export function electronShell(): Shell | null {
  const w = globalThis as typeof globalThis & { coconoteShell?: Shell };
  return w.coconoteShell?.isElectron ? w.coconoteShell : null;
}

/** Wire the single-slot lifecycle callbacks. Lives here (not in
 *  md-editor's registry) so the dependency stays one-way:
 *  lifecycle -> registry, never back. */
export function wireModuleLifecycle(c: Client): void {
  c.onEditorInit = () => setEditorMode(c);
  c.onPageClick = (e: ClickEvent) => clickNavigate(c, e);
}

async function setEditorMode(c: Client) {
  // setting.md Dark mode: "Follows OS preference on first run." When
  // localStorage/yaml haven't seeded the choice yet, consult
  // prefers-color-scheme so the very first paint matches the OS.
  let darkMode = c.config.get<boolean | null>(["ui", "darkMode"], null);
  if (darkMode == null) {
    try {
      const raw = localStorage.getItem("coconote.darkMode");
      if (raw === "1" || raw === "0") {
        darkMode = raw === "1";
      } else if (typeof matchMedia === "function") {
        darkMode = matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch {/* private browsing - fall through */}
  }
  if (darkMode != null) c.setUiOption("darkMode", darkMode);
  const mode = c.config.get<string | null>(["ui", "editorMode"], null);
  if (mode === "read" || mode === "source" || mode === "render") {
    c.setUiOption("editorMode", mode);
    reconfigureMode(c);
  }
  const fontSize = c.config.get<number | null>(["ui", "fontSize"], null);
  if (fontSize != null) c.setUiOption("fontSize", fontSize);
  const editorWidth = c.config.get<number | null>(["ui", "editorWidth"], null);
  if (editorWidth != null) c.setUiOption("editorWidth", editorWidth);
  for (
    const k of [
      "accentColor",
      "highlightColor",
      "linkMissingColor",
      "codeBackgroundColor",
      "hoverBackgroundColor",
      "fontText",
      "fontInterface",
      "fontMonospace",
      "snippets",
    ] as const
  ) {
    const v = c.config.get<string | null>(["ui", k], null);
    if (v != null) c.setUiOption(k, v);
  }
}

function isExternalURL(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function actionFollow(
  c: Client,
  mdTree: ParseTree | null,
) {
  if (!mdTree) return;
  // Only WikiLinks navigate - md inline links/autolinks/naked URLs are inert.
  if (mdTree.type !== "WikiLink") {
    mdTree = findParentMatching(mdTree, (t) => t.type === "WikiLink");
    if (!mdTree) return;
  }
  const link = mdTree.children?.[1]?.children?.[0]?.text;
  if (!link) return;
  if (isExternalURL(link)) {
    return c.openUrl(link);
  }
  const ref = parseToRef(link);
  if (!ref) {
    console.error(`Couldn't navigate to ${link}, WikiLink invalid`);
    return;
  }
  let target: NavTarget;
  if (ref.title === "") {
    // In-page jump (e.g. [[#heading]]) - always allowed, current file.
    target = { id: c.currentId(), details: ref.details };
  } else {
    // SPEC links: resolve the title to an id, then gate on the current
    // file's frontmatter `refs` (id list). Ambiguous / missing / not in
    // refs are not jumpable.
    const resolved = resolveTitle(ref.title, c.ui.viewState.allPages);
    if (resolved.state !== "hit") {
      console.error(`Link "${link}" is ${resolved.state} - blocked`);
      return;
    }
    const refs = extractFrontmatter(c.editorView.state.sliceDoc(0, 4096)).refs;
    if (!isInRefs(resolved.id, refs)) {
      console.error(`Link "${link}" is not in this file's refs - blocked`);
      return;
    }
    target = { id: resolved.id, title: ref.title, details: ref.details };
  }
  if (!target.id) return;
  return c.navigate(target, false);
}

async function clickNavigate(c: Client, event: ClickEvent) {
  if (event.altKey) return;
  const text = c.editorView.state.sliceDoc();
  const mdTree = parseMarkdown(text);
  addParentPointers(mdTree);
  await actionFollow(c, nodeAtPos(mdTree, event.pos));
}
