import type { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type {
  ClientContext as Client,
  ConfigCtx,
  EditorCtx,
} from "../../../core/context.ts";
import { parseMarkdown } from "../../../markdown/parser/parser.ts";
import { renderMarkdownToHtml } from "../../../markdown/render/markdown_render.ts";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
} from "../../util/util.ts";
import {
  attachWidgetEventHandlers,
  buildTranslateUrls,
  CachedWidget,
  measureAndCacheWidgetHeight,
} from "../../util/widget_util.ts";

class TableWidget extends CachedWidget<EditorCtx & ConfigCtx> {
  readonly cacheKey: string;
  constructor(readonly source: string, client: Client) {
    super(client);
    this.cacheKey = `table:${source}`;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "coconote-table";
    el.innerHTML = renderMarkdownToHtml(parseMarkdown(this.source), {
      shortWikiLinks: this.ctx.config.get("shortWikiLinks", true),
      translateUrls: buildTranslateUrls(this.ctx),
    });
    attachWidgetEventHandlers(el, this.ctx, this.source);
    // Skip when alt is held so attachWidgetEventHandlers' alt+click wins.
    el.addEventListener("mousedown", ((e: MouseEvent) => {
      if (e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const view = this.ctx.editorView;
      const from = view.posAtDOM(el);
      // Map the clicked row to its source line. Body row N sits on
      // source line N + 1 (the delimiter row has no rendered <tr>).
      const tr = (e.target as HTMLElement).closest("tr");
      const lineNo = tr ? (tr.rowIndex === 0 ? 0 : tr.rowIndex + 1) : 0;
      const lines = this.source.split("\n");
      let anchor = from;
      for (let i = 0; i < lineNo && i < lines.length; i++) {
        anchor += lines[i].length + 1;
      }
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.ctx.focus();
    }) as EventListener);
    measureAndCacheWidgetHeight(this.ctx, el, this.cacheKey, false);
    return el;
  }
}

// Render a GFM table as an HTML table, expand to raw source when the
// caret lands inside it for editing.
export function tablePlugin(client: Client) {
  return decoratorStateField((state) => {
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "Table") return;
        if (isCursorInRange(state, [node.from, node.to])) return false;
        // Same shape as block math (tex.ts): multi-line invisible
        // replace plus an inline widget so heightMap and DOM agree.
        widgets.push(invisibleDecoration.range(node.from, node.to));
        widgets.push(
          Decoration.widget({
            widget: new TableWidget(
              state.sliceDoc(node.from, node.to),
              client,
            ),
            block: false,
            side: -1,
          }).range(node.from),
        );
        return false;
      },
    });
    return Decoration.set(widgets, true);
  });
}
