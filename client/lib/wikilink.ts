// Locator grammar (split by `/`):
//   last segment -> page key:   filename (priority 2)  >  title (priority 1)
//   prefix segs  -> namespace:  tag      (priority 2)  >  path  (priority 1)
// Score = keyKind*10 + prefixKind.
// wikilink.md: "Filename matches outrank title matches."

import type { PageMeta } from "coconote/type/page";
import { basename } from "./path_url.ts";

export type WikiLinkResult =
  | { kind: "ok"; page: PageMeta }
  | { kind: "missing" }
  | { kind: "ambiguous"; pages: PageMeta[] };

type Candidate = { page: PageMeta; keyKind: 1 | 2; prefixKind: 0 | 1 | 2 };

// Contiguous run inside pageName segments, excluding the basename (which is the locator key).
function prefixMatchesPath(prefix: string, pageName: string): boolean {
  if (!prefix) return true;
  const ps = prefix.split("/").filter(Boolean);
  const ns = pageName.split("/").filter(Boolean);
  for (let i = 0; i + ps.length <= ns.length - 1; i++) {
    let ok = true;
    for (let j = 0; j < ps.length; j++) {
      if (ns[i + j] !== ps[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function matchKey(page: PageMeta, key: string): 0 | 1 | 2 {
  if (basename(page.name) === key || page.name === key) return 2;
  if (page.title && page.title === key) return 1;
  return 0;
}

function matchPrefix(
  page: PageMeta,
  prefix: string,
): 0 | 1 | 2 | null {
  if (!prefix) return 0;
  const tags = page.tags ?? [];
  // wikilink.md: the prefix can be a TAG PREFIX - `research/` must match
  // a page tagged `research/algebra` (tags are hierarchical, file.md).
  if (tags.some((t) => t === prefix || t.startsWith(prefix + "/"))) return 2;
  if (prefixMatchesPath(prefix, page.name)) return 1;
  return null;
}

// Memo keyed on the pages array identity (replaced wholesale on every
// refresh) then on the query. Resolution is pure, and the link
// decorator / graph build / autocomplete all re-resolve the same
// queries against the same list many times per pass.
const resolveMemo = new WeakMap<
  readonly PageMeta[],
  Map<string, WikiLinkResult>
>();

export function resolveWikiLink(
  query: string,
  allPages: readonly PageMeta[],
): WikiLinkResult {
  let byQuery = resolveMemo.get(allPages);
  if (!byQuery) {
    byQuery = new Map();
    resolveMemo.set(allPages, byQuery);
  }
  const cached = byQuery.get(query);
  if (cached) return cached;
  const result = resolveWikiLinkUncached(query, allPages);
  byQuery.set(query, result);
  return result;
}

function resolveWikiLinkUncached(
  query: string,
  allPages: readonly PageMeta[],
): WikiLinkResult {
  const parts = query.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "missing" };
  const last = parts[parts.length - 1];
  const prefix = parts.slice(0, -1).join("/");

  const cands: Candidate[] = [];
  for (const p of allPages) {
    // Remote-vault pages are never wikilink targets (ref grammar
    // excludes `@`), so a remote mirror of a local page must not make
    // the local link ambiguous.
    if (p.origin?.kind === "remote") continue;
    const keyKind = matchKey(p, last);
    if (keyKind === 0) continue;
    const prefixKind = matchPrefix(p, prefix);
    if (prefixKind === null) continue;
    cands.push({ page: p, keyKind, prefixKind });
  }
  if (cands.length === 0) return { kind: "missing" };

  let bestScore = 0;
  for (const c of cands) {
    const s = c.keyKind * 10 + c.prefixKind;
    if (s > bestScore) bestScore = s;
  }
  const winners = cands.filter(
    (c) => c.keyKind * 10 + c.prefixKind === bestScore,
  );
  if (winners.length === 1) return { kind: "ok", page: winners[0].page };
  return { kind: "ambiguous", pages: winners.map((w) => w.page) };
}

// Candidate order: bare filename -> bare title -> first tag + key ->
// path-prefix + key (shortest first) -> full path + key. Filename comes
// before title because filename matches outrank title matches in
// resolution (wikilink.md), making filename locators the more robust
// suggestion.
export function shortestLocator(
  target: PageMeta,
  allPages: readonly PageMeta[],
): string {
  const title = target.title;
  const fname = basename(target.name);
  const tag0 = (target.tags ?? [])[0];
  const pathSegs = target.name.split("/").filter(Boolean);
  // Try every CONTIGUOUS suffix-of-prefix (sliding window), shortest
  // first: for `a/b/c/d.md` -> `c`, `b/c`, `a/b/c`. The full path is
  // tried last via the fallback return.
  const pathPrefixes: string[] = [];
  const dirSegs = pathSegs.slice(0, -1);
  for (let len = 1; len < dirSegs.length; len++) {
    pathPrefixes.push(dirSegs.slice(dirSegs.length - len).join("/"));
  }
  pathPrefixes.push(dirSegs.join("/"));

  const tryList: string[] = [];
  tryList.push(fname);
  if (title) tryList.push(title);
  if (tag0) {
    tryList.push(`${tag0}/${fname}`);
    if (title) tryList.push(`${tag0}/${title}`);
  }
  for (const pp of pathPrefixes) {
    if (!pp) continue;
    tryList.push(`${pp}/${fname}`);
    if (title) tryList.push(`${pp}/${title}`);
  }

  for (const q of tryList) {
    const r = resolveWikiLink(q, allPages);
    if (r.kind === "ok" && r.page === target) return q;
  }
  return `${pathSegs.slice(0, -1).join("/")}/${fname}`;
}
