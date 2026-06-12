// Shared Content-browser filter predicate (content.md: "Match scope
// covers folder names, file names, tags (at every level), titles, and
// headings inside files"). `q` is already lower-cased - Path view
// strips its tag-chip leading `#` before calling.

import type { PageMeta } from "coconote/type/page";

// Structural subset so the exported static site's viewer can reuse the
// predicate over manifest entries (client/site/) without a full PageMeta.
export type PageMatchFields = Pick<
  PageMeta,
  "name" | "title" | "tags" | "headings"
>;

export function pageMatchesQuery(p: PageMatchFields, q: string): boolean {
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
