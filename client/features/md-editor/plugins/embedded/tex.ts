import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import katex from "katex";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { NavigationCtx } from "../../../../core/ctx/navigation.ts";
type Client = EditorCtx & NavigationCtx;
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

  // Display math is routinely 40-90px; seed the heightMap taller than
  // CachedWidget's 24 default so off-screen blocks don't undershoot and jump
  // the viewport as they scroll into view and get measured.
  override get estimatedHeight(): number {
    return this.ctx.widgetMeta.get(this.cacheKey)?.height ??
      (this.displayMode ? 44 : 24);
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
      // this.tex was trimmed but innerFrom points at the untrimmed content
      // start, so skip the leading whitespace the trim dropped before mapping.
      const inner = this.sourceText.slice(
        delimLen,
        this.sourceText.length - delimLen,
      );
      const leadingWs = inner.length - inner.trimStart().length;
      const target = innerFrom + leadingWs +
        Math.round(ratio * this.tex.length);
      view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
      this.ctx.focus();
    }) as EventListener);
    if (this.displayMode) {
      measureAndCacheWidgetHeight(this.ctx, el, this.cacheKey, false);
    }
    return el;
  }
}

type RawMath = { from: number; to: number; inner: string; source: string };

// The doc->string + two regex passes are the expensive part of scanning, so
// cache them keyed by the IMMUTABLE doc: a cursor-only transaction (arrow
// keys, clicks) reuses the scan and only re-runs the cheap isCursorInRange
// reveal below, instead of re-stringifying + re-scanning the whole document.
let scanCache:
  | { doc: EditorState["doc"]; blocks: RawMath[]; inlines: RawMath[] }
  | null = null;

export function scanMath(
  state: EditorState,
  widgets: Range<Decoration>[],
  client: Client,
  skipRanges: Array<[number, number]>,
): void {
  if (!scanCache || scanCache.doc !== state.doc) {
    const docText = state.doc.toString();
    let scanText = docText;
    if (skipRanges.length > 0) {
      // Single pass: blank every skipped range with spaces (same length, so
      // offsets stay aligned). Ranges may nest (FencedCode + its inner
      // CodeText), hence the sort + clamp. Code spans are masked so a `$`
      // inside code isn't paired with body math.
      const sorted = [...skipRanges].sort((a, b) => a[0] - b[0]);
      const parts: string[] = [];
      let cursor = 0;
      for (const [s, e] of sorted) {
        const from = Math.max(s, cursor);
        const to = Math.max(e, from);
        parts.push(docText.slice(cursor, from), " ".repeat(to - from));
        cursor = to;
      }
      parts.push(docText.slice(cursor));
      scanText = parts.join("");
    }
    const inSkip = (from: number, to: number) =>
      skipRanges.some(([s, e]) => from < e && to > s);
    const blocks: RawMath[] = [];
    const inlines: RawMath[] = [];
    let m: RegExpExecArray | null;

    const blockRe = /\$\$([\s\S]+?)\$\$/g;
    while ((m = blockRe.exec(scanText)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      if (inSkip(from, to)) continue;
      blocks.push({ from, to, inner: m[1].trim(), source: m[0] });
    }

    // Pandoc-style inline math so prose with dollar amounts is not paired into
    // math: the opening `$` must be followed by a non-space, the closing `$`
    // preceded by a non-space and not followed by a digit. "it costs $5 and
    // $10" therefore stays plain text (the second `$` is space-preceded).
    const inlineRe = /(?<![$\\])\$(?=\S)([^\n$]*?\S)\$(?!\d)/g;
    while ((m = inlineRe.exec(scanText)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      if (inSkip(from, to)) continue;
      if (blocks.some((b) => from < b.to && to > b.from)) continue;
      inlines.push({ from, to, inner: m[1], source: m[0] });
    }
    scanCache = { doc: state.doc, blocks, inlines };
  }

  // Cheap per-transaction reveal: a `$$`/`$` range holding the cursor shows
  // its raw source (stays editable); otherwise render the math widget.
  for (const b of scanCache.blocks) {
    if (isCursorInRange(state, [b.from, b.to])) continue;
    // Multi-line invisibleDecoration over the whole `$$..$$` range paired with
    // an inline widget (`block: false, side: -1`). CM treats the widget's
    // <div> as the only content of the merged cm-line so DOM height = widget
    // height - heightMap and DOM stay in lock-step.
    widgets.push(invisibleDecoration.range(b.from, b.to));
    widgets.push(
      Decoration.widget({
        widget: new TexWidget(b.inner, true, client, b.source),
        block: false,
        side: -1,
      }).range(b.from),
    );
  }
  for (const i of scanCache.inlines) {
    if (isCursorInRange(state, [i.from, i.to])) continue;
    widgets.push(
      Decoration.replace({
        widget: new TexWidget(i.inner, false, client, i.source),
      }).range(i.from, i.to),
    );
  }
}
