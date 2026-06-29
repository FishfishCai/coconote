import { type EditorView, type PluginValue, ViewPlugin } from "@codemirror/view";
import {
  isInRefs,
  isPdfId,
  parseToRef,
  resolveTitle,
  sliceByRef,
} from "../../../../capabilities/links/index.ts";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
import type { ConfigCtx } from "../../../../core/ctx/config.ts";
type Client = EditorCtx & UICtx & SpaceCtx & ConfigCtx;
import {
  extractFrontmatter,
  parseSidecar,
  SIDECAR_ASSET,
  stripFrontmatter,
} from "../../../../core/file";
import {
  htmlEscapeAttr,
  parseMarkdown,
  renderMarkdownToHtml,
} from "../../../../capabilities/markdown/index.ts";
import { buildWikiLinkTitle } from "../../../../capabilities/links/index.ts";

const HOVER_DELAY_MS = 500;
const HIDE_DELAY_MS = 100;
const GAP_PX = 6;
const POPUP_CLASS = "coconote-hover-preview";
const RENDER_CACHE_LIMIT = 32;

export function hoverPreviewPlugin(client: Client) {
  return ViewPlugin.fromClass(
    class HoverPreview implements PluginValue {
      popup: HTMLDivElement | null = null;
      showTimer: number | null = null;
      hideTimer: number | null = null;
      currentLink: HTMLElement | null = null;
      // Invalidated on allPages identity change so cache can't outlive
      // its source page list.
      renderCache = new Map<string, string>();
      lastAllPagesRef: unknown = client.ui.viewState.allPages;

      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("mouseover", this.onMouseOver);
        view.scrollDOM.addEventListener("mouseout", this.onMouseOut);
      }

      destroy() {
        this.view.scrollDOM.removeEventListener("mouseover", this.onMouseOver);
        this.view.scrollDOM.removeEventListener("mouseout", this.onMouseOut);
        this.hidePopup();
      }

      onMouseOver = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const link = target.closest(".coconote-wiki-link") as HTMLElement | null;
        if (!link) return;
        if (
          link.classList.contains("coconote-wiki-link-missing") ||
          link.classList.contains("coconote-wiki-link-invalid")
        ) return;
        if (link === this.currentLink) {
          if (this.hideTimer !== null) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
          }
          return;
        }
        this.cancelTimers();
        this.currentLink = link;
        const stringRef = link.dataset.sbStringref;
        if (!stringRef) return;
        this.showTimer = window.setTimeout(() => {
          this.showTimer = null;
          void this.showPreview(link, stringRef);
        }, HOVER_DELAY_MS);
      };

      onMouseOut = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const link = target.closest(".coconote-wiki-link") as HTMLElement | null;
        if (!link || link !== this.currentLink) return;
        const related = e.relatedTarget as HTMLElement | null;
        if (this.popup && related && this.popup.contains(related)) return;
        this.scheduleHide();
      };

      cancelTimers() {
        if (this.showTimer !== null) {
          clearTimeout(this.showTimer);
          this.showTimer = null;
        }
        if (this.hideTimer !== null) {
          clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
      }

      scheduleHide() {
        if (this.showTimer !== null) {
          clearTimeout(this.showTimer);
          this.showTimer = null;
        }
        if (this.hideTimer !== null) clearTimeout(this.hideTimer);
        this.hideTimer = window.setTimeout(
          () => this.hidePopup(),
          HIDE_DELAY_MS,
        );
      }

      hidePopup() {
        this.cancelTimers();
        if (this.popup) {
          this.popup.remove();
          this.popup = null;
        }
        this.currentLink = null;
      }

      async showPreview(link: HTMLElement, stringRef: string) {
        const html = await this.renderTarget(stringRef);
        if (this.currentLink !== link) return;
        if (!html) return;
        this.mountPopup(link, html);
      }

      mountPopup(link: HTMLElement, html: string) {
        if (this.popup) this.popup.remove();
        const popup = document.createElement("div");
        popup.className = POPUP_CLASS;

        // Width = editor content column, so preview reads 1:1 with the
        // target page's own layout.
        const linkRect = link.getBoundingClientRect();
        const contentRect = this.view.contentDOM.getBoundingClientRect();
        const top = linkRect.bottom + GAP_PX;
        const maxHeight = Math.max(80, window.innerHeight - top - 8);

        popup.style.left = `${contentRect.left}px`;
        popup.style.top = `${top}px`;
        popup.style.width = `${contentRect.width}px`;
        popup.style.maxHeight = `${maxHeight}px`;

        popup.addEventListener("mouseenter", () => {
          if (this.hideTimer !== null) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
          }
        });
        popup.addEventListener("mouseleave", () => this.scheduleHide());

        const content = document.createElement("div");
        content.className = "coconote-hover-preview-content";
        content.innerHTML = html;
        popup.appendChild(content);

        document.body.appendChild(popup);
        this.popup = popup;
      }

      // MainUI.updatePageList replaces allPages on every refresh, so
      // identity change => a page may have been edited/renamed.
      private maybeInvalidateCache() {
        const cur = client.ui.viewState.allPages;
        if (cur !== this.lastAllPagesRef) {
          this.renderCache.clear();
          this.lastAllPagesRef = cur;
        }
      }

      async renderTarget(stringRef: string): Promise<string | null> {
        this.maybeInvalidateCache();

        const ref = parseToRef(stringRef);
        if (!ref) return null;
        const pages = client.ui.viewState.allPages;

        // Resolve the target id (current page when the title is omitted).
        let targetId: string;
        if (ref.title === "") {
          targetId = client.currentId();
        } else {
          const resolved = resolveTitle(ref.title, pages);
          if (resolved.state !== "hit") return null;
          // SPEC: only preview targets reachable through this file's refs.
          const refs = extractFrontmatter(
            this.view.state.sliceDoc(0, 4096),
          ).refs;
          if (!isInRefs(resolved.id, refs)) return null;
          targetId = resolved.id;
        }
        if (!targetId) return null;

        // PDF anchor card (page + excerpt + comments).
        if (ref.details?.type === "pdfAnchor" && isPdfId(targetId, pages)) {
          const html = await renderPdfAnchorPreview(
            client,
            targetId,
            ref.details.anchor,
          );
          if (html !== null) return html;
        }

        const isSelfRef = targetId === client.currentId();

        // Self-refs skip the cache - buffer mutates per keystroke and the
        // cache invalidator only fires on allPages flips.
        const cacheKey = isSelfRef ? null : stringRef;
        if (cacheKey) {
          const cached = this.renderCache.get(cacheKey);
          if (cached !== undefined) return cached;
        }

        let pageText: string;
        try {
          pageText = isSelfRef
            ? this.view.state.sliceDoc(0)
            : (await client.space.readPage(targetId)).text;
        } catch {
          return null;
        }

        pageText = stripFrontmatter(pageText).body;

        const sliced =
          ref.details && ref.details.type !== "pdfAnchor"
            ? sliceByRef(pageText, ref.details)?.text ?? ""
            : pageText;
        if (!sliced.trim()) return null;

        const tree = parseMarkdown(sliced);
        const html = renderMarkdownToHtml(tree, {
          // SPEC: a wikilink chip shows the target's current title.
          wikiLinkTitle: buildWikiLinkTitle(client),
          // Local image embeds resolve against the TARGET file's assets.
          assetOwnerId: targetId,
        });

        if (cacheKey) {
          this.renderCache.set(cacheKey, html);
          if (this.renderCache.size > RENDER_CACHE_LIMIT) {
            const oldest = this.renderCache.keys().next().value;
            if (oldest !== undefined) this.renderCache.delete(oldest);
          }
        }
        return html;
      }
    },
  );
}

