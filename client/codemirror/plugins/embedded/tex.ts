import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import katex from "katex";
import type {
  ClientContext as Client,
  EditorCtx,
  NavigationCtx,
} from "../../../core/context.ts";
import {
  invisibleDecoration,
  isCursorInRange,
} from "../../util/util.ts";
import {
  attachWidgetEventHandlers,
  CachedWidget,
  measureAndCacheWidgetHeight,
} from "../../util/widget_util.ts";

class TexWidget extends CachedWidget<EditorCtx & NavigationCtx> {
  readonly cacheKey: string;
  constructor(
    readonly tex: string,
    readonly displayMode: boolean,
    client: Client,
    readonly sourceText: string,
  ) {
    super(client);
    this.cacheKey = `tex:${displayMode ? "block" : "inline"}:${tex}`;
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.displayMode ? "div" : "span");
    el.className = this.displayMode ? "coconote-tex-display" : "coconote-tex-inline";
    try {
      katex.render(this.tex, el, {
        displayMode: this.displayMode,
        throwOnError: false,
        output: "html",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      el.textContent = `[TeX error: ${msg}]`;
      el.classList.add("coconote-tex-error");
    }
    attachWidgetEventHandlers(el, this.ctx, this.sourceText);
    // Skip when alt is held so attachWidgetEventHandlers' alt+click wins.
    el.addEventListener("mousedown", ((e: MouseEvent) => {
      if (e.altKey) return;
      const view = this.ctx.editorView;
      if (!view) return;
      e.preventDefault();
      e.stopPropagation();
      const from = view.posAtDOM(el);
      const delimLen = this.displayMode ? 2 : 1;
      const innerFrom = from + delimLen;
      const rect = el.getBoundingClientRect();
      const xRatio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)),
      );
      let ratio = xRatio;
      if (this.displayMode) {
        const yRatio = Math.max(
          0,
          Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)),
        );
        ratio = (xRatio + yRatio) / 2;
      }
      const target = innerFrom + Math.round(ratio * this.tex.length);
      view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
      this.ctx.focus();
    }) as EventListener);
    if (this.displayMode) {
      measureAndCacheWidgetHeight(this.ctx, el, this.cacheKey, false);
    }
    return el;
  }
}

// Mask code spans before regex-scanning so `$` inside code isn't
// paired with body math.
export function scanMath(
  state: EditorState,
  widgets: Range<Decoration>[],
  client: Client,
  skipRanges: Array<[number, number]>,
): void {
  const docText = state.doc.toString();
  let scanText = docText;
  for (const [s, e] of skipRanges) {
    scanText = scanText.slice(0, s) + " ".repeat(e - s) + scanText.slice(e);
  }
  const inSkip = (from: number, to: number) =>
    skipRanges.some(([s, e]) => from < e && to > s);
  const takenBlock: Array<[number, number]> = [];

  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(scanText)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (inSkip(from, to)) continue;
    if (isCursorInRange(state, [from, to])) continue;
    // Multi-line invisibleDecoration over the whole `$$..$$` range paired
    // with an inline widget (`block: false, side: -1`). CM treats the
    // widget's <div> as the only content of the merged cm-line so DOM
    // height = widget height — heightMap and DOM stay in lock-step.
    widgets.push(invisibleDecoration.range(from, to));
    widgets.push(
      Decoration.widget({
        widget: new TexWidget(m[1].trim(), true, client, m[0]),
        block: false,
        side: -1,
      }).range(from),
    );
    takenBlock.push([from, to]);
  }

  const inlineRe = /(?<![$\\])\$([^$\n]+?)\$(?!\$)/g;
  while ((m = inlineRe.exec(scanText)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (inSkip(from, to)) continue;
    if (takenBlock.some(([s, e]) => from < e && to > s)) continue;
    if (isCursorInRange(state, [from, to])) continue;
    widgets.push(
      Decoration.replace({
        widget: new TexWidget(m[1], false, client, m[0]),
      }).range(from, to),
    );
  }
}
