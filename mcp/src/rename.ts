// Rename/move a page with companion follow-up and a vault-wide wikilink
// refactor. Ported from client/lib/page_ops.ts renamePage and
// client/lib/refactor_links.ts. Resolution-based, not text-based: only
// links that resolved to a renamed page before AND no longer do after
// are rewritten, so title-keyed links and same-basename neighbors are
// left alone. The refactor takes a set of old -> new mappings, so a
// folder rename costs one vault pass no matter how many pages move.

import * as api from "./api";
import { resolveWikiLink, shortestLocator, type PageMeta } from "./wikilink";

/** Page name (index form) for a vault path: md drops the extension,
 *  pdf keeps it, anything else is not a page. */
function pathToPageName(p: string): string | null {
  if (p.toLowerCase().endsWith(".md")) return p.slice(0, -3);
  if (p.toLowerCase().endsWith(".pdf")) return p;
  return null;
}

function entryToMeta(e: api.Entry): PageMeta | null {
  if (e.type !== "file") return null;
  const name = pathToPageName(e.path);
  if (!name) return null;
  return { name, title: e.title ?? "", tags: e.tag ?? [] };
}

/// Parse one wikilink's interior, split out the path / name / position
/// marker / alias parts. The form is:
///   `[[<path>?<name><pos-marker>?<|alias>?]]`
/// Position markers: `#heading`, `@anchor`, `:label`, `%name`.
function splitInterior(inner: string): {
  main: string; // path prefix + name (the resolvable part)
  prefix: string; // everything up to and including the trailing '/'
  rest: string; // position marker + alias, e.g. "#sec|display"
} {
  const aliasIdx = inner.indexOf("|");
  const before = aliasIdx < 0 ? inner : inner.slice(0, aliasIdx);
  const alias = aliasIdx < 0 ? "" : inner.slice(aliasIdx);
  let posIdx = -1;
  for (let i = 0; i < before.length; i++) {
    if ("#@:%".includes(before[i])) {
      posIdx = i;
      break;
    }
  }
  const main = posIdx < 0 ? before : before.slice(0, posIdx);
  const pos = posIdx < 0 ? "" : before.slice(posIdx);
  const lastSlash = main.lastIndexOf("/");
  const prefix = lastSlash < 0 ? "" : main.slice(0, lastSlash + 1);
  return { main, prefix, rest: pos + alias };
}

/// Rewrite the body of one md file against a set of old -> new page
/// name mappings. Returns `null` when no change.
export function rewriteOne(
  body: string,
  mapping: ReadonlyMap<string, string>,
  before: readonly PageMeta[],
  after: readonly PageMeta[],
): string | null {
  let changed = false;
  const out = body.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner: string) => {
    const parts = splitInterior(inner);
    if (!parts.main) return whole; // bare position marker -> current file
    // Did it point at a renamed page before? Only then consider it.
    const was = resolveWikiLink(parts.main, before);
    if (was.kind !== "ok") return whole;
    const newName = mapping.get(was.page.name);
    if (!newName) return whole;
    // Still resolving to the page after the rename (e.g. title-keyed,
    // or tag-prefixed with an unchanged basename)? Leave it alone.
    const now = resolveWikiLink(parts.main, after);
    if (now.kind === "ok" && now.page.name === newName) return whole;
    const renamed = after.find((p) => p.name === newName);
    if (!renamed) return whole;
    changed = true;
    // Cheapest repair first: swap the basename in place. Fall back to a
    // locator guaranteed to resolve when the old prefix no longer fits
    // (the rename may have moved the file across folders).
    const newBase = newName.split("/").pop()!;
    const inPlace = `${parts.prefix}${newBase}`;
    const check = resolveWikiLink(inPlace, after);
    const main = check.kind === "ok" && check.page.name === newName
      ? inPlace
      : shortestLocator(renamed, after);
    return `[[${main}${parts.rest}]]`;
  });
  return changed ? out : null;
}

