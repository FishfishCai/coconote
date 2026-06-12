// Pure site assembly for the Export Site action (content.md): build the
// complete static-site file map (view shells, manifest, per-page HTML,
// baked PDFs, shared assets) from a small IO interface. Same discipline
// as export_core.ts - no DOM and no client context in here - so the
// client wrapper (lib/site_export.ts) and a future MCP tool can share
// it. Post-processing is done with string transforms over our own
// renderer output, mirroring mcp/src/export.ts.

import type { PageMeta } from "coconote/type/page";
import { stripFrontmatter } from "../markdown/frontmatter.ts";
import { parseMarkdown } from "../markdown/parser/parser.ts";
import { htmlEscapeAttr } from "../markdown/render/html_render.ts";
import { renderMarkdownToHtml } from "../markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../markdown/transclusion_resolver.ts";
import { resolvePdfWikiLinkPath } from "../markdown/wiki_link_resolver.ts";
import type { Anchor, Highlight } from "../pdf/notes_client.ts";
import { resolveTemplate } from "./callout.ts";
import {
  bakeHighlights,
  inlineWoff2,
  renderExportBody,
  slugify,
  splitCallouts,
} from "./export_core.ts";
import { basename, nameToFsPath, pdfSidecarPath } from "./path_url.ts";
import { parseToRef, type Ref } from "./ref.ts";
import { isLocalURL, resolveMarkdownLink } from "./resolve.ts";
import { resolveWikiLink } from "./wikilink.ts";

// --- the IO interface ---------------------------------------------------

export type SiteIo = {
  /** The live page listing - the same PageMeta array the app resolves
   *  wikilinks against (client: ui.viewState.allPages, mcp: derived
   *  from one /.file listing like mcp/src/export.ts loadPageContext). */
  listPages(): readonly PageMeta[] | Promise<readonly PageMeta[]>;
  /** Vault file bytes by fs path, null when unfetchable (the page is
   *  then skipped, the export keeps going). */
  readFile(path: string): Promise<Uint8Array | null>;
  /** A built client asset by `/.client`-relative path ("site.css",
   *  "fonts/x.woff2"), null when the server doesn't have it. */
  fetchAsset(path: string): Promise<string | Uint8Array | null>;
  /** Mirrors the client's shortWikiLinks config (mcp keeps the default). */
  shortWikiLinks?: boolean;
};

export type SiteProgress = (done: number, total: number) => void;

export type SiteFiles = {
  /** Zip entry path -> content. Strings are UTF-8 text files. */
  files: Map<string, string | Uint8Array>;
  /** Vault paths of pages whose bytes could not be fetched. */
  skipped: string[];
};

// --- manifest -----------------------------------------------------------

type SitePageEntry = {
  path: string;
  kind: "md" | "pdf";
  title: string;
  tags: string[];
  headings: string[];
  links: string[];
  prereqs: string[];
};

/** Resolve raw wikilink / prereq locators to vault paths, exactly like
 *  the Graph view's edge construction (lib/graph_layout.ts buildGraph):
 *  resolveWikiLink, drop unresolved, drop self, dedupe. */
