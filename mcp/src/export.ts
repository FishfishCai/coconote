// export_pdf / export_html internals: Node-side twins of
// client/lib/export.ts. The render pipeline (parser, markdown / html
// render, callout splitting, image ref resolution) and the export
// assembly (client/lib/export_core.ts) are the client's own modules,
// bundled in. Only the browser-bound pieces are redone here: the DOM
// post-processing becomes string transforms over our own generated
// HTML, and a minimal document shim stands in for the media element
// factory.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import mime from "mime";
import {
  bakeHighlights,
  exportDocumentHtml,
  inlineWoff2,
  renderExportBody,
  slugify,
} from "../../client/lib/export_core.ts";
import { isLocalURL, resolveMarkdownLink } from "../../client/lib/resolve.ts";
import { stripFrontmatter } from "../../client/markdown/frontmatter.ts";
import { parseMarkdown } from "../../client/markdown/parser/parser.ts";
import { htmlEscapeAttr } from "../../client/markdown/render/html_render.ts";
import { renderMarkdownToHtml } from "../../client/markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../../client/markdown/transclusion_resolver.ts";
import type { PageMeta } from "../../client/types/page.ts";
import * as api from "./api";

// --- document shim ----------------------------------------------------
// client/markdown/render/inline.ts createMediaElement builds <img> /
// <video> / <audio> / <object> through document.createElement and the
// renderer only reads back tagName + attributes. This stand-in records
// property writes as attributes (DOM reflection), uppercases tagName
// like the DOM, and ignores event handler properties.

