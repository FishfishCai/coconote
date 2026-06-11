// Vault-wide wikilink refactor on Rename (content.md Rename: "Any
// [[wikilink]] pointing at the old name is rewritten"). Resolution-based,
// not text-based: rewrite only links that resolved to the renamed page
// before AND no longer do after - title-keyed links keep working, and a
// different page merely sharing the basename (`[[archive/foo]]` vs
// renamed `notes/foo`) is left alone.

import type { PageMeta } from "coconote/type/page";
import { authedFetch } from "./authed_fetch.ts";
import { fileUrl } from "../spaces/constants.ts";
import { resolveWikiLink, shortestLocator } from "./wikilink.ts";

type Entry = {
  type?: string;
  path?: string;
  title?: string;
  tag?: string[];
};

/// Parse one wikilink's interior, split out the path / name / position
/// marker / alias parts. The form is:
///   `[[<path>?<name><pos-marker>?<|alias>?]]`
/// Position markers: `#heading`, `@anchor`, `:label`, `%name`.
function splitInterior(inner: string): {
  main: string;         // path prefix + name (the resolvable part)
  prefix: string;       // everything up to and including the trailing '/'
  rest: string;         // position marker + alias, e.g. "#sec|display"
} {
  const aliasIdx = inner.indexOf("|");
  const before = aliasIdx < 0 ? inner : inner.slice(0, aliasIdx);
  const alias = aliasIdx < 0 ? "" : inner.slice(aliasIdx);
  let posIdx = -1;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === "#" || c === "@" || c === ":" || c === "%") {
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

/** Page name (index form) for a vault path: md drops the extension,
 *  pdf keeps it, anything else is not a page. */
function pathToPageName(p: string): string | null {
  if (p.toLowerCase().endsWith(".md")) return p.slice(0, -3);
  if (p.toLowerCase().endsWith(".pdf")) return p;
  return null;
}

function entryToMeta(e: Entry): PageMeta | null {
  const p = e.path;
  if (!p || e.type !== "file") return null;
  const name = pathToPageName(p);
  if (!name) return null;
  return {
    ref: name,
    name,
    tag: "page",
    created: "",
    lastModified: "",
    perm: "rw",
    tags: e.tag ?? [],
    title: e.title ?? "",
  };
}

/// Rewrite the body of one md file. Returns `null` when no change.
/// Exposed for tests - `refactorLinks` wires the page lists.
export function rewriteOne(
  body: string,
  oldName: string,
  newName: string,
  before: readonly PageMeta[],
  after: readonly PageMeta[],
): string | null {
  const renamed = after.find((p) => p.name === newName);
  if (!renamed) return null;
  const re = /\[\[([^\]\n]+)\]\]/g;
  let changed = false;
  const out = body.replace(re, (whole, inner: string) => {
    const parts = splitInterior(inner);
    if (!parts.main) return whole; // bare position marker -> current file
    // Still resolving to the page after the rename (e.g. title-keyed,
    // or tag-prefixed with an unchanged basename)? Leave it alone.
    const now = resolveWikiLink(parts.main, after);
    if (now.kind === "ok" && now.page.name === newName) return whole;
    // Did it point at the renamed page before? Only then rewrite.
    const wasResolved = resolveWikiLink(parts.main, before);
    if (wasResolved.kind !== "ok" || wasResolved.page.name !== oldName) {
      return whole;
    }
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

/// Walk the whole vault and rewrite every md whose links the rename
/// broke. Runs AFTER the physical move, so the listing reflects the new
/// path - the pre-rename page list is synthesized by swapping the name
/// back. Returns the count of files actually rewritten.
export async function refactorLinks(
  oldFullPath: string,
  newFullPath: string,
): Promise<number> {
  const oldName = pathToPageName(oldFullPath);
  const newName = pathToPageName(newFullPath);
  if (!oldName || !newName || oldName === newName) return 0;
  const list = await authedFetch("/.file");
  if (!list.ok) return 0;
  const entries: Entry[] = await list.json();
  const after = entries.map(entryToMeta).filter((m): m is PageMeta => !!m);
  const before = after.map((p) =>
    p.name === newName ? { ...p, name: oldName } : p
  );
  const mdPaths = entries
    .map((e) => e.path)
    .filter((p): p is string => !!p && p.toLowerCase().endsWith(".md"));
  // Bounded concurrency: each file's read -> rewrite -> write is
  // independent, so batches of 8 cut wall time on large vaults without
  // flooding the server.
  const BATCH = 8;
  let touched = 0;
  for (let i = 0; i < mdPaths.length; i += BATCH) {
    const results = await Promise.all(
      mdPaths.slice(i, i + BATCH).map(async (p) => {
        const r = await authedFetch(fileUrl(p));
        if (!r.ok) return false;
        const body = await r.text();
        const rewritten = rewriteOne(body, oldName, newName, before, after);
        if (rewritten === null) return false;
        const put = await authedFetch(fileUrl(p), {
          method: "PUT",
          headers: { "Content-Type": "text/markdown" },
          body: rewritten,
        });
        return put.ok;
      }),
    );
    for (const ok of results) if (ok) touched++;
  }
  return touched;
}