function resolveTargets(
  queries: readonly string[] | undefined,
  selfPath: string,
  allPages: readonly PageMeta[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of queries ?? []) {
    const r = resolveWikiLink(q, allPages);
    if (r.kind !== "ok") continue;
    const target = nameToFsPath(r.page.name);
    if (target === selfPath || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

function manifestEntry(
  p: PageMeta,
  allPages: readonly PageMeta[],
): SitePageEntry {
  const path = nameToFsPath(p.name);
  // Remote pages carry no edges, matching buildGraph.
  const local = p.origin?.kind !== "remote";
  return {
    path,
    kind: path.toLowerCase().endsWith(".pdf") ? "pdf" : "md",
    title: p.title || basename(p.name),
    tags: p.tags ?? [],
    headings: p.headings ?? [],
    links: local ? resolveTargets(p.wikilinks, path, allPages) : [],
    prereqs: local ? resolveTargets(p.prereq, path, allPages) : [],
  };
}

// --- document scaffolding ------------------------------------------------

const SITE_VIEWS = [
  ["index.html", "Path", "path"],
  ["tag.html", "Tag", "tag"],
  ["graph.html", "Graph", "graph"],
] as const;

function topbarHtml(prefix: string, active?: string): string {
  const links = SITE_VIEWS.map(([file, label, view]) =>
    `<a href="${prefix}${file}"${
      view === active ? ' class="active"' : ""
    }>${label}</a>`
  ).join("");
  return `<header class="coconote-site-topbar">` +
    `<a class="coconote-site-title" href="${prefix}index.html">Coconote</a>` +
    `<nav class="coconote-site-nav">${links}</nav>` +
    `</header>`;
}

function documentHtml(
  title: string,
  prefix: string,
  topbar: string,
  body: string,
): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscapeAttr(title)}</title>
<link rel="stylesheet" href="${prefix}assets/site.css">
</head>
<body>
${topbar}
${body}
</body>
</html>
`;
}

function shellHtml(view: "path" | "tag" | "graph", label: string): string {
  return documentHtml(
    `Coconote - ${label}`,
    "",
    topbarHtml("", view),
    `<div id="site-root" data-view="${view}"></div>\n` +
      `<script src="assets/manifest.js"></script>\n` +
      `<script src="assets/site.js"></script>`,
  );
}

function pageHtml(title: string, depth: number, bodyHtml: string): string {
  const prefix = "../".repeat(depth);
  return documentHtml(
    title,
    prefix,
    topbarHtml(prefix),
    `<article class="coconote-export-article">\n${bodyHtml}\n</article>`,
  );
}

// --- relative URLs --------------------------------------------------------

/** Relative href from the file at `fromFile` to the file at `toFile`
 *  (both zip-root paths), segment-encoded so it works from file://. */
export function relativeHref(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return (
    "../".repeat(from.length - i) +
    to.slice(i).map(encodeURIComponent).join("/")
  );
}

// --- HTML post-processing (string twins of mcp/src/export.ts) ------------

/** Decode the entities our own renderer emits (htmlEscape output plus
 *  numeric forms), for reading back attribute values and text content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textContent(innerHtml: string): string {
  return decodeEntities(innerHtml.replace(/<[^>]*>/g, ""));
}

/** Give every h1-h4 the slugified id `[[#heading]]` fragments point at
 *  (same ids as the single-page export). */
function injectHeadingIds(html: string): string {
  return html.replace(
    /<h([1-4])>([\s\S]*?)<\/h\1>/g,
    (_full, level, inner) =>
      `<h${level} id="${htmlEscapeAttr(slugify(textContent(inner)))}">${inner}</h${level}>`,
  );
}

/** Give callout sections the ids `[[:N]]` / `[[:label]]` fragments
 *  point at. The sections come from renderExportBody over the same
 *  `body`, so re-running splitCallouts yields one mark per rendered
 *  section in document order. Numbered callouts get `callout-<n>`,
 *  labelled ones `callout-<label>` (on an inner span when the section
 *  id is already taken by the number). */
function injectCalloutIds(body: string, html: string): string {
  const marks: Array<{ id: string | null; labelId: string | null }> = [];
  let counter = 0;
  for (const seg of splitCallouts(body)) {
    if (seg.kind !== "callout") continue;
    const t = resolveTemplate(seg.keyword)!;
    const number = t.numbered ? ++counter : null;
    const labelId = seg.label ? `callout-${slugify(seg.label)}` : null;
    marks.push({
      id: number != null ? `callout-${number}` : labelId,
      labelId: number != null ? labelId : null,
    });
  }
  let i = 0;
  return html.replace(
    /<section class="coconote-export-callout[^"]*">/g,
    (open) => {
      const m = marks[i++];
      if (!m) return open;
      let out = m.id
        ? open.replace("<section ", `<section id="${htmlEscapeAttr(m.id)}" `)
        : open;
      if (m.labelId) out += `<span id="${htmlEscapeAttr(m.labelId)}"></span>`;
      return out;
    },
  );
}

type LinkContext = {
  allPages: readonly PageMeta[];
  allKnownFiles: ReadonlySet<string>;
  /** pdf vault path -> parsed sidecar (anchors + highlights). */
  sidecars: Map<string, { anchors: Anchor[]; highlights: Highlight[] }>;
  /** Current page, vault fs path / output html path. */
  fsPath: string;
  htmlPath: string;
  shortWikiLinks?: boolean;
};

function sigilFragment(ref: Ref): string {
  switch (ref.details?.type) {
    case "header":
      return `#${slugify(ref.details.header)}`;
    case "anchor":
      return `#anchor-${slugify(ref.details.name)}`;
    case "callout":
      return `#callout-${slugify(ref.details.target)}`;
    default:
      return "";
  }
}

/** The relative href a wikilink rewrites to, or null when the link
 *  can't be resolved (it then degrades to a span like the single-page
 *  export). Resolution mirrors the app's link follow (core/lifecycle.ts
 *  actionFollow): md through resolveWikiLink, pdf through
 *  resolvePdfWikiLinkPath, externals pass through. */
function wikiHref(ctx: LinkContext, refStr: string): string | null {
  if (/^https?:\/\//i.test(refStr)) return refStr;
  const ref = parseToRef(refStr);
  if (!ref) return null;
  const frag = sigilFragment(ref);
  if (ref.path === "") return frag || null;
  if (ref.path.toLowerCase().endsWith(".pdf")) {
    const resolved = resolvePdfWikiLinkPath(
      ref.path,
      ctx.fsPath,
      ctx.allKnownFiles,
      ctx.allPages,
    );
    if (!ctx.allKnownFiles.has(resolved)) return null;
    let pageFrag = "";
    if (ref.details?.type === "pdfAnchor") {
      const sc = ctx.sidecars.get(resolved);
      const anchorName = ref.details.anchor;
      const a = sc?.anchors.find((x) => x.name === anchorName);
      const h = a && sc?.highlights.find((x) => x.id === a.highlightId);
      if (h) pageFrag = `#page=${h.page}`;
    }
    return relativeHref(ctx.htmlPath, resolved) + pageFrag;
  }
  if (ref.details?.type === "pdfAnchor") return null; // % is pdf-only
  const query = ref.path.endsWith(".md") ? ref.path.slice(0, -3) : ref.path;
  const r = resolveWikiLink(query, ctx.allPages);
  if (r.kind !== "ok") return null;
  const target = nameToFsPath(r.page.name);
  return target.toLowerCase().endsWith(".pdf")
    ? relativeHref(ctx.htmlPath, target)
    : relativeHref(ctx.htmlPath, target.replace(/\.md$/i, ".html")) + frag;
}

/** Rewrite every wiki-link anchor to a relative href into the site,
 *  degrading unresolvable ones to non-clickable spans. */
function rewriteWikiLinks(ctx: LinkContext, html: string): string {
  return html.replace(
    /<a href="[^"]*" class="wiki-link" data-ref="([^"]*)">([\s\S]*?)<\/a>/g,
    (_full, refAttr, inner) => {
      const href = wikiHref(ctx, decodeEntities(refAttr));
      if (href == null) return `<span class="wiki-link">${inner}</span>`;
      return `<a href="${htmlEscapeAttr(href)}" class="wiki-link" data-ref="${refAttr}">${inner}</a>`;
    },
  );
}

/** Rewrite `/.file/<path>` media references to relative paths inside
 *  the zip and collect the referenced vault asset paths for copying. */
function rewriteMediaRefs(
  ctx: LinkContext,
  html: string,
  assets: Set<string>,
): string {
  return html.replace(
    /(src|data)="(\/?\.file\/[^"]*)"/gi,
    (full, attr, val) => {
      const m = /^\/?\.file\/(.+)$/.exec(decodeEntities(val));
      if (!m) return full;
      const assetPath = decodeURIComponent(m[1]);
      assets.add(assetPath);
      return `${attr}="${htmlEscapeAttr(relativeHref(ctx.htmlPath, assetPath))}"`;
    },
  );
}

// --- page rendering --------------------------------------------------------

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

// --- assembly ---------------------------------------------------------------

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
  for (const p of pages) {
    const path = nameToFsPath(p.name);
    if (!path.toLowerCase().endsWith(".pdf")) continue;
    const raw = await io.readFile(pdfSidecarPath(path));
    if (!raw) continue;
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
  }

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
      for (const asset of assets) {
        if (files.has(asset)) continue;
        const data = await io.readFile(asset);
        if (data) files.set(asset, data);
      }
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
