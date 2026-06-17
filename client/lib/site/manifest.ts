// The site manifest entry per page: resolve raw wikilink / prereq locators
// to vault paths exactly like the Graph view's edge construction
// (lib/graph_layout.ts buildGraph), so the exported graph matches the app's.

import type { PageMeta } from "coconote/type/page";
import { basename, nameToFsPath } from "../path_url.ts";
import { resolveWikiLink } from "../wikilink.ts";

export type SitePageEntry = {
  path: string;
  kind: "md" | "pdf";
  title: string;
  tags: string[];
  headings: string[];
  links: string[];
  prereqs: string[];
};

/** resolveWikiLink, drop unresolved, drop self, dedupe. */
function resolveTargets(
  queries: readonly string[] | undefined,
  selfPath: string,
  allPages: readonly PageMeta[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of queries ?? []) {
    const r = resolveWikiLink(q, allPages);
    if (r.kind !== "ok") continue;
    const target = nameToFsPath(r.page.name);
    if (target === selfPath || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

export function manifestEntry(
  p: PageMeta,
  allPages: readonly PageMeta[],
): SitePageEntry {
  const path = nameToFsPath(p.name);
  // Remote pages carry no edges, matching buildGraph.
  const local = p.origin?.kind !== "remote";
  return {
    path,
    kind: path.toLowerCase().endsWith(".pdf") ? "pdf" : "md",
    title: p.title || basename(p.name),
    tags: p.tags ?? [],
    headings: p.headings ?? [],
    links: local ? resolveTargets(p.wikilinks, path, allPages) : [],
    prereqs: local ? resolveTargets(p.prereq, path, allPages) : [],
  };
}
