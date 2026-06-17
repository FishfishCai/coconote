// HTML post-processing for exported pages: string transforms over our own
// renderer output (building blocks in export_core.ts). Injects callout ids,
// rewrites [[wikilinks]] to relative site hrefs (degrading unresolvable ones
// to spans), and rewrites /.file media refs to relative zip paths.

import type { PageMeta } from "coconote/type/page";
import { htmlEscapeAttr } from "../../markdown/render/html_render.ts";
import { resolvePdfWikiLinkPath } from "../../markdown/wiki_link_resolver.ts";
import type { Anchor, Highlight } from "../../pdf/notes_client.ts";
import { resolveTemplate } from "../callout.ts";
import { decodeEntities, slugify, splitCallouts } from "../export_core.ts";
import { nameToFsPath } from "../path_url.ts";
import { parseToRef, type Ref } from "../ref.ts";
import { resolveWikiLink } from "../wikilink.ts";
import { relativeHref } from "./document.ts";

export type LinkContext = {
  allPages: readonly PageMeta[];
  allKnownFiles: ReadonlySet<string>;
  /** pdf vault path -> parsed sidecar (anchors + highlights). */
  sidecars: Map<string, { anchors: Anchor[]; highlights: Highlight[] }>;
  /** Current page, vault fs path / output html path. */
  fsPath: string;
  htmlPath: string;
  shortWikiLinks?: boolean;
};

/** Give callout sections the ids `[[:N]]` / `[[:label]]` fragments
 *  point at. The sections come from renderExportBody over the same
 *  `body`, so re-running splitCallouts yields one mark per rendered
 *  section in document order. Numbered callouts get `callout-<n>`,
 *  labelled ones `callout-<label>` (on an inner span when the section
 *  id is already taken by the number). */
export function injectCalloutIds(body: string, html: string): string {
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
export function rewriteWikiLinks(ctx: LinkContext, html: string): string {
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
export function rewriteMediaRefs(
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
