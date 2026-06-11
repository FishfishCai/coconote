import { WidgetType } from "@codemirror/view";
import type { EditorCtx } from "../../core/context.ts";
import {
  isLocalURL,
  resolveMarkdownLink,
} from "coconote/lib/resolve";

// fallbackHeight seeds CM's heightMap before the widget renders.
// Cache the real height in widgetMeta on first measure so the
// heightMap stays accurate after the initial paint.
export abstract class CachedWidget<Ctx extends EditorCtx = EditorCtx>
  extends WidgetType {
  abstract readonly cacheKey: string;
  /** Per-subclass seed in CSS px. Override for block widgets. */
  protected readonly fallbackHeight: number = 24;
  constructor(readonly ctx: Ctx) {
    super();
  }
  override get estimatedHeight(): number {
    const cached = this.ctx.widgetMeta.get(this.cacheKey)?.height;
    return cached ?? this.fallbackHeight;
  }
  override eq(other: WidgetType): boolean {
    return (
      other instanceof CachedWidget &&
      other.constructor === this.constructor &&
      other.cacheKey === this.cacheKey
    );
  }
}

/** Build a URL translator anchored to a specific page (so cross-page
 *  previews rewrite asset paths against the TARGET page's root).
 *  Defaults to the editor's current page. */
export function buildTranslateUrls(
  ctx: EditorCtx,
  anchorName?: string,
): (url: string) => string {
  return (url: string) => {
    if (isLocalURL(url)) {
      return resolveMarkdownLink(
        anchorName ?? ctx.currentName(),
        decodeURI(url),
      );
    }
    return url;
  };
}

function moveCursorToWidgetStart(
  ctx: EditorCtx,
  widgetDom: HTMLElement,
  widgetText?: string,
) {
  const view = ctx.editorView;
  const pos = view.posAtDOM(widgetDom, 0);

  let anchor = pos;
  if (widgetText) {
    const searchFrom = Math.max(0, pos - widgetText.length);
    const region = view.state.sliceDoc(searchFrom, pos + widgetText.length);
    const idx = region.lastIndexOf(widgetText);
    if (idx !== -1) {
      anchor = searchFrom + idx;
    }
  }

  view.dispatch({ selection: { anchor } });
  ctx.focus();
}

export function attachWidgetEventHandlers(
  div: HTMLElement,
  ctx: EditorCtx,
  widgetText?: string,
) {
  if (!div.dataset.handlersAttached) {
    div.dataset.handlersAttached = "true";
    div.addEventListener("mousedown", (e) => {
      if (e.altKey && widgetText) {
        moveCursorToWidgetStart(ctx, div, widgetText);
        e.preventDefault();
      }
      e.stopPropagation();
    });

    div.addEventListener("mouseup", (e) => {
      e.stopPropagation();
    });
  }
}

// Caches the measured height and nudges CM to re-read estimatedHeight,
// realigning heightMap with the DOM. Skipped during IME composition.
export function measureAndCacheWidgetHeight(
  ctx: EditorCtx,
  dom: HTMLElement,
  cacheKey: string,
  block: boolean,
) {
  setTimeout(() => {
    const view = ctx.editorView;
    if (!view) return;
    // Fast scrolling can unmount the DOM before the async render finishes.
    // Detached node has offsetHeight 0; caching that poisons the next
    // render so the widget renders as a gap.
    if (!dom.isConnected) return;
    const h = dom.offsetHeight;
    if (h <= 0) return;
    const prev = ctx.widgetMeta.get(cacheKey);
    if (prev?.height === h && prev?.block === block) return;
    ctx.widgetMeta.set(cacheKey, { height: h, block });
    if (!view.composing) {
      view.dispatch({ selection: view.state.selection });
    }
  });
}
