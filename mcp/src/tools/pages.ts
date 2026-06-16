// Page and folder lifecycle tools: list/search, read/edit/write, create,
// include toggle, delete, and rename/move (page + folder).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "../api";
import { withRoom } from "../collab";
import { applySplices, computeSplices, type Splice } from "../diff";
import * as fm from "../frontmatter";
import { movePageFile, refactorLinks, renamePage } from "../rename";
import {
  countOccurrences,
  filePages,
  guardId,
  isJson,
  isMd,
  isPdf,
  json,
  PATH_DESC,
  setPdfIncluded,
  text,
} from "./helpers";

export function registerPageTools(server: McpServer): void {
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
}
