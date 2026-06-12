// Export PDF / Export HTML (content.md Right-click menu,
// setting.md Shortcut). Every byte is assembled client-side from the
// existing GET endpoints and handed to the browser as a download -
// nothing is ever written into the vault, and the same path works for
// local and remote (url-mounted) files.

import { notFoundError } from "coconote/constants";
import type { ClientContext as Client } from "../core/context.ts";
import { buildTranslateUrls } from "../codemirror/util/widget_util.ts";
import { stripFrontmatter } from "../markdown/frontmatter.ts";
import { parseMarkdown } from "../markdown/parser/parser.ts";
import { htmlEscapeAttr } from "../markdown/render/html_render.ts";
import { renderMarkdownToHtml } from "../markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../markdown/transclusion_resolver.ts";
import type { Color, Highlight } from "../pdf/notes_client.ts";
import { authedFetch } from "./authed_fetch.ts";
import {
  findCalloutBounds,
  parseCalloutOpener,
  resolveTemplate,
} from "./callout.ts";
import { electronShell } from "./config_path_api.ts";
import { basename, nameToFsPath, pdfSidecarPath } from "./path_url.ts";
import { getRemoteSpaceByLabel, parseRemotePath } from "./remote_index.ts";
import mime from "mime";

/** Hand `blob` to the browser as a file download named `filename`. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has started so large blobs are not truncated.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Read a vault file's bytes, routing `@<label>/` paths to the matching
 *  remote space. Returns null when the file can't be fetched. */
async function readVaultFile(
  client: Client,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const remote = parseRemotePath(path);
    if (remote) {
      const r = getRemoteSpaceByLabel(remote.label);
      if (!r) return null;
      return (await r.sp.readFile(remote.rest)).data;
    }
    return (await client.space.spacePrimitives.readFile(path)).data;
  } catch (e) {
    if (e !== notFoundError) console.warn(`Export: read ${path} failed`, e);
    return null;
  }
}

// --- HTML export of a markdown page ---------------------------------

type Segment =
  | { kind: "md"; text: string }
  | { kind: "callout"; keyword: string; label: string | null; text: string };

/** Split a markdown body into plain segments and well-formed callouts,
 *  mirroring the editor's line-based callout scan (lib/callout.ts).
 *  Unknown keywords and unclosed callouts stay plain markdown. */
function splitCallouts(body: string): Segment[] {
  const lines = body.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const getLine = (n: number) =>
    n >= 1 && n <= lines.length
      ? { text: lines[n - 1], from: offsets[n - 1], to: offsets[n - 1] + lines[n - 1].length }
      : null;

  const segs: Segment[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length > 0) {
      segs.push({ kind: "md", text: plain.join("\n") });
      plain = [];
    }
  };
  for (let n = 1; n <= lines.length; n++) {
    const opener = parseCalloutOpener(lines[n - 1]);
    const bounds = opener && resolveTemplate(opener.keyword)
      ? findCalloutBounds(getLine, n)
      : null;
    if (opener && bounds) {
      flushPlain();
      segs.push({
        kind: "callout",
        keyword: opener.keyword,
        label: opener.label,
        text: lines.slice(n, bounds.closerLineNo - 1).join("\n"),
      });
      n = bounds.closerLineNo;
    } else {
      plain.push(lines[n - 1]);
    }
  }
  flushPlain();
  return segs;
}

/** Render the page body to HTML: markdown through the shared renderer,
 *  callouts wrapped in their normal head / body / suffix structure with
 *  one document-wide counter for numbered templates. */
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
  let counter = 0;
  const parts: string[] = [];
  for (const seg of splitCallouts(body)) {
    if (seg.kind === "md") {
      parts.push(renderMd(seg.text));
      continue;
    }
    const t = resolveTemplate(seg.keyword)!;
    const number = t.numbered ? ++counter : null;
    const base = number != null ? `${t.title} ${number}` : t.title ?? seg.keyword;
    const head = seg.label
      ? `${base} (${seg.label})${number != null ? "." : ""}`
      : number != null
      ? `${base}.`
      : base;
    const bodyClass = "coconote-callout-body" +
      (t.italic ? " coconote-callout-italic" : "") +
      (t.narrower ? " coconote-callout-narrower" : "");
    const suffix = t.suffix
      ? `<span class="coconote-callout-suffix coconote-callout-${t.cssClass}-suffix">${
        htmlEscapeAttr(t.suffix.trim())
      }</span>`
      : "";
    parts.push(
      `<section class="coconote-export-callout coconote-callout-${t.cssClass}">` +
        `<div class="coconote-callout-head">${htmlEscapeAttr(head)}</div>` +
        `<div class="${bodyClass}">${renderMd(seg.text)}${suffix}</div>` +
        `</section>`,
    );
  }
  return parts.join("\n");
}

