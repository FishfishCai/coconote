// Shared helpers for the tool registrars: result wrappers, path predicates,
// listing/id resolution, source loading, and the sidecar collab-edit
// boilerplate. Handlers stay thin over api.ts / collab.ts, semantics are
// ported from client/lib.

import { readFile as readLocalFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as api from "../api";
import { withRoom } from "../collab";
import { applySplices, computeSplices } from "../diff";
import * as fm from "../frontmatter";

export const MB = 1024 * 1024;

export const PATH_DESC = "Vault path, root-prefixed, e.g. main/notes/foo.md";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function json(data: unknown): ToolResult {
  return text(JSON.stringify(data, null, 2));
}

export const isMd = (p: string) => p.toLowerCase().endsWith(".md");
export const isPdf = (p: string) => p.toLowerCase().endsWith(".pdf");
export const isJson = (p: string) => p.toLowerCase().endsWith(".json");

export function mapEntry(e: api.Entry) {
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

export async function filePages(all = false) {
  return (await api.listEntries(all)).filter((e) => e.type === "file").map(mapEntry);
}

/** History is keyed by page id: md frontmatter `id:`, pdf/json sidecar
 *  `metadata.id`. */
export async function resolvePageId(path: string): Promise<string> {
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

export function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** Read bytes from an absolute local path or an http(s) URL. */
export async function loadSource(source: string, capBytes: number): Promise<Uint8Array> {
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

export function sourceBasename(source: string): string {
  if (/^https?:\/\//i.test(source)) {
    return decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "");
  }
  return api.basename(source);
}

/** Flip or create the PDF include sidecar (client/lib/include.ts and
 *  page_ops.ts removeFromIndex semantics). A fresh include sidecar gets
 *  a generated id, a fresh exclude sidecar stays id-less. */
export async function setPdfIncluded(
  pdfPath: string,
  included: boolean,
): Promise<"created" | "updated"> {
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
export function guardId(path: string, current: string, next: string): void {
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

/** Mutate a PDF sidecar over live collab: read the current JSON, apply
 *  `mutate` to the parsed sidecar, and write back the minimal diff. The
 *  mutator may throw (nothing is applied) or close over outer state. */
export async function editSidecar(
  scPath: string,
  mutate: (sc: ReturnType<typeof fm.parseSidecar>) => void,
): Promise<void> {
  await withRoom(scPath, ({ doc, ytext }) => {
    const current = ytext.toString();
    const sc = fm.parseSidecar(current);
    mutate(sc);
    const splices = computeSplices(current, fm.sidecarJson(sc));
    doc.transact(() => applySplices(ytext, splices));
  });
}
