// The tools. Handlers stay thin over api.ts / collab.ts, semantics
// are ported from client/lib (page_ops, include, frontmatter_edit,
// refactor_links, sync_push, sync_pull).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { readFile as readLocalFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as api from "./api";
import { withRoom } from "./collab";
import { applySplices, computeSplices, type Splice } from "./diff";
import { buildHtmlExport, buildPdfExport, writeDest } from "./export";
import { exportSite } from "./site";
import * as fm from "./frontmatter";
import { findQuote, loadPdfPages } from "./pdf";
import { movePageFile, refactorLinks, renamePage } from "./rename";
import { pushPage } from "./sync/push";
import { pullPage } from "./sync/pull";
import markdownFull from "../guide/markdown.full.md";
import wikilinkFull from "../guide/wikilink.full.md";
import fileFull from "../guide/file.full.md";
import pdfFull from "../guide/pdf.full.md";

const MB = 1024 * 1024;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

function json(data: unknown): ToolResult {
  return text(JSON.stringify(data, null, 2));
}

const isMd = (p: string) => p.toLowerCase().endsWith(".md");
const isPdf = (p: string) => p.toLowerCase().endsWith(".pdf");
const isJson = (p: string) => p.toLowerCase().endsWith(".json");

const PATH_DESC = "Vault path, root-prefixed, e.g. main/notes/foo.md";

function mapEntry(e: api.Entry) {
  return {
    path: e.path,
    title: e.title ?? "",
    tags: e.tag ?? [],
    headings: e.headings ?? [],
    wikilinks: e.wikilinks ?? [],
    size: e.size,
    mtime: e.mtime,
    // Marked only on the excluded rows of an all listing.
    ...(e.coconote === false ? { included: false } : {}),
  };
}

async function filePages(all = false) {
  return (await api.listEntries(all)).filter((e) => e.type === "file").map(mapEntry);
}

/** History is keyed by page id: md frontmatter `id:`, pdf/json sidecar
 *  `metadata.id`. */
