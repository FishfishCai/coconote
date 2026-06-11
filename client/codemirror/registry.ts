// Not a plugin host: the editor doesn't load third-party code. Adding
// a new editor feature means editing this file directly.
//
// `BASE_EXTENSIONS` are always active. `RENDER_MODE_EXTENSIONS` are
// installed only in `render` / `read` mode, `source` mode drops them.

import { Compartment, type Extension } from "@codemirror/state";
import type { ClientContext as Client } from "../core/context.ts";
import { editModeExtensionsFor } from "./editor_state.ts";
import { cleanWikiLinkPlugin } from "./plugins/links/wiki_link.ts";
import { frontmatterPlugin } from "./plugins/markdown/frontmatter.ts";
import { hideMarksPlugin } from "./plugins/markdown/hide_marks.ts";
import { horizontalRulePlugin } from "./plugins/markdown/horizontal_rule.ts";
import { listBulletPlugin } from "./plugins/markdown/list.ts";
import { cleanEscapePlugin } from "./plugins/markdown/escapes.ts";
import { inlineContentPlugin } from "./plugins/embedded/inline_content.ts";
import { calloutPlugin } from "./plugins/embedded/callout/plugin.ts";
import { hoverPreviewPlugin } from "./plugins/hover/hover_preview.ts";
import { lineWrapper } from "./plugins/meta/line_wrapper.ts";
import { wikiCompletionPlugin } from "./plugins/autocomplete/wiki_complete.ts";
import { snippetsPlugin } from "./plugins/snippets/snippets.ts";

// markdown.md: only 4 heading levels are part of the spec.
const LINE_CLASSES = [
  { selector: "ATXHeading1", class: "coconote-line-h1" },
  { selector: "ATXHeading2", class: "coconote-line-h2" },
  { selector: "ATXHeading3", class: "coconote-line-h3" },
  { selector: "ATXHeading4", class: "coconote-line-h4" },
  { selector: "ListItem", class: "coconote-line-li", nesting: true },
  { selector: "Blockquote", class: "coconote-line-blockquote" },
  { selector: "CodeBlock", class: "coconote-line-code" },
  { selector: "FencedCode", class: "coconote-line-fenced-code" },
  { selector: "BulletList", class: "coconote-line-ul" },
  { selector: "OrderedList", class: "coconote-line-ol" },
];
const BASE_EXTENSIONS: Array<(c: Client) => Extension[]> = [
  () => [lineWrapper(LINE_CLASSES)],
  (c) => [snippetsPlugin(c)],
];

const RENDER_MODE_EXTENSIONS: Array<(c: Client) => Extension[]> = [
  (c) => [frontmatterPlugin(c)],
  (c) => [cleanWikiLinkPlugin(c)],
  (c) => [wikiCompletionPlugin(c)],
  (c) => [inlineContentPlugin(c)],
  () => [calloutPlugin()],
  (c) => [hoverPreviewPlugin(c)],
  () => [hideMarksPlugin()],
  () => [horizontalRulePlugin()],
  () => [listBulletPlugin()],
  () => [cleanEscapePlugin()],
];

function currentMode(client: Client): "read" | "source" | "render" {
  return client.config.get<string>(
    ["ui", "editorMode"],
    "render",
  ) as "read" | "source" | "render";
}

function renderModeExtensionsFor(client: Client): Extension[] {
  if (currentMode(client) === "source") return [];
  return RENDER_MODE_EXTENSIONS.flatMap((f) => f(client));
}

export function collectModuleExtensions(client: Client): Extension[] {
  // Compartment reused across rebuilds - recreating it would detach
  // reconfigureMode from the live view.
  if (!client.renderModeCompartment) {
    client.renderModeCompartment = new Compartment();
  }
  return [
    client.renderModeCompartment.of(renderModeExtensionsFor(client)),
    ...BASE_EXTENSIONS.flatMap((f) => f(client)),
  ];
}

// Switches editor mode WITHOUT rebuilding state - keeps undo history,
// scroll position, widget state and selection intact.
export function reconfigureMode(client: Client): void {
  client.editorView.dispatch({
    effects: [
      client.renderModeCompartment.reconfigure(renderModeExtensionsFor(client)),
      client.editModeCompartment.reconfigure(
        editModeExtensionsFor(
          client,
          client.currentPageMeta()?.perm === "ro",
          currentMode(client),
        ),
      ),
    ],
  });
}