function createShimElement(tag: string): unknown {
  const attrs = new Map<string, string>();
  const styleProps: Record<string, string> = {};
  const styleProxy = new Proxy(styleProps, {
    set(t, p, v) {
      if (typeof p === "string") {
        if (!attrs.has("style")) attrs.set("style", "");
        t[p] = String(v);
      }
      return true;
    },
  });
  const styleText = () =>
    Object.entries(styleProps)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`)
      .join(" ");
  return new Proxy(
    { tagName: tag.toUpperCase() },
    {
      get(t, p) {
        if (p === "tagName") return t.tagName;
        if (p === "style") return styleProxy;
        if (p === "attributes") {
          return [...attrs].map(([name, value]) => ({
            name,
            value: name === "style" && value === "" ? styleText() : value,
          }));
        }
        return undefined;
      },
      set(_t, p, v) {
        if (typeof p !== "string" || typeof v === "function") return true;
        if (p === "style") attrs.set("style", String(v));
        else attrs.set(p.toLowerCase(), v === true ? "" : String(v));
        return true;
      },
    },
  );
}

const g = globalThis as { document?: unknown };
if (!g.document) g.document = { createElement: createShimElement };

// --- page rendering ----------------------------------------------------

/** Decode the entities our own renderer emits (htmlEscape output plus
 *  numeric forms), for reading back attribute values and text content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textContent(innerHtml: string): string {
  return decodeEntities(innerHtml.replace(/<[^>]*>/g, ""));
}

type PageContext = { allPages: PageMeta[]; allKnownFiles: Set<string> };

/** The wikilink / image resolution context the client keeps live
 *  (client.allKnownFiles + viewState.allPages), built from one listing. */
async function loadPageContext(): Promise<PageContext> {
  const mdEntries = (await api.listEntries()).filter(
    (e) => e.type === "file" && e.path.toLowerCase().endsWith(".md"),
  );
  const allPages = mdEntries.map((e): PageMeta => {
    const name = e.path.replace(/\.md$/i, "");
    return {
      ref: name,
      tag: "page",
      name,
      created: "",
      lastModified: "",
      perm: "rw",
      title: e.title,
      tags: e.tag,
    };
  });
  return { allPages, allKnownFiles: new Set(mdEntries.map((e) => e.path)) };
}

/** client/lib/export.ts renderBodyHtml, with the client context replaced
 *  by the listing-derived one. translateUrls mirrors buildTranslateUrls
 *  (widget_util.ts), shortWikiLinks keeps its client default. */
function renderBodyHtml(ctx: PageContext, path: string, body: string): string {
  const pageName = path.replace(/\.md$/i, "");
  const renderMd = (text: string) => {
    const tree = parseMarkdown(text);
    resolveImageRefs(tree, path, ctx.allKnownFiles, ctx.allPages);
    return renderMarkdownToHtml(tree, {
      shortWikiLinks: true,
      translateUrls: (url) =>
        isLocalURL(url) ? resolveMarkdownLink(pageName, decodeURI(url)) : url,
    });
  };
  return renderExportBody(body, renderMd);
}

// --- post-processing (string twin of export.ts postProcessDom) --------

/** Inline every vault image as a data URI and degrade wikilinks:
 *  same-page `[[#heading]]` becomes an in-page anchor, cross-page links
 *  become non-clickable spans that keep the wiki-link look. The input
 *  is our own renderer's output, so targeted string transforms are safe. */
async function postProcessHtml(bodyHtml: string): Promise<string> {
  let html = bodyHtml.replace(
    /<h([1-4])>([\s\S]*?)<\/h\1>/g,
    (_full, level, inner) =>
      `<h${level} id="${htmlEscapeAttr(slugify(textContent(inner)))}">${inner}</h${level}>`,
  );

  html = html.replace(
    /<a href="[^"]*" class="wiki-link" data-ref="([^"]*)">([\s\S]*?)<\/a>/g,
    (_full, refAttr, inner) => {
      const ref = decodeEntities(refAttr);
      if (ref.startsWith("#")) {
        const href = htmlEscapeAttr(`#${slugify(ref.slice(1))}`);
        return `<a href="${href}" class="wiki-link" data-ref="${refAttr}">${inner}</a>`;
      }
      return `<span class="wiki-link">${inner}</span>`;
    },
  );

  const parts: string[] = [];
  let last = 0;
  for (const m of html.matchAll(/<IMG ([^>]*)><\/IMG>/g)) {
    const srcMatch = /src="([^"]*)"/.exec(m[1]);
    const fileMatch = srcMatch && /^\/?\.file\/(.+)$/.exec(decodeEntities(srcMatch[1]));
    if (!fileMatch) continue;
    const path = decodeURIComponent(fileMatch[1]);
    const got = await api.readBytesOrNull(path).catch(() => null);
    if (!got) continue;
    const type = mime.getType(path) ?? "application/octet-stream";
    const dataUri = `data:${type};base64,${Buffer.from(got.bytes).toString("base64")}`;
    const srcStart = m.index + "<IMG ".length + srcMatch.index;
    parts.push(html.slice(last, srcStart), `src="${dataUri}"`);
    last = srcStart + srcMatch[0].length;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/** The app stylesheet with every woff2 (CodeNewRoman + KaTeX) inlined
 *  as a data URI, so the exported file renders fully offline. */
async function inlinedStylesheet(): Promise<string> {
  const res = await api.fetchPath("/.client/main.css");
  if (!res.ok) throw new Error(`fetch main.css: HTTP ${res.status}`);
  return await inlineWoff2(await res.text(), async (ref) => {
    const r = await api.fetchPath(`/.client/${ref}`);
    if (!r.ok) return null;
    return `data:font/woff2;base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  });
}

// --- the tool entry points ---------------------------------------------

/** One fully self-contained HTML document for the markdown page at
 *  `path`: CSS, fonts, and images inlined, math statically rendered,
 *  light theme (client/lib/export.ts buildSelfContainedHtml). */
export async function buildHtmlExport(path: string): Promise<string> {
  const { text } = await api.readFile(path);
  const body = stripFrontmatter(text).body;
  const ctx = await loadPageContext();
  const pageName = path.replace(/\.md$/i, "");
  const entry = ctx.allPages.find((p) => p.name === pageName);
  const title = entry?.title || api.basename(pageName);
  const [css, bodyHtml] = await Promise.all([
    inlinedStylesheet(),
    postProcessHtml(renderBodyHtml(ctx, path, body)),
  ]);
  return exportDocumentHtml(title, css, bodyHtml);
}

/** The vault PDF at `path` with its sidecar highlights baked in. */
export async function buildPdfExport(path: string): Promise<Uint8Array> {
  const { bytes } = await api.readBytes(path);
  const sidecar = await api.readFileOrNull(api.pdfSidecarPath(path));
  return await bakeHighlights(bytes, sidecar?.text ?? null);
}

/** Write export output to an absolute path on the MCP host, creating
 *  the parent directory when missing. Returns the byte size. */
export async function writeDest(dest: string, data: string | Uint8Array): Promise<number> {
  if (!isAbsolute(dest)) {
    throw new Error(
      `dest must be an absolute file path on the machine running the MCP server, got: ${dest}`,
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}
