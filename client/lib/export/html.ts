// HTML export of a markdown page: render the body through the shared
// renderer, inline every vault image as a data URI, degrade wikilinks, and
// inline the stylesheet + fonts so the single .html file works fully offline.

import type { ClientContext as Client } from "../../core/context.ts";
import { buildTranslateUrls } from "../../codemirror/util/widget_util.ts";
import { stripFrontmatter } from "../../markdown/frontmatter.ts";
import { parseMarkdown } from "../../markdown/parser/parser.ts";
import { renderMarkdownToHtml } from "../../markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../../markdown/transclusion_resolver.ts";
import { authedFetch } from "../authed_fetch.ts";
import {
  exportDocumentHtml,
  inlineWoff2,
  renderExportBody,
  slugify,
} from "../export_core.ts";
import { basename, nameToFsPath } from "../path_url.ts";
import mime from "mime";
import { saveBlobAs } from "./blob.ts";
import { readVaultFile } from "./vault.ts";

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Render the page body to HTML: markdown through the shared renderer,
 *  callouts through the shared export wrapper (export_core.ts). */
function renderBodyHtml(client: Client, pageName: string, body: string): string {
  const renderMd = (text: string) => {
    const tree = parseMarkdown(text);
    resolveImageRefs(
      tree,
      nameToFsPath(pageName),
      client.allKnownFiles,
      client.ui.viewState.allPages,
    );
    return renderMarkdownToHtml(tree, {
      shortWikiLinks: client.config.get("shortWikiLinks", true),
      translateUrls: buildTranslateUrls(client, pageName),
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
    const m = /^\/?\.file\/(.+)$/.exec(img.getAttribute("src") ?? "");
    if (!m) return;
    const path = decodeURIComponent(m[1]);
    const data = await readVaultFile(client, path);
    if (!data) return;
    const type = mime.getType(path) ?? "application/octet-stream";
    img.src = await blobToDataUri(new Blob([data as BlobPart], { type }));
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
  const { text, meta } = await client.space.readPage(name);
  const body = stripFrontmatter(text).body;
  const title = meta.title || basename(name);
  const [css, bodyHtml] = await Promise.all([
    inlinedStylesheet(),
    postProcessDom(client, renderBodyHtml(client, name, body)),
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
