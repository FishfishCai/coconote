// Static-site HTML scaffolding: the three view shells (Path/Tag/Graph),
// the shared document chrome, per-page wrappers, and relative-href math.

import { htmlEscapeAttr } from "../../markdown/render/html_render.ts";
import { encodePathSegments } from "../path_url.ts";

export const SITE_VIEWS = [
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

export function shellHtml(view: "path" | "tag" | "graph", label: string): string {
  return documentHtml(
    `Coconote - ${label}`,
    "",
    topbarHtml("", view),
    `<div id="site-root" data-view="${view}"></div>\n` +
      `<script src="assets/manifest.js"></script>\n` +
      `<script src="assets/site.js"></script>`,
  );
}

export function pageHtml(title: string, depth: number, bodyHtml: string): string {
  const prefix = "../".repeat(depth);
  return documentHtml(
    title,
    prefix,
    topbarHtml(prefix),
    `<article class="coconote-export-article">\n${bodyHtml}\n</article>`,
  );
}

/** Relative href from the file at `fromFile` to the file at `toFile`
 *  (both zip-root paths), segment-encoded so it works from file://. */
export function relativeHref(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return (
    "../".repeat(from.length - i) + encodePathSegments(to.slice(i).join("/"))
  );
}