/// Walk the whole vault ONCE and rewrite every md whose links the given
/// renames broke (one pass covers any number of old -> new path pairs).
/// Runs AFTER the physical moves, so the listing reflects the new paths
/// - the pre-rename page list is synthesized by swapping the names back.
/// Returns the count of files actually rewritten.
export async function refactorLinks(
  renames: ReadonlyArray<readonly [string, string]>,
): Promise<number> {
  const mapping = new Map<string, string>();
  for (const [oldP, newP] of renames) {
    const oldName = pathToPageName(oldP);
    const newName = pathToPageName(newP);
    if (oldName && newName && oldName !== newName) mapping.set(oldName, newName);
  }
  if (mapping.size === 0) return 0;
  const entries = await api.listEntries();
  const after = entries.map(entryToMeta).filter((m): m is PageMeta => !!m);
  const oldByNew = new Map(Array.from(mapping, ([o, n]) => [n, o]));
  const before = after.map((p) => {
    const oldName = oldByNew.get(p.name);
    return oldName ? { ...p, name: oldName } : p;
  });
  const mdPaths = entries
    .filter((e) => e.type === "file" && e.path.toLowerCase().endsWith(".md"))
    .map((e) => e.path);
  // Bounded concurrency: each file's read -> rewrite -> write is
  // independent, batches of 8 cut wall time without flooding the server.
  const BATCH = 8;
  let touched = 0;
  for (let i = 0; i < mdPaths.length; i += BATCH) {
    const results = await Promise.all(
      mdPaths.slice(i, i + BATCH).map(async (p) => {
        const got = await api.readFileOrNull(p);
        if (!got) return false;
        const rewritten = rewriteOne(got.text, mapping, before, after);
        if (rewritten === null) return false;
        await api.writeFile(p, rewritten, { contentType: "text/markdown" });
        return true;
      }),
    );
    for (const ok of results) if (ok) touched++;
  }
  return touched;
}

export type RenameResult = { moved: number; linksRewritten: number };

/** Physically move one page: read old -> probe target (refuse to
 *  clobber) -> PUT new -> DELETE old, rolling the copy back if the
 *  delete fails so two files never share the same id. Then carries the
 *  PDF sidecar / markdown assets folder along (best-effort, like the
 *  client). Returns the count of files moved. The wikilink refactor is
 *  the caller's job, so batch moves can share one pass. */
export async function movePageFile(fullPath: string, newFullPath: string): Promise<number> {
  const isMd = fullPath.toLowerCase().endsWith(".md");
  const isPdf = fullPath.toLowerCase().endsWith(".pdf");
  let moved = 0;

  const old = await api.readBytes(fullPath);
  if (await api.exists(newFullPath)) {
    throw new Error(`target ${newFullPath} already exists, refusing to overwrite it.`);
  }
  await api.writeFile(newFullPath, old.bytes, { contentType: old.contentType });
  try {
    await api.deleteFile(fullPath);
  } catch (e) {
    // Roll back so we don't leave two copies sharing the same id.
    await api.deleteFile(newFullPath).catch(() => {});
    throw new Error(`delete of the old path failed, rolled back: ${e instanceof Error ? e.message : e}`);
  }
  moved++;

  if (isPdf) {
    const oldSc = api.pdfSidecarPath(fullPath);
    const got = await api.readBytesOrNull(oldSc).catch(() => null);
    if (got) {
      await api
        .writeFile(api.pdfSidecarPath(newFullPath), got.bytes, { contentType: "application/json" })
        .then(() => api.deleteFile(oldSc))
        .then(() => moved++)
        .catch(() => {});
    }
  }

  // file.md: ".<name>.assets/ follows the markdown file on rename". The
  // plain listing prunes dot-dirs, only ?prefix= can see them.
  if (isMd) {
    const oldPrefix = api.mdAssetsPrefix(fullPath);
    const newPrefix = api.mdAssetsPrefix(newFullPath);
    const paths = await api.listUnderPrefix(oldPrefix).catch(() => [] as string[]);
    for (const p of paths) {
      const got = await api.readBytesOrNull(p).catch(() => null);
      if (!got) continue;
      await api
        .writeFile(newPrefix + p.slice(oldPrefix.length), got.bytes, { contentType: got.contentType })
        .then(() => api.deleteFile(p))
        .then(() => moved++)
        .catch(() => {});
    }
    if (paths.length > 0) await api.deleteFile(oldPrefix.replace(/\/$/, "")).catch(() => {});
  }

  return moved;
}

/** Rename / move a page and rewrite every [[wikilink]] that pointed at
 *  the old name (the link pass is best-effort, like the client). */
export async function renamePage(fullPath: string, newFullPath: string): Promise<RenameResult> {
  const moved = await movePageFile(fullPath, newFullPath);
  const linksRewritten = await refactorLinks([[fullPath, newFullPath]]).catch(() => 0);
  return { moved, linksRewritten };
}
