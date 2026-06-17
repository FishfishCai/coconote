// Pure site assembly for the Export Site action (content.md): build the
// complete static-site file map (view shells, manifest, per-page HTML,
// baked PDFs, shared assets) from a small IO interface. Same discipline
// as export_core.ts - no DOM and no client context in here - so the
// client wrapper (lib/site_export.ts) and a future MCP tool can share
// it. The IO types, manifest, HTML scaffolding, and link/media rewriting
// live in ./site/*; this file is the assembly orchestrator.

import type { PageMeta } from "coconote/type/page";
import { stripFrontmatter } from "../markdown/frontmatter.ts";
import { parseMarkdown } from "../markdown/parser/parser.ts";
import { renderMarkdownToHtml } from "../markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../markdown/transclusion_resolver.ts";
import type { Anchor, Highlight } from "../pdf/notes_client.ts";
import {
  bakeHighlights,
  injectHeadingIds,
  inlineWoff2,
  renderExportBody,
} from "./export_core.ts";
import { basename, nameToFsPath, pdfSidecarPath } from "./path_url.ts";
import { isLocalURL, resolveMarkdownLink } from "./resolve.ts";
import { SITE_VIEWS, pageHtml, relativeHref, shellHtml } from "./site/document.ts";
import type { SiteFiles, SiteIo, SiteProgress } from "./site/io.ts";
import {
  type LinkContext,
  injectCalloutIds,
  rewriteMediaRefs,
  rewriteWikiLinks,
} from "./site/links.ts";
import { manifestEntry } from "./site/manifest.ts";

export type { SiteFiles, SiteIo, SiteProgress } from "./site/io.ts";
export { relativeHref } from "./site/document.ts";

function renderSitePage(
  ctx: LinkContext,
  page: PageMeta,
  text: string,
): { html: string; assets: Set<string> } {
  const body = stripFrontmatter(text).body;
  const shortWikiLinks = ctx.shortWikiLinks;
  const renderMd = (md: string) => {
    const tree = parseMarkdown(md);
    resolveImageRefs(tree, ctx.fsPath, ctx.allKnownFiles, ctx.allPages);
    return renderMarkdownToHtml(tree, {
      shortWikiLinks,
      // Plain markdown links: resolve vault-relative like the app
      // (widget_util.ts buildTranslateUrls), then point known pages at
      // their site file, anything else at its mirrored vault location.
      translateUrls: (url) => {
        if (!isLocalURL(url)) return url;
        const vault = resolveMarkdownLink(ctx.fsPath, decodeURI(url));
        const isMdPage = vault.toLowerCase().endsWith(".md") &&
          ctx.allKnownFiles.has(vault);
        return relativeHref(
          ctx.htmlPath,
          isMdPage ? vault.replace(/\.md$/i, ".html") : vault,
        );
      },
    });
  };
  let html = renderExportBody(body, renderMd);
  html = injectHeadingIds(html);
  html = injectCalloutIds(body, html);
  html = rewriteWikiLinks(ctx, html);
  const assets = new Set<string>();
  html = rewriteMediaRefs(ctx, html, assets);
  const depth = ctx.htmlPath.split("/").length - 1;
  return {
    html: pageHtml(page.title || basename(page.name), depth, html),
    assets,
  };
}

const utf8 = new TextDecoder();

function asText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : utf8.decode(data);
}

function asBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** site.css with every woff2 fetched into `files` under assets/fonts/
 *  and the css urls rewritten to point there (the css itself lives at
 *  assets/site.css, so the rewritten refs are `fonts/<name>`). */
async function packStylesheet(
  io: SiteIo,
  css: string,
  files: Map<string, string | Uint8Array>,
): Promise<string> {
  return await inlineWoff2(css, async (ref) => {
    const data = await io.fetchAsset(ref);
    if (data == null) return null;
    const name = basename(ref);
    files.set(`assets/fonts/${name}`, asBytes(data));
    return `fonts/${name}`;
  });
}