// Load the PDF's sidecar (by id + path-derived stem), locate the named
// highlight, and emit a tiny HTML card (page number + highlight text +
// first comment). Returns null when the PDF or anchor doesn't resolve.
async function renderPdfAnchorPreview(
  client: Client,
  pdfId: string,
  anchor: string,
): Promise<string | null> {
  try {
    // Read the TARGET pdf's sidecar directly by id via core/transport + the
    // core parse - no edge into the pdf feature for a cross-file %name
    // preview. @sidecar addresses it without a path.
    const { data } = await client.httpSpacePrimitives.readFile({
      id: pdfId,
      asset: SIDECAR_ASSET,
    });
    const notes = parseSidecar(new TextDecoder().decode(data));
    const a = notes.anchors.find((x) => x.name === anchor);
    if (!a) return null;
    const h = notes.highlights.find((x) => x.id === a.highlightId);
    if (!h) return null;
    const cs = notes.comments.filter((c) => c.highlightId === a.highlightId);
    const lines: string[] = [
      `<div class="coconote-pdf-anchor-card">`,
      `  <div class="coconote-pdf-anchor-name">%${htmlEscapeAttr(anchor)} &middot; page ${h.page}</div>`,
      `  <blockquote>${htmlEscapeAttr(h.text.slice(0, 400))}${
        h.text.length > 400 ? "..." : ""
      }</blockquote>`,
    ];
    for (const c of cs) {
      lines.push(
        `  <div class="coconote-pdf-anchor-comment">${htmlEscapeAttr(c.body)}</div>`,
      );
    }
    lines.push(`</div>`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
