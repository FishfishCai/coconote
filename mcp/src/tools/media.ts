// Binary and media tools: import a file/URL, upload an image, download a
// page's bytes, extract PDF text, and add/remove PDF highlights over collab.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import * as api from "../api";
import { writeDest } from "../dest";
import * as fm from "../frontmatter";
import { findQuote, loadPdfPages } from "../pdf";
import {
  editSidecar,
  isMd,
  isPdf,
  json,
  loadSource,
  MB,
  PATH_DESC,
  setPdfIncluded,
  sourceBasename,
  text,
} from "./helpers";

/** client/markdown/parser/constants.ts ANCHOR_NAME_RE, anchored. */
const ANCHOR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_/:-]*$/;

const DEST_DESC =
  "Absolute destination file path on the machine running the MCP server " +
  "(missing parent directories are created)";

export function registerMediaTools(server: McpServer): void {
  server.registerTool(
    "import_file",
    {
      description:
        "Copy a local file (absolute path) or an http(s) URL into the vault (50MB cap). " +
        "With include (the default) the file joins the Coconote index: md gets coconote: true " +
        "ensured in its frontmatter, pdf gets its include sidecar. include: false copies raw bytes only.",
      inputSchema: {
        source: z.string().describe("Absolute local file path or http(s) URL"),
        dest_path: z.string().describe("Destination vault path, root-prefixed, e.g. main/papers/foo.pdf"),
        include: z.boolean().optional().default(true).describe("Admit the file into the Coconote index"),
      },
    },
    async ({ source, dest_path, include }) => {
      const bytes = await loadSource(source, 50 * MB);
      let body: string | Uint8Array = bytes;
      if (include && isMd(dest_path)) {
        const text = new TextDecoder().decode(bytes);
        body = fm.hasCoconoteTrue(text) ? text : fm.setFrontmatterKey(text, "coconote", "true");
      }
      await api.writeFile(dest_path, body);
      let sidecarPath: string | null = null;
      let sidecarCreated = false;
      if (include && isPdf(dest_path)) {
        sidecarCreated = (await setPdfIncluded(dest_path, true)) === "created";
        sidecarPath = api.pdfSidecarPath(dest_path);
      }
      return json({
        dest_path,
        bytes: bytes.byteLength,
        included: include,
        sidecar_path: sidecarPath,
        sidecar_created: sidecarCreated,
      });
    },
  );

  server.registerTool(
    "add_image",
    {
      description:
        "Upload an image (png/jpg/jpeg/gif/webp/svg, 25MB cap) into a markdown page's assets " +
        "folder. Returns the ![[name]] snippet to place into the page via edit_page.",
      inputSchema: {
        page_path: z.string().describe("The .md page the image belongs to"),
        source: z.string().describe("Absolute local file path or http(s) URL"),
        name: z.string().optional().describe("File name to store as (defaults to the source name)"),
      },
    },
    async ({ page_path, source, name }) => {
      if (!isMd(page_path)) throw new Error(`page_path must be a .md page, got ${page_path}`);
      const rawName = name ?? sourceBasename(source);
      const extMatch = /\.(png|jpe?g|gif|webp|svg)$/i.exec(rawName);
      if (!extMatch) {
        throw new Error(
          `unsupported image name "${rawName}": allowed extensions are png, jpg, jpeg, gif, webp, svg. ` +
            `Pass name explicitly when the source has no usable file name.`,
        );
      }
      const bytes = await loadSource(source, 25 * MB);
      const prefix = api.mdAssetsPrefix(page_path);
      const taken = new Set(
        (await api.listUnderPrefix(prefix).catch(() => [] as string[])).map((p) => p.slice(prefix.length)),
      );
      const ext = extMatch[0];
      const stem = rawName.slice(0, rawName.length - ext.length);
      let finalName = rawName;
      for (let n = 1; taken.has(finalName); n++) finalName = `${stem}-${n}${ext}`;
      await api.writeFile(prefix + finalName, bytes);
      return text(
        `Uploaded ${prefix}${finalName}. Embed it by placing this snippet in ${page_path} via edit_page:\n\n` +
          `![[${finalName}]]`,
      );
    },
  );

  server.registerTool(
    "read_pdf_text",
    {
      description:
        "Extract a vault PDF's text, returned per page as [page N] blocks. Optional pages " +
        "limits extraction to those 1-based page numbers.",
      inputSchema: {
        path: z.string().describe("Vault path of the .pdf"),
        pages: z.array(z.number().int().min(1)).optional().describe("1-based page numbers"),
      },
    },
    async ({ path, pages }) => {
      if (!isPdf(path)) throw new Error(`read_pdf_text reads .pdf files, got ${path}`);
      const got = await api.readBytes(path);
      const doc = await loadPdfPages(got.bytes, pages);
      const blocks = doc.pages.map((p) => `[page ${p.page}]\n${p.text.trimEnd()}`);
      return text(`${path}: ${doc.numPages} page(s)\n\n${blocks.join("\n\n")}`);
    },
  );

  server.registerTool(
    "add_pdf_highlight",
    {
      description:
        "Highlight a text quote inside a vault PDF: locates the quote (whitespace-insensitive), " +
        "computes its rectangles, and appends the highlight (plus optional named anchor and " +
        "comment) to the PDF's sidecar over live collab. The quote must match exactly once: " +
        "pass page to disambiguate. A named anchor becomes the link [[<file>.pdf%<anchor>]].",
      inputSchema: {
        path: z.string().describe("Vault path of the .pdf"),
        quote: z.string().min(1).describe("Text to highlight, must occur exactly once"),
        color: z.enum(["yellow", "green", "blue", "pink", "orange"]).optional().default("yellow"),
        anchor: z.string().optional().describe("Anchor name for [[file.pdf%anchor]] jumps"),
        comment: z.string().optional().describe("Comment attached to the highlight"),
        page: z.number().int().min(1).optional().describe("1-based page to search, for disambiguation"),
      },
    },
    async ({ path, quote, color, anchor, comment, page }) => {
      if (!isPdf(path)) throw new Error(`add_pdf_highlight works on .pdf files, got ${path}`);
      if (anchor !== undefined && !ANCHOR_NAME_RE.test(anchor)) {
        throw new Error(
          `invalid anchor name "${anchor}": letters, digits, _, -, :, / only, ` +
            `first character a letter or _, no spaces.`,
        );
      }
      const got = await api.readBytes(path);
      const doc = await loadPdfPages(got.bytes, page ? [page] : undefined);
      const matches = findQuote(doc.pages, quote);
      if (matches.length === 0) {
        throw new Error(
          `quote not found in ${path}${page ? ` on page ${page}` : ""}. ` +
            `Check it against read_pdf_text output (matching is whitespace-insensitive only).`,
        );
      }
      if (matches.length > 1) {
        const where = matches.map((m) => m.page).join(", ");
        throw new Error(
          `quote matched ${matches.length} times (page(s) ${where}). ` +
            (page ? `Extend the quote to make it unique on page ${page}.`
              : `Pass page to disambiguate, or extend the quote.`),
        );
      }
      const m = matches[0];

      const scPath = api.pdfSidecarPath(path);
      if (!(await api.exists(scPath))) await setPdfIncluded(path, true);
      const highlightId = randomUUID();
      await editSidecar(scPath, (sc) => {
        if (anchor && sc.anchors.some((a) => (a as { name?: string }).name === anchor)) {
          throw new Error(`anchor "${anchor}" already exists in ${scPath}, pick another name.`);
        }
        sc.highlights.push({ id: highlightId, color, page: m.page, rects: m.rects, text: m.text });
        if (anchor) sc.anchors.push({ name: anchor, highlightId });
        if (comment) sc.comments.push({ highlightId, body: comment, ts: Date.now() });
      });
      return json({
        highlightId,
        page: m.page,
        rects: m.rects.length,
        anchorLink: anchor ? `[[${api.basename(path)}%${anchor}]]` : undefined,
      });
    },
  );

  server.registerTool(
    "remove_pdf_highlight",
    {
      description:
        "Remove a highlight from a vault PDF's sidecar by id, over live collab. Anchors and " +
        "comments attached to the highlight are removed with it, like the app's right-click " +
        "Remove highlight.",
      inputSchema: {
        path: z.string().describe("Vault path of the .pdf"),
        highlight_id: z.string().min(1).describe("Highlight id, from add_pdf_highlight or the sidecar"),
      },
    },
    async ({ path, highlight_id }) => {
      if (!isPdf(path)) throw new Error(`remove_pdf_highlight works on .pdf files, got ${path}`);
      const scPath = api.pdfSidecarPath(path);
      if (!(await api.exists(scPath))) {
        throw new Error(`${path} has no sidecar at ${scPath}, so it has no highlights.`);
      }
      let anchorsRemoved = 0;
      let commentsRemoved = 0;
      await editSidecar(scPath, (sc) => {
        const hlId = (h: unknown) => (h as { id?: string }).id ?? "";
        const refId = (x: unknown) => (x as { highlightId?: string }).highlightId ?? "";
        if (!sc.highlights.some((h) => hlId(h) === highlight_id)) {
          const ids = sc.highlights.map(hlId).filter(Boolean);
          const shown = ids.slice(0, 20);
          throw new Error(
            `${path} has no highlight with id "${highlight_id}". ` +
              (shown.length > 0
                ? `Existing id(s)${ids.length > shown.length ? ` (first ${shown.length} of ${ids.length})` : ""}: ${shown.join(", ")}`
                : "The sidecar has no highlights."),
          );
        }
        // Cascade like the app (client/pdf/pdf_viewer.tsx removeHighlight):
        // drop the highlight plus its anchors and comments.
        sc.highlights = sc.highlights.filter((h) => hlId(h) !== highlight_id);
        anchorsRemoved = sc.anchors.filter((a) => refId(a) === highlight_id).length;
        commentsRemoved = sc.comments.filter((c) => refId(c) === highlight_id).length;
        sc.anchors = sc.anchors.filter((a) => refId(a) !== highlight_id);
        sc.comments = sc.comments.filter((c) => refId(c) !== highlight_id);
      });
      return json({ removed: highlight_id, anchorsRemoved, commentsRemoved });
    },
  );

  server.registerTool(
    "download_page",
    {
      description:
        "Download a .md or .pdf vault file's original bytes to dest on the MCP host machine " +
        "(the app's Download action: the raw file as-is, no export baking). dest must keep " +
        "the source extension, its parent directory is created when missing. Returns " +
        "{dest, bytes}.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        dest: z.string().describe(DEST_DESC),
      },
    },
    async ({ path, dest }) => {
      if (!isMd(path) && !isPdf(path)) {
        throw new Error(`download_page downloads .md and .pdf pages, got ${path}`);
      }
      const wantExt = isMd(path) ? ".md" : ".pdf";
      if (!dest.toLowerCase().endsWith(wantExt)) {
        throw new Error(
          `download_page copies the original file bytes, so dest must end in ${wantExt}, got: ${dest}`,
        );
      }
      const { bytes } = await api.readBytes(path);
      return json({ dest, bytes: await writeDest(dest, bytes) });
    },
  );
}
