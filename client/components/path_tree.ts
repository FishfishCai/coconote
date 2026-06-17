// Pure folder-tree model for the Path view: fold the flat PageMeta listing
// (plus synthesized rows for excluded paths) into a sorted root/folder/page
// tree, and count search-matching pages per folder. No DOM, no client
// context - just data, so the view component stays a thin renderer.

import type { PageMeta } from "coconote/type/page";
import { pageMatchesQuery as pageMatches } from "../lib/page_match.ts";

export type PathLeaf = {
  page: PageMeta;
  /** True when the row is admitted (`coconote: true`). Greyed when false. */
  included: boolean;
};

export type PathNode = {
  path: string; // joined from root, no trailing slash
  label: string;
  pages: PathLeaf[];
  children: Map<string, PathNode>;
  /** True iff every descendant page lives on the local vault. */
  isLocal: boolean;
};

export function buildPathTree(
  pages: PageMeta[],
  excludedNames: ReadonlySet<string>,
): PathNode {
  const root: PathNode = {
    path: "",
    label: "",
    pages: [],
    children: new Map(),
    isLocal: true,
  };
  const insert = (p: PageMeta, included: boolean) => {
    const parts = p.name.split("/").filter(Boolean);
    if (parts.length === 0) return;
    const remote = p.origin?.kind === "remote";
    let cur = root;
    if (remote) cur.isLocal = false;
    // content.md Path view: top level = the roots (local: yaml name,
    // url-mounted: "root<url>"). Collapse the synthetic `@label` level
    // into the remote root folder so the top level is exactly the roots.
    const folderParts = parts.slice(0, -1);
    const segs: { key: string; label: string }[] = [];
    let start = 0;
    if (remote && folderParts.length >= 2 && p.origin?.kind === "remote") {
      segs.push({
        key: `${folderParts[0]}/${folderParts[1]}`,
        label: `${folderParts[1]}<${p.origin.url}>`,
      });
      start = 2;
    }
    for (let i = start; i < folderParts.length; i++) {
      segs.push({
        key: folderParts.slice(0, i + 1).join("/"),
        label: folderParts[i],
      });
    }
    for (const seg of segs) {
      let child = cur.children.get(seg.key);
      if (!child) {
        child = {
          path: seg.key,
          label: seg.label,
          pages: [],
          children: new Map(),
          isLocal: !remote,
        };
        cur.children.set(seg.key, child);
      } else if (remote) {
        child.isLocal = false;
      }
      cur = child;
    }
    cur.pages.push({ page: p, included });
  };
  for (const p of pages) insert(p, true);
  // Synthesize PageMeta-shaped rows for excluded paths so one PageRow
  // renderer handles both. created/lastModified are sentinel 1970-01-01
  // (excluded rows are render-only, never time-sorted). If a
  // sort-by-mtime is added, make these optional in PageMeta and treat
  // undefined as "always last".
  const EPOCH = new Date(0).toISOString();
  for (const fsPath of excludedNames) {
    const noMd = fsPath.endsWith(".md") ? fsPath.slice(0, -3) : fsPath;
    const synth: PageMeta = {
      ref: noMd,
      name: noMd,
      tag: "page",
      created: EPOCH,
      lastModified: EPOCH,
      perm: "ro",
      tags: [],
      title: "",
    };
    insert(synth, false);
  }
  sortTree(root);
  return root;
}

/** Render order: child folders A-Z, pages by name. Sorting once inside
 *  the useMemo'd build keeps per-keystroke filter renders sort-free. */
function sortTree(node: PathNode) {
  node.pages.sort((a, b) => a.page.name.localeCompare(b.page.name));
  const kids = [...node.children.values()].sort(sortNodes);
  node.children = new Map(kids.map((c) => [c.path, c]));
  for (const c of kids) sortTree(c);
}

export function buildCounts(root: PathNode, q: string): Map<string, number> {
  const counts = new Map<string, number>();
  function visit(node: PathNode): number {
    let n = node.pages.filter((l) => pageMatches(l.page, q)).length;
    for (const c of node.children.values()) n += visit(c);
    counts.set(node.path, n);
    return n;
  }
  visit(root);
  return counts;
}

function sortNodes(a: PathNode, b: PathNode): number {
  return a.label.localeCompare(b.label);
}
