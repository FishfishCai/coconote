// HTML export of a markdown page: render the body through the shared
// renderer, inline every vault image as a data URI, degrade wikilinks, and
// inline the stylesheet + fonts so the single .html file works fully offline.

import type { EditorCtx } from "../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../core/ctx/space.ts";
import type { UICtx } from "../../core/ctx/ui.ts";
import type { ConfigCtx } from "../../core/ctx/config.ts";
type Client = EditorCtx & SpaceCtx & UICtx & ConfigCtx;
import { stripFrontmatter } from "../../core/file";
import { buildWikiLinkTitle } from "../../capabilities/links/index.ts";
import { parseMarkdown } from "../../capabilities/markdown/index.ts";
import { renderMarkdownToHtml } from "../../capabilities/markdown/index.ts";
import { authedFetch } from "../../core/transport";
import {
  exportDocumentHtml,
  inlineWoff2,
  renderExportBody,
  slugify,
} from "./core.ts";
import { basename } from "../../core/util";
import mime from "mime";
import { saveBlobAs } from "./blob.ts";

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Render the page body to HTML: markdown through the shared renderer,
 *  callouts through the shared export wrapper (export_core.ts). Local image
 *  embeds resolve against the current file's id. */
function renderBodyHtml(client: Client, body: string): string {
  const ownerId = client.currentId();
  const renderMd = (text: string) => {
    const tree = parseMarkdown(text);
    return renderMarkdownToHtml(tree, {
      // SPEC: wikilink chips show the target title (export degrades them
      // to spans afterward, but the visible text is still the title).
      wikiLinkTitle: buildWikiLinkTitle(client),
      assetOwnerId: ownerId,
    });
  };
  return renderExportBody(body, renderMd);
}

/** Inline every vault image as a data URI and degrade wikilinks:
 *  same-page `[[#heading]]` becomes an in-page anchor, cross-page links
 *  become non-clickable spans that keep the wiki-link look. */
async function postProcessDom(client: Client, bodyHtml: string): Promise<string> {
  const tpl = document.createElement("template");
  tpl.innerHTML = bodyHtml;
  const root = tpl.content;

  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    if (!h.id) h.id = slugify(h.textContent ?? "");
  }
  for (const a of root.querySelectorAll("a.wiki-link")) {
    const ref = a.getAttribute("data-ref") ?? "";
    if (ref.startsWith("#")) {
      a.setAttribute("href", `#${slugify(ref.slice(1))}`);
      continue;
    }
    const span = document.createElement("span");
    span.className = "wiki-link";
    span.textContent = a.textContent;
    a.replaceWith(span);
  }

  await Promise.all([...root.querySelectorAll("img")].map(async (img) => {
    // Local image embeds render as `/.file?id=<owner>&asset=<name>`; inline
    // their bytes as a data URI so the export is self-contained.
    const src = img.getAttribute("src") ?? "";
    const m = /[?&]id=([^&]+)&asset=([^&]+)/.exec(src);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    const asset = decodeURIComponent(m[2]);
    try {
      const { data } = await client.httpSpacePrimitives.readFile({ id, asset });
      const type = mime.getType(asset) ?? "application/octet-stream";
      img.src = await blobToDataUri(new Blob([data as BlobPart], { type }));
    } catch {
      // Leave the original src - the export just won't inline this image.
    }
  }));

  return tpl.innerHTML;
}

/** The app stylesheet with every woff2 (CodeNewRoman + KaTeX) inlined
 *  as a data URI, so the exported file renders fully offline. */
async function inlinedStylesheet(): Promise<string> {
  const res = await authedFetch("/.client/main.css");
  if (!res.ok) throw new Error(`fetch main.css: HTTP ${res.status}`);
  return await inlineWoff2(await res.text(), async (ref) => {
    const r = await authedFetch(`/.client/${ref}`);
    if (!r.ok) return null;
    return await blobToDataUri(
      new Blob([await r.arrayBuffer()], { type: "font/woff2" }),
    );
  });
}

/** One fully self-contained HTML document for the markdown page `name`:
 *  CSS, fonts, and images inlined, math statically rendered, light theme. */
async function buildSelfContainedHtml(
  client: Client,
  name: string,
): Promise<string> {
  // Export acts on the current page (read by id); `name` is the filename.
  const { text, meta } = await client.space.readPage(client.currentId());
  const body = stripFrontmatter(text).body;
  const title = meta.title || name;
  const [css, bodyHtml] = await Promise.all([
    inlinedStylesheet(),
    postProcessDom(client, renderBodyHtml(client, body)),
  ]);
  return exportDocumentHtml(title, css, bodyHtml);
}

/** Export the markdown page `name` as a single offline .html download. */
export async function exportHtml(client: Client, name: string): Promise<void> {
  const html = await buildSelfContainedHtml(client, name);
  await saveBlobAs(
    `${basename(name)}.html`,
    new Blob([html], { type: "text/html" }),
  );
}
