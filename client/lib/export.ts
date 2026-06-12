// The Export and Download actions (content.md Right-click menu,
// setting.md Shortcut for Export): md pages export as self-contained
// HTML, PDFs export with highlights baked in, Download saves the raw
// bytes untouched. Every byte is assembled client-side from the
// existing GET endpoints and saved via saveBlobAs (the OS save dialog
// when available, a plain browser download otherwise) - nothing is
// ever written into the vault, and the same path works for local and
// remote (url-mounted) files. The pure assembly lives in
// export_core.ts, shared with the MCP server's export tools.

import { notFoundError } from "coconote/constants";
import type { ClientContext as Client } from "../core/context.ts";
import { buildTranslateUrls } from "../codemirror/util/widget_util.ts";
import { stripFrontmatter } from "../markdown/frontmatter.ts";
import { parseMarkdown } from "../markdown/parser/parser.ts";
import { renderMarkdownToHtml } from "../markdown/render/markdown_render.ts";
import { resolveImageRefs } from "../markdown/transclusion_resolver.ts";
import { authedFetch } from "./authed_fetch.ts";
import {
  bakeHighlights,
  exportDocumentHtml,
  inlineWoff2,
  renderExportBody,
  slugify,
} from "./export_core.ts";
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

// Minimal typing for the File System Access API save dialog: absent
// from TypeScript's DOM lib, and at runtime from Safari and Firefox.
type SaveFilePicker = (options: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** Save `blob` as `filename`, letting the user pick the destination via
 *  the OS save dialog when the browser has one. A cancelled dialog
 *  (AbortError) saves nothing. Any other picker failure, and browsers
 *  without the API, fall back to downloadBlob. */
export async function saveBlobAs(filename: string, blob: Blob): Promise<void> {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (!picker) return downloadBlob(filename, blob);
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot) : null;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: blob.type && ext
        ? [{ description: `${ext.slice(1)} file`, accept: { [blob.type]: [ext] } }]
        : undefined,
    });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    downloadBlob(filename, blob);
  }
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
 *  remote space. Returns null when the file can't be fetched. Shared
 *  with the site export (lib/site_export.ts). */
export async function readVaultFile(
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

// --- PDF export of a PDF page ----------------------------------------

/** Download a copy of `pdfName` with its sidecar highlights drawn into
 *  the pages (semi-transparent rects, baked in). */
export async function exportPdfOfPdf(
  client: Client,
  pdfName: string,
): Promise<void> {
  const [pdfData, sidecarData] = await Promise.all([
    readVaultFile(client, pdfName),
    readVaultFile(client, pdfSidecarPath(pdfName)),
  ]);
  if (!pdfData) throw new Error(`read ${pdfName} failed`);
  const bytes = await bakeHighlights(
    pdfData,
    sidecarData ? new TextDecoder().decode(sidecarData) : null,
  );
  await saveBlobAs(
    basename(pdfName),
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
  );
}

// --- Raw download -----------------------------------------------------

/** The Download action (content.md Right-click menu): save the file's
 *  raw bytes as-is, the md source or the original pdf, no rendering or
 *  highlight baking. readVaultFile routes remote rows too. */
export async function downloadRaw(client: Client, path: string): Promise<void> {
  const data = await readVaultFile(client, path);
  if (!data) throw new Error(`read ${path} failed`);
  const type = mime.getType(path) ?? "application/octet-stream";
  await saveBlobAs(basename(path), new Blob([data as BlobPart], { type }));
}
