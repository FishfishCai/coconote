// Shared filter predicate for the Content browser (content.md):
//   "Match scope covers folder names, file names, tags (at every
//    level), titles, and headings inside files."
//
// `q` is the filter string already normalised to lower-case (Path
// view strips the leading `#` it uses for tag-chip navigation before
// calling).

import type { PageMeta } from "coconote/type/page";

export function pageMatchesQuery(p: PageMeta, q: string): boolean {
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if ((p.title ?? "").toLowerCase().includes(q)) return true;
  for (const t of p.tags ?? []) {
    if (t.toLowerCase().includes(q)) return true;
  }
  // Server-side scan_headings populates this for admitted md rows.
  for (const h of p.headings ?? []) {
    if (h.toLowerCase().includes(q)) return true;
  }
  return false;
}
