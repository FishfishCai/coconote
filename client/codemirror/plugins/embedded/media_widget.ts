import type { ClientContext as Client } from "../../../core/context.ts";
import {
  attachWidgetEventHandlers,
  CachedWidget,
  measureAndCacheWidgetHeight,
} from "../../util/widget_util.ts";

export interface MediaWidgetOptions {
  client: Client;
  cacheKey: string;
  /** Anchors the cursor on alt-click and locates the open-edit position. */
  sourceText: string;
  callback: () => Promise<{ html: HTMLElement } | null>;
  containerClass?: string;
}

export class MediaWidget extends CachedWidget {
  readonly cacheKey: string;
  // Images/PDFs/iframes - block widgets, usually >= 120 px. Overshoot
  // is cheap (one transaction settles to actual on render), undershoot
  // creates the "scroll jump" we want to avoid.
  protected override readonly fallbackHeight = 200;

  constructor(readonly opts: MediaWidgetOptions) {
    super(opts.client);
    this.cacheKey = opts.cacheKey;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "coconote-media-wrapper";
    const inner = document.createElement("div");
    if (this.opts.containerClass) {
      inner.className = this.opts.containerClass;
    }
    wrapper.appendChild(inner);

    const cachedMeta = this.opts.client.widgetMeta.get(this.opts.cacheKey);
    if (cachedMeta && cachedMeta.height > 0) {
      inner.style.minHeight = `${cachedMeta.height}px`;
    }

    this.renderContent(inner).catch(console.error);
    return wrapper;
  }

  async renderContent(div: HTMLElement) {
    const content = await this.opts.callback();
    if (!content) {
      div.innerHTML = "";
      div.style.minHeight = "";
      this.opts.client.widgetMeta.delete(this.opts.cacheKey);
      return;
    }

    div.replaceChildren(this.wrapHtml(content.html));
    div.style.minHeight = "";
    attachWidgetEventHandlers(div, this.opts.client, this.opts.sourceText);
    measureAndCacheWidgetHeight(
      this.opts.client, div, this.opts.cacheKey, true,
    );
  }

  private wrapHtml(html: HTMLElement): HTMLElement {
    const container = document.createElement("div");
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(html);
    container.appendChild(content);
    return container;
  }

  override ignoreEvent() {
    return true;
  }
}