/** Inline every vault image as a data URI and degrade wikilinks:
 *  same-page `[[#heading]]` becomes an in-page anchor, cross-page links
 *  become non-clickable spans that keep the wiki-link look. */
async function postProcessDom(client: Client, bodyHtml: string): Promise<string> {
  const tpl = document.createElement("template");
  tpl.innerHTML = bodyHtml;
  const root = tpl.content;

  const slugify = (s: string) => s.trim().replace(/\s+/g, "-");
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

  for (const img of root.querySelectorAll("img")) {
    const m = /^\/?\.file\/(.+)$/.exec(img.getAttribute("src") ?? "");
    if (!m) continue;
    const path = decodeURIComponent(m[1]);
    const data = await readVaultFile(client, path);
    if (!data) continue;
    const type = mime.getType(path) ?? "application/octet-stream";
    img.src = await blobToDataUri(new Blob([data as BlobPart], { type }));
  }

  return tpl.innerHTML;
}

/** The app stylesheet with every woff2 (CodeNewRoman + KaTeX) inlined
 *  as a data URI, so the exported file renders fully offline. */
async function inlinedStylesheet(): Promise<string> {
  const res = await authedFetch("/.client/main.css");
  if (!res.ok) throw new Error(`fetch main.css: HTTP ${res.status}`);
  const css = await res.text();
  const urlRe = /url\(["']?([^)"']+\.woff2)["']?\)/g;
  const fonts = new Map<string, string>();
  for (const ref of new Set([...css.matchAll(urlRe)].map((m) => m[1]))) {
    const r = await authedFetch(`/.client/${ref}`);
    if (!r.ok) continue;
    fonts.set(
      ref,
      await blobToDataUri(
        new Blob([await r.arrayBuffer()], { type: "font/woff2" }),
      ),
    );
  }
  return css.replace(urlRe, (full, ref) => {
    const data = fonts.get(ref);
    return data ? `url(${data})` : full;
  });
}

// Export page layout: a centered light-theme article reusing the app's
// prose look (.coconote-hover-preview-content styles plain rendered
// HTML, the editor's own prose rules are CM-line scoped).
const EXPORT_CSS = `
html, body { height: auto; width: auto; overflow: visible; }
body {
  background: var(--background-primary);
  color: var(--text-normal);
  font-family: var(--font-text);
  font-size: var(--editor-font-size);
  line-height: 1.55;
}
.coconote-export-page { max-width: var(--editor-width); margin: 0 auto; padding: 2.5rem 1.5rem; }
.coconote-export-page img { max-width: 100%; }
.coconote-export-page span.wiki-link { color: var(--text-accent); }
.coconote-export-callout {
  border: 1px solid var(--background-modifier-border-hover);
  border-radius: 6px;
  padding: 0.4em 1.4rem;
  margin: 0.8em 0;
  font-family: "STIXTwoText", "Latin Modern Roman", Cambria, Georgia, "Times New Roman", serif;
}
.coconote-export-callout .coconote-callout-head { font-weight: 700; }
.coconote-export-callout .coconote-callout-italic { font-style: italic; }
.coconote-export-callout .coconote-callout-narrower { max-width: 90%; }
.coconote-export-callout.coconote-callout-proof { border: 0; border-radius: 0; padding: 0; }
.coconote-export-callout.coconote-callout-proof .coconote-callout-body { padding-left: 2em; }
@page { margin: 18mm 16mm; }
@media print { .coconote-export-page { padding: 0; max-width: none; } }
`;