/** Build the complete static-site file map: view shells, manifest,
 *  every included page (md as HTML, pdf with highlights baked), image
 *  assets, and the shared css/js/fonts. Pages whose bytes can't be
 *  fetched are reported in `skipped` and left out of the manifest. */
export async function buildSiteFiles(
  io: SiteIo,
  onProgress?: SiteProgress,
): Promise<SiteFiles> {
  const allPages = await io.listPages();
  const files = new Map<string, string | Uint8Array>();
  const skipped: string[] = [];

  // Shared assets first - a missing viewer bundle should fail the whole
  // export before any page work happens.
  const [cssRaw, jsRaw] = await Promise.all([
    io.fetchAsset("site.css"),
    io.fetchAsset("site.js"),
  ]);
  if (cssRaw == null || jsRaw == null) {
    throw new Error(
      "site viewer assets (site.css / site.js) are not served - rebuild the client",
    );
  }
  files.set("assets/site.css", await packStylesheet(io, asText(cssRaw), files));
  files.set("assets/site.js", asText(jsRaw));

  const pages = allPages.filter((p) =>
    /\.(md|pdf)$/i.test(nameToFsPath(p.name))
  );
  const allKnownFiles = new Set(pages.map((p) => nameToFsPath(p.name)));

  // PDF sidecars, read once: highlight baking and `%anchor` -> #page=N
  // lookup both need them.
  const sidecars = new Map<
    string,
    { json: string; anchors: Anchor[]; highlights: Highlight[] }
  >();
  const pdfPaths = pages
    .map((p) => nameToFsPath(p.name))
    .filter((path) => path.toLowerCase().endsWith(".pdf"));
  await Promise.all(pdfPaths.map(async (path) => {
    const raw = await io.readFile(pdfSidecarPath(path));
    if (!raw) return;
    const json = utf8.decode(raw);
    try {
      const parsed = JSON.parse(json) as {
        anchors?: Anchor[];
        highlights?: Highlight[];
      };
      sidecars.set(path, {
        json,
        anchors: Array.isArray(parsed.anchors) ? parsed.anchors : [],
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      });
    } catch {
      // Malformed sidecar: export the PDF without highlights.
    }
  }));

  const exported: PageMeta[] = [];
  let done = 0;
  for (const p of pages) {
    const fsPath = nameToFsPath(p.name);
    const bytes = await io.readFile(fsPath);
    if (!bytes) {
      skipped.push(fsPath);
      onProgress?.(++done, pages.length);
      continue;
    }
    if (fsPath.toLowerCase().endsWith(".pdf")) {
      files.set(
        fsPath,
        await bakeHighlights(bytes, sidecars.get(fsPath)?.json ?? null),
      );
    } else {
      const ctx: LinkContext = {
        allPages,
        allKnownFiles,
        sidecars,
        fsPath,
        htmlPath: fsPath.replace(/\.md$/i, ".html"),
        shortWikiLinks: io.shortWikiLinks ?? true,
      };
      const { html, assets } = renderSitePage(ctx, p, utf8.decode(bytes));
      files.set(ctx.htmlPath, html);
      // Copy referenced images at their vault locations so the
      // relative references keep working. A dead asset just stays a
      // broken image, it doesn't skip the page.
      await Promise.all([...assets].map(async (asset) => {
        if (files.has(asset)) return;
        const data = await io.readFile(asset);
        if (data) files.set(asset, data);
      }));
    }
    exported.push(p);
    onProgress?.(++done, pages.length);
  }

  const manifest = {
    pages: exported.map((p) => manifestEntry(p, allPages)),
  };
  files.set(
    "assets/manifest.js",
    `window.COCONOTE_SITE = ${JSON.stringify(manifest)};\n`,
  );
  for (const [file, label, view] of SITE_VIEWS) {
    files.set(file, shellHtml(view, label));
  }
  return { files, skipped };
}
