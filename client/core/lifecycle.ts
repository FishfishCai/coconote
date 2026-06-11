import type { ClientContext as Client } from "./context.ts";
import type { ClickEvent } from "coconote/type/client";
import {
  addParentPointers,
  findParentMatching,
  nodeAtPos,
  type ParseTree,
} from "coconote/lib/tree";
import { encodePageURI, encodeRef, parseToRef } from "coconote/lib/ref";
import { resolveWikiLink } from "../lib/wikilink.ts";
import { parseMarkdown } from "../markdown/parser/parser.ts";
import { reconfigureMode } from "../codemirror/registry.ts";

/** Wire the single-slot lifecycle callbacks. Lives here (not in
 *  codemirror/registry.ts) so the dependency stays one-way:
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
  newTab = false,
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
  if (ref.path === "") {
    ref.path = c.currentPath();
  } else if (ref.path.toLowerCase().endsWith(".pdf")) {
    // PDF wikilinks skip resolveWikiLink (md-only) - navigator does its own allKnownFiles lookup.
  } else {
    const query = ref.path.endsWith(".md")
      ? ref.path.slice(0, -3)
      : ref.path;
    const result = resolveWikiLink(query, c.ui.viewState.allPages);
    if (result.kind === "ok") {
      ref.path = (result.page.name + ".md") as typeof ref.path;
    } else if (result.kind === "ambiguous") {
      console.error(
        `Ambiguous link "${link}": ${
          result.pages.map((p) => p.name).join(", ")
        }`,
      );
      return;
    } else {
      console.error(`No page matches "${link}"`);
      return;
    }
  }
  // editor.md: Cmd/Ctrl+Click opens the link in a new tab (browser) /
  // new window (desktop shell). External URLs above already open one.
  if (newTab) {
    const url = `${document.baseURI}${encodePageURI(encodeRef(ref))}`;
    const win = globalThis.open(url, "_blank");
    if (win) win.focus();
    return;
  }
  return c.navigate(ref, false);
}

async function clickNavigate(c: Client, event: ClickEvent) {
  if (event.altKey) return;
  const text = c.editorView.state.sliceDoc();
  const mdTree = parseMarkdown(text);
  addParentPointers(mdTree);
  await actionFollow(c, nodeAtPos(mdTree, event.pos), event.newTab === true);
}