/** One fully self-contained HTML document for the markdown page `name`:
 *  CSS, fonts, and images inlined, math statically rendered, light theme. */
export async function buildSelfContainedHtml(
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
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscapeAttr(title)}</title>
<style>${css}</style>
<style>${EXPORT_CSS}</style>
</head>
<body>
<article class="coconote-export-page coconote-hover-preview-content">
${bodyHtml}
</article>
</body>
</html>
`;
}

/** Export the markdown page `name` as a single offline .html download. */
export async function exportHtml(client: Client, name: string): Promise<void> {
  const html = await buildSelfContainedHtml(client, name);
  downloadBlob(
    `${basename(name)}.html`,
    new Blob([html], { type: "text/html" }),
  );
}

// --- PDF export of a markdown page ----------------------------------

/** Print the self-contained HTML through a hidden iframe (plain
 *  browser): the user saves via the system print dialog. */
async function printHtmlViaIframe(html: string): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.width = "794px";
  iframe.style.height = "1123px";
  iframe.srcdoc = html;
  const loaded = new Promise((resolve) => {
    iframe.onload = resolve;
  });
  document.body.appendChild(iframe);
  await loaded;
  const win = iframe.contentWindow!;
  await win.document.fonts.ready;
  // Some browsers return from print() before the dialog closes - keep
  // the iframe alive until afterprint, with a fallback sweep.
  const cleanup = () => iframe.remove();
  win.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 60_000);
  win.print();
}

/** Export the markdown page `name` as a PDF. Electron renders it in the
 *  main process (printToPDF) and the bytes download directly, a plain
 *  browser goes through the hidden-iframe print dialog. */
export async function exportPdfOfMd(client: Client, name: string): Promise<void> {
  const html = await buildSelfContainedHtml(client, name);
  const shell = electronShell();
  if (!shell) return printHtmlViaIframe(html);
  const bytes = await shell.invoke("coconote_export_pdf", { html });
  downloadBlob(
    `${basename(name)}.pdf`,
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
  );
}

// --- PDF export of a PDF page ----------------------------------------

// pdf_viewer.scss five-colour palette, as 0..1 RGB for pdf-lib.
const HIGHLIGHT_RGB: Record<Color, [number, number, number]> = {
  yellow: [1, 0.945, 0.463],
  green: [0.682, 0.835, 0.506],
  blue: [0.506, 0.831, 0.98],
  pink: [0.973, 0.733, 0.816],
  orange: [1, 0.8, 0.502],
};

/** Download a copy of `pdfName` with its sidecar highlights drawn into
 *  the pages (semi-transparent rects, baked in). */
export async function exportPdfOfPdf(
  client: Client,
  pdfName: string,
): Promise<void> {
  const pdfData = await readVaultFile(client, pdfName);
  if (!pdfData) throw new Error(`read ${pdfName} failed`);
  let highlights: Highlight[] = [];
  const sidecarData = await readVaultFile(client, pdfSidecarPath(pdfName));
  if (sidecarData) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(sidecarData));
      if (Array.isArray(parsed?.highlights)) highlights = parsed.highlights;
    } catch {
      // Malformed sidecar: export the PDF without highlights.
    }
  }
  const { PDFDocument, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const pages = doc.getPages();
  for (const h of highlights) {
    const page = pages[h.page - 1];
    if (!page || !Array.isArray(h.rects)) continue;
    const { width, height } = page.getSize();
    const [r, g, b] = HIGHLIGHT_RGB[h.color] ?? HIGHLIGHT_RGB.yellow;
    // Sidecar rects are page fractions with a top-left origin (pdf.md),
    // pdf-lib's origin is bottom-left: flip y.
    for (const rect of h.rects) {
      page.drawRectangle({
        x: rect.x * width,
        y: height * (1 - rect.y - rect.h),
        width: rect.w * width,
        height: rect.h * height,
        color: rgb(r, g, b),
        opacity: 0.35,
      });
    }
  }
  const bytes = await doc.save();
  downloadBlob(
    basename(pdfName),
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
  );
}