async function resolvePageId(path: string): Promise<string> {
  if (isMd(path)) {
    const { text: body } = await api.readFile(path);
    const id = fm.frontmatterId(body);
    if (!id) {
      throw new Error(
        `${path} has no frontmatter id yet. The server injects one when an ` +
          `included (coconote: true) page is first indexed, so there is no history to address.`,
      );
    }
    return id;
  }
  if (isPdf(path) || isJson(path)) {
    const scPath = isPdf(path) ? api.pdfSidecarPath(path) : path;
    const got = await api.readFileOrNull(scPath);
    if (!got) {
      throw new Error(
        `no sidecar at ${scPath}. PDF history lives under the sidecar's metadata.id ` +
          `(set_included creates the sidecar).`,
      );
    }
    const id = fm.parseSidecar(got.text).metadata.id;
    if (!id) throw new Error(`sidecar ${scPath} has no metadata.id, so it has no history.`);
    return id;
  }
  throw new Error(`history is only tracked for .md and .pdf pages, not ${path}`);
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** Read bytes from an absolute local path or an http(s) URL. */
async function loadSource(source: string, capBytes: number): Promise<Uint8Array> {
  const capMb = Math.round(capBytes / MB);
  if (/^https?:\/\//i.test(source)) {
    let res: Response;
    try {
      res = await fetch(source);
    } catch (e) {
      throw new Error(`download ${source} failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw new Error(`download ${source}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > capBytes) {
      throw new Error(`${source} is ${(buf.byteLength / MB).toFixed(1)}MB, over the ${capMb}MB cap`);
    }
    return buf;
  }
  if (!isAbsolute(source)) {
    throw new Error(`source must be an absolute local file path or an http(s) URL, got: ${source}`);
  }
  const st = await stat(source).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`local file not found: ${source}`);
  if (st.size > capBytes) {
    throw new Error(`${source} is ${(st.size / MB).toFixed(1)}MB, over the ${capMb}MB cap`);
  }
  return new Uint8Array(await readLocalFile(source));
}

function sourceBasename(source: string): string {
  if (/^https?:\/\//i.test(source)) {
    return decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
  }
  return api.basename(source);
}

/** Flip or create the PDF include sidecar (client/lib/include.ts and
 *  page_ops.ts removeFromIndex semantics). A fresh include sidecar gets
 *  a generated id, a fresh exclude sidecar stays id-less. */
async function setPdfIncluded(pdfPath: string, included: boolean): Promise<"created" | "updated"> {
  const scPath = api.pdfSidecarPath(pdfPath);
  const existing = await api.readFileOrNull(scPath);
  if (existing) {
    const sc = fm.parseSidecar(existing.text);
    sc.metadata.coconote = included;
    await api.writeFile(scPath, fm.sidecarJson(sc), {
      contentType: "application/json",
      ifUnmodifiedSince: existing.mtime,
    });
    return "updated";
  }
  const sc = included ? fm.freshIncludeSidecar(api.pdfStem(pdfPath)) : fm.emptySidecar();
  sc.metadata.coconote = included;
  await api.writeFile(scPath, fm.sidecarJson(sc), { contentType: "application/json" });
  return "created";
}

/** write_page id guard: never drop or change an existing page id. */
function guardId(path: string, current: string, next: string): void {
  let oldId = "";
  let newId = "";
  if (isMd(path)) {
    oldId = fm.frontmatterId(current);
    newId = fm.frontmatterId(next);
  } else if (isJson(path)) {
    oldId = fm.parseSidecar(current).metadata.id;
    newId = fm.parseSidecar(next).metadata.id;
  } else {
    return;
  }
  if (oldId && newId !== oldId) {
    throw new Error(
      `refusing to write ${path}: the existing ${isMd(path) ? "frontmatter id" : "sidecar metadata.id"} ` +
        `"${oldId}" would be ${newId ? `changed to "${newId}"` : "dropped"}. ` +
        `History is keyed by this id. Keep it exactly as is and retry.`,
    );
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_pages",
    {
      description:
        "List every file in the vault with path, title, tags, headings, wikilinks, size, and " +
        "mtime (ms epoch). Optional prefix narrows to one folder subtree. With all: true the " +
        "listing also covers .md/.pdf files not in the Coconote index (rows marked " +
        "included: false), the candidates for set_included.",
      inputSchema: {
        prefix: z.string().optional().describe("Folder prefix filter, e.g. main/notes"),
        all: z.boolean().optional().describe("Also list excluded .md/.pdf files (the app's All view)"),
      },
    },
    async ({ prefix, all }) => {
      let rows = await filePages(all);
      if (prefix) {
        const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
        rows = rows.filter((r) => r.path.startsWith(p));
      }
      return json(rows);
    },
  );

  server.registerTool(
    "search_pages",
    {
      description:
        "Case-insensitive substring search over page paths, titles, tags, and headings " +
        "(the same fields the app's filter matches). Returns the matching listing rows. " +
        "With all: true the search also covers .md/.pdf files not in the Coconote index " +
        "(matches marked included: false).",
      inputSchema: {
        query: z.string().min(1).describe("Substring to match"),
        all: z.boolean().optional().describe("Also search excluded .md/.pdf files (the app's All view)"),
      },
    },
    async ({ query, all }) => {
      const q = query.toLowerCase();
      const hits = (await filePages(all)).filter(
        (p) =>
          p.path.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.headings.some((h) => h.toLowerCase().includes(q)),
      );
      return json(hits);
    },
  );

  server.registerTool(
    "read_page",
    {
      description:
        "Read a page as {content, id, lastModified}: the text content (markdown body including " +
        "frontmatter, or any text file), the page id (frontmatter id / sidecar metadata.id, empty " +
        "when unassigned), and the mtime in ms epoch.",
      inputSchema: { path: z.string().describe(PATH_DESC) },
    },
    async ({ path }) => {
      if (isPdf(path)) {
        throw new Error(
          `${path} is a binary PDF: use read_pdf_text for its text. Its highlights and ` +
            `metadata live in the sidecar ${api.pdfSidecarPath(path)}, which read_page can read.`,
        );
      }
      const { text: content, mtime } = await api.readFile(path);
      const id = isMd(path)
        ? fm.frontmatterId(content)
        : isJson(path)
          ? fm.parseSidecar(content).metadata.id
          : "";
      return json({ content, id, lastModified: mtime });
    },
  );

  server.registerTool(
    "edit_page",
    {
      description:
        "Apply exact string replacements to a live page over collab. Each old_str must match " +
        "exactly once in the current text (edits apply in order, later edits see earlier ones). " +
        "On a match failure nothing is applied: re-read the page and retry. Preferred over write_page.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        edits: z
          .array(
            z.object({
              old_str: z.string().min(1).describe("Exact existing text, must occur exactly once"),
              new_str: z.string().describe("Replacement text"),
            }),
          )
          .min(1),
      },
    },
    async ({ path, edits }) => {
      if (isPdf(path)) {
        throw new Error(`${path} is a binary PDF and cannot be edited as text. Its sidecar ${api.pdfSidecarPath(path)} can.`);
      }
      await withRoom(path, ({ doc, ytext }) => {
        // Validate every edit against a simulated copy first, so a
        // failure applies nothing.
        const splices: Splice[] = [];
        let sim = ytext.toString();
        for (let i = 0; i < edits.length; i++) {
          const { old_str, new_str } = edits[i];
          const n = countOccurrences(sim, old_str);
          if (n !== 1) {
            throw new Error(
              `edit ${i + 1} of ${edits.length} failed: old_str matched ${n} time(s), need exactly 1. ` +
                `No edits were applied (0/${edits.length}). Re-read the page and retry with a ` +
                `longer, unique old_str.`,
            );
          }
          const index = sim.indexOf(old_str);
          splices.push({ index, deleteLen: old_str.length, insertText: new_str });
          sim = sim.slice(0, index) + new_str + sim.slice(index + old_str.length);
        }
        doc.transact(() => applySplices(ytext, splices));
      });
      return text(`Applied ${edits.length} edit(s) to ${path}.`);
    },
  );

  server.registerTool(
    "write_page",
    {
      description:
        "Replace a page's full content over collab (applied as a minimal diff). Refuses to drop " +
        "or change an existing page id. Prefer edit_page for targeted changes.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        content: z.string().describe("Full new content of the page"),
      },
    },
    async ({ path, content }) => {
      if (isPdf(path)) {
        throw new Error(`${path} is a binary PDF and cannot be written as text. Use import_file to replace it.`);
      }
      return await withRoom(path, ({ doc, ytext }) => {
        const current = ytext.toString();
        guardId(path, current, content);
        if (current === content) return text(`${path} already has exactly this content.`);
        const splices = computeSplices(current, content);
        doc.transact(() => applySplices(ytext, splices));
        return text(`Wrote ${path} (${splices.length} splice(s) against the previous content).`);
      });
    },
  );

  server.registerTool(
    "create_page",
    {
      description:
        "Create a new markdown page (.md appended when missing). A same-named on-disk file that " +
        "is not in Coconote gets coconote: true flipped instead, keeping its body. Fails when the " +
        "page is already included. Never sets an id (the server assigns one).",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        content: z.string().optional().describe("Initial markdown content (frontmatter optional, no id)"),
      },
    },
    async ({ path, content }) => {
      if (isPdf(path)) throw new Error("create_page creates markdown pages only. Use import_file for PDFs.");
      const fsPath = api.nameToFsPath(path);
      const existing = await api.readFileOrNull(fsPath);
      if (existing === null) {
        let body: string;
        if (content !== undefined) {
          if (fm.frontmatterId(content)) {
            throw new Error(
              "do not put an id in new page frontmatter: the server assigns one on first index. " +
                "Remove the id line and retry.",
            );
          }
          body = fm.setFrontmatterKey(content, "coconote", "true");
        } else {
          body = "---\ncoconote: true\n---\n";
        }
        await api.writeFile(fsPath, body);
        return text(`Created ${fsPath}.`);
      }
      if (fm.hasCoconoteTrue(existing.text)) throw new Error(`${fsPath} is already in Coconote.`);
      await api.writeFile(fsPath, fm.setFrontmatterKey(existing.text, "coconote", "true"), {
        ifUnmodifiedSince: existing.mtime,
      });
      return text(
        `${fsPath} already existed on disk, flipped coconote: true to admit it. Body kept` +
          (content !== undefined ? " (the provided content was ignored, use edit_page to change it)." : "."),
      );
    },
  );

  server.registerTool(
    "create_folder",
    {
      description: "Create an empty folder in the vault.",
      inputSchema: { path: z.string().describe("Vault folder path, root-prefixed, e.g. main/notes") },
    },
    async ({ path }) => {
      await api.mkdir(path);
      return text(`Created folder ${path}.`);
    },
  );

  server.registerTool(
    "set_included",
    {
      description:
        "Include or exclude a .md / .pdf file from the Coconote index without touching its body. " +
        "md: flips frontmatter coconote. pdf: flips (or creates) the sidecar's metadata.coconote.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        included: z.boolean(),
      },
    },
    async ({ path, included }) => {
      if (isMd(path)) {
        const existing = await api.readFileOrNull(path);
        if (existing === null) {
          if (!included) throw new Error(`${path} not found`);
          await api.writeFile(path, "---\ncoconote: true\n---\n");
          return text(`${path} did not exist, created it with coconote: true.`);
        }
        await api.writeFile(path, fm.setFrontmatterKey(existing.text, "coconote", String(included)), {
          ifUnmodifiedSince: existing.mtime,
        });
        return text(`Set coconote: ${included} on ${path}.`);
      }
      if (isPdf(path)) {
        const what = await setPdfIncluded(path, included);
        return text(`Sidecar ${api.pdfSidecarPath(path)} ${what} with coconote: ${included}.`);
      }
      throw new Error(`${path} has no include flag: only .md and .pdf pages do.`);
    },
  );

  server.registerTool(
    "delete_page",
    {
      description:
        "Physically delete a file, or an empty folder. For .md also deletes its .<stem>.assets/ " +
        "folder, for .pdf also deletes its sidecar (companion cleanup is best-effort). Not " +
        "undoable via history.",
      inputSchema: { path: z.string().describe(PATH_DESC) },
    },
    async ({ path }) => {
      await api.deleteFile(path);
      const cleaned: string[] = [];
      if (isPdf(path)) {
        const sc = api.pdfSidecarPath(path);
        await api.deleteFile(sc).then(() => cleaned.push(sc)).catch(() => {});
      } else if (isMd(path)) {
        const prefix = api.mdAssetsPrefix(path);
        const under = await api.listUnderPrefix(prefix).catch(() => [] as string[]);
        for (const p of under) {
          await api.deleteFile(p).then(() => cleaned.push(p)).catch(() => {});
        }
        await api.deleteFile(prefix.replace(/\/$/, "")).catch(() => {});
      }
      return text(
        `Deleted ${path}` +
          (cleaned.length > 0 ? ` and ${cleaned.length} companion file(s): ${cleaned.join(", ")}` : "") +
          ".",
      );
    },
  );

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
    "page_history",
    {
      description:
        "List a page's version history ([{ts, save_type}]), or with ts return that snapshot's " +
        "text for preview. Works for .md pages and for .pdf pages via their sidecar.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().optional().describe("Snapshot timestamp (ms epoch) to preview"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      if (ts !== undefined) return text(await api.historySnapshot(id, ts));
      return json({ page_id: id, versions: await api.historyList(id) });
    },
  );

  server.registerTool(
    "restore_version",
    {
      description: "Restore a page to a history snapshot. Writes it back and appends a new edit row.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().describe("Snapshot timestamp (ms epoch), from page_history"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      await api.historyRestore(id, ts);
      return text(`Restored ${path} (page ${id}) to snapshot ${ts}.`);
    },
  );

  server.registerTool(
    "pin_version",
    {
      description:
        "Pin the latest version of a page: appends a pin row that retention pruning never " +
        "removes (it can still be deleted explicitly with delete_version).",
      inputSchema: { path: z.string().describe(PATH_DESC) },
    },
    async ({ path }) => {
      const id = await resolvePageId(path);
      await api.historyPin(id);
      return text(`Pinned the latest version of ${path} (page ${id}).`);
    },
  );

  server.registerTool(
    "delete_version",
    {
      description: "Delete a single version row from a page's history.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().describe("Snapshot timestamp (ms epoch), from page_history"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      await api.historyDeleteVersion(id, ts);
      return text(`Deleted version ${ts} of ${path} (page ${id}).`);
    },
  );

  server.registerTool(
    "rename_page",
    {
      description:
        "Rename / move a page inside its root (the first path segment is fixed, roots are " +
        "managed in Setting). Carries the md assets folder / pdf sidecar along and rewrites " +
        "every [[wikilink]] in the vault that pointed at the old name. Refuses to overwrite " +
        "an existing target. Returns {moved, linksRewritten}.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        new_path: z.string().describe("New vault path, same root, e.g. main/archive/foo.md"),
      },
    },
    async ({ path, new_path }) => {
      const from = api.nameToFsPath(path);
      const to = api.nameToFsPath(new_path);
      const [oldRoot] = from.split("/");
      const [newRoot] = to.split("/");
      if (oldRoot !== newRoot) {
        throw new Error(
          `cannot move ${from} from root "${oldRoot}" to "${newRoot}": a rename keeps the page ` +
            `inside its root (roots are fixed, managed via the server config / Setting).`,
        );
      }
      if (isPdf(from) !== isPdf(to)) {
        throw new Error(`cannot rename across file types (${from} -> ${to}).`);
      }
      const counts = await renamePage(from, to);
      return json({ ...counts, path: to });
    },
  );

  server.registerTool(
    "rename_folder",
    {
      description:
        "Rename / move a folder inside its root: moves every included page under old_path to " +
        "new_path (assets folders and pdf sidecars follow), then repairs every broken " +
        "[[wikilink]] in one vault-wide pass. Files not in Coconote stay in the old folder, " +
        "like the app's folder Rename. Returns {pagesMoved, linksRewritten}.",
      inputSchema: {
        old_path: z.string().describe("Vault folder path, root-prefixed, e.g. main/notes"),
        new_path: z.string().describe("New folder path, same root, e.g. main/archive"),
      },
    },
    async ({ old_path, new_path }) => {
      const from = old_path.replace(/\/+$/, "");
      const to = new_path.replace(/\/+$/, "");
      const [oldRoot] = from.split("/");
      const [newRoot] = to.split("/");
      if (oldRoot !== newRoot) {
        throw new Error(
          `cannot move ${from} from root "${oldRoot}" to "${newRoot}": a rename keeps the ` +
            `folder inside its root (roots are fixed, managed via the server config / Setting).`,
        );
      }
      if (to === from || to.startsWith(`${from}/`)) {
        throw new Error(`cannot move ${from} to ${to}: the target is the folder itself or inside it.`);
      }
      const prefix = `${from}/`;
      const under = (await api.listEntries(true)).filter(
        (e) => e.type === "file" && e.path.startsWith(prefix),
      );
      const pages = under.filter((e) => (isMd(e.path) || isPdf(e.path)) && e.coconote !== false);
      if (pages.length === 0) {
        throw new Error(
          `${from} has no included pages to move` +
            (under.length > 0 ? ` (${under.length} file(s) under it are not in Coconote)` : "") +
            ".",
        );
      }
      const pairs = pages.map((e) => [e.path, to + "/" + e.path.slice(prefix.length)] as const);
      const collisions = (
        await Promise.all(pairs.map(async ([, t]) => ((await api.exists(t)) ? t : null)))
      ).filter((t): t is string => t !== null);
      if (collisions.length > 0) {
        throw new Error(
          `target(s) already exist, refusing to overwrite: ${collisions.slice(0, 10).join(", ")}` +
            `${collisions.length > 10 ? ` and ${collisions.length - 10} more` : ""}. Nothing was moved.`,
        );
      }
      for (const [oldP, newP] of pairs) await movePageFile(oldP, newP);
      const linksRewritten = await refactorLinks(pairs).catch(() => 0);
      const leftBehind = under.length - pages.length;
      if (leftBehind === 0) await api.deleteFile(from).catch(() => {});
      return json({
        from,
        to,
        pagesMoved: pairs.length,
        linksRewritten,
        ...(leftBehind > 0
          ? { note: `${leftBehind} file(s) not in Coconote stay under ${from}/.` }
          : {}),
      });
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

  /** client/markdown/parser/constants.ts ANCHOR_NAME_RE, anchored. */
  const ANCHOR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_/:-]*$/;

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
      await withRoom(scPath, ({ doc: ydoc, ytext }) => {
        const current = ytext.toString();
        const sc = fm.parseSidecar(current);
        if (anchor && sc.anchors.some((a) => (a as { name?: string }).name === anchor)) {
          throw new Error(`anchor "${anchor}" already exists in ${scPath}, pick another name.`);
        }
        sc.highlights.push({ id: highlightId, color, page: m.page, rects: m.rects, text: m.text });
        if (anchor) sc.anchors.push({ name: anchor, highlightId });
        if (comment) sc.comments.push({ highlightId, body: comment, ts: Date.now() });
        const splices = computeSplices(current, fm.sidecarJson(sc));
        ydoc.transact(() => applySplices(ytext, splices));
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
      await withRoom(scPath, ({ doc: ydoc, ytext }) => {
        const current = ytext.toString();
        const sc = fm.parseSidecar(current);
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
        const splices = computeSplices(current, fm.sidecarJson(sc));
        ydoc.transact(() => applySplices(ytext, splices));
      });
      return json({ removed: highlight_id, anchorsRemoved, commentsRemoved });
    },
  );

  server.registerTool(
    "push_page",
    {
      description:
        "Push a local page to another Coconote server (history.md Push). Same-id remote pages " +
        "fast-forward or merge (base = the last push/pull row). Returns a structured outcome: " +
        "on pathCollision re-call with overwrite: true, on conflict merge the returned " +
        "baseText/localText/remoteText yourself and re-call with merged_content.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        target_url: z.string().describe("Base URL of the target server, e.g. http://host:40704"),
        target_root: z.string().describe("Root name on the target where a NEW file lands"),
        target_token: z.string().optional().describe("Target server auth token (required off-loopback)"),
        overwrite: z.boolean().optional().describe("Confirm overwriting a pathCollision occupant"),
        merged_content: z.string().optional().describe("Resolved full text after a conflict outcome"),
      },
    },
    async ({ path, target_url, target_root, target_token, overwrite, merged_content }) =>
      json(await pushPage({
        path,
        targetUrl: target_url,
        targetRoot: target_root,
        targetToken: target_token,
        overwrite,
        mergedContent: merged_content,
      })),
  );

  server.registerTool(
    "pull_page",
    {
      description:
        "Pull a page from another Coconote server into a local root (history.md Pull, the " +
        "mirror of push_page). Same-id local pages fast-forward or merge. Returns a structured " +
        "outcome: on pathCollision re-call with overwrite: true, on conflict merge the returned " +
        "texts yourself and re-call with merged_content.",
      inputSchema: {
        remote_url: z.string().describe("Base URL of the remote server, e.g. http://host:40704"),
        remote_path: z.string().describe("Path on the remote, root-prefixed, e.g. work/notes/foo.md"),
        target_root: z.string().describe("Local root name where a NEW file lands"),
        remote_token: z.string().optional().describe("Remote server auth token (required off-loopback)"),
        overwrite: z.boolean().optional().describe("Confirm overwriting a pathCollision occupant"),
        merged_content: z.string().optional().describe("Resolved full text after a conflict outcome"),
      },
    },
    async ({ remote_url, remote_path, target_root, remote_token, overwrite, merged_content }) =>
      json(await pullPage({
        remoteUrl: remote_url,
        remotePath: remote_path,
        targetRoot: target_root,
        remoteToken: remote_token,
        overwrite,
        mergedContent: merged_content,
      })),
  );

  const DEST_DESC =
    "Absolute destination file path on the machine running the MCP server " +
    "(missing parent directories are created)";

  server.registerTool(
    "export_page",
    {
      description:
        "Export a page (the app's Export action). A .md page becomes one self-contained " +
        "offline HTML file (app CSS, fonts, and vault images inlined, math statically " +
        "rendered, cross-page wikilinks degraded to plain spans, light theme - print it from " +
        "a browser to get a PDF), dest must end in .html. A .pdf page becomes a copy with its " +
        "sidecar highlights baked into the pages (semi-transparent rects), dest must end in " +
        ".pdf. Writes the result to dest on the MCP host machine, creating the parent " +
        "directory when missing, and returns {dest, bytes}.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        dest: z.string().describe(DEST_DESC),
      },
    },
    async ({ path, dest }) => {
      if (!isMd(path) && !isPdf(path)) {
        throw new Error(`export_page exports .md and .pdf pages, got ${path}`);
      }
      const wantExt = isMd(path) ? ".html" : ".pdf";
      if (!dest.toLowerCase().endsWith(wantExt)) {
        throw new Error(
          `a ${isMd(path) ? ".md page exports as self-contained HTML" : ".pdf page exports as a baked PDF"}, ` +
            `so dest must end in ${wantExt}, got: ${dest}`,
        );
      }
      const data = isMd(path) ? await buildHtmlExport(path) : await buildPdfExport(path);
      return json({ dest, bytes: await writeDest(dest, data) });
    },
  );

  server.registerTool(
    "export_site",
    {
      description:
        "Export the whole vault as a static website (the app's Export Site action): Path / Tag " +
        "/ Graph view shells, every included page (.md as HTML with relative wikilinks, .pdf " +
        "with highlights baked), referenced images, and the shared viewer assets. Writes the " +
        "site into the dest directory on the MCP host machine, ready for any static host. One " +
        "call regenerates the full site. Returns {dest, files, bytes, skipped}.",
      inputSchema: {
        dest: z.string().describe(
          "Absolute destination directory on the machine running the MCP server " +
            "(created when missing, must be empty)",
        ),
      },
    },
    async ({ dest }) => json(await exportSite(dest)),
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
          `download_page copies the original file bytes, so dest must end in ` +
            `${wantExt}, got: ${dest}`,
        );
      }
      const { bytes } = await api.readBytes(path);
      return json({ dest, bytes: await writeDest(dest, bytes) });
    },
  );

  const GUIDES: Record<string, string> = {
    markdown: markdownFull,
    wikilink: wikilinkFull,
    file: fileFull,
    pdf: pdfFull,
  };

  server.registerTool(
    "get_syntax",
    {
      description:
        "Full reference for Coconote conventions: markdown dialect, [[wikilink]] syntax, on-disk " +
        "file layout, or PDF sidecars. Read before writing non-trivial content.",
      inputSchema: { topic: z.enum(["markdown", "wikilink", "file", "pdf"]) },
    },
    async ({ topic }) => text(GUIDES[topic]),
  );
}
