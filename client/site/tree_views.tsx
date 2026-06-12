// Path + Tag views for the exported static site: the same folder-tree
// look and filter semantics as the app's Content browser
// (cb_path_view.tsx / cb_tag_view.tsx) minus the app-only chrome
// (context menus, sync, excluded rows). Rows are plain relative <a>
// links so the site works from file://.

import { useMemo, useState } from "preact/hooks";
import { pageMatchesQuery } from "../lib/page_match.ts";
import { pageBasename, pageHref, type SitePage } from "./manifest.ts";

const UNTAGGED = "__untagged__";

// Shared Content-browser filter scope (content.md): folder names, file
// names, tags at every level, titles, headings. Folder names come for
// free through `path`.
function matches(p: SitePage, q: string): boolean {
  return pageMatchesQuery(
    { name: p.path, title: p.title, tags: p.tags, headings: p.headings },
    q,
  );
}

type TreeNode = {
  path: string; // joined from root, unique key
  label: string;
  pages: SitePage[];
  children: Map<string, TreeNode>;
};

function makeRoot(): TreeNode {
  return { path: "", label: "", pages: [], children: new Map() };
}

/** Walk/create the chain of folders for `parts` under `root`. */
function descend(root: TreeNode, parts: string[]): TreeNode {
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const key = parts.slice(0, i + 1).join("/");
    let child = cur.children.get(key);
    if (!child) {
      child = { path: key, label: parts[i], pages: [], children: new Map() };
      cur.children.set(key, child);
    }
    cur = child;
  }
  return cur;
}

/** Render order: child folders A-Z ((untagged) last), pages by path. */
function sortTree(node: TreeNode) {
  node.pages.sort((a, b) => a.path.localeCompare(b.path));
  const kids = [...node.children.values()].sort((a, b) => {
    const au = a.label === UNTAGGED ? 1 : 0;
    const bu = b.label === UNTAGGED ? 1 : 0;
    if (au !== bu) return au - bu;
    return a.label.localeCompare(b.label);
  });
  node.children = new Map(kids.map((c) => [c.path, c]));
  for (const c of kids) sortTree(c);
}

function buildPathTree(pages: SitePage[]): TreeNode {
  const root = makeRoot();
  for (const p of pages) {
    const parts = p.path.split("/").filter(Boolean);
    descend(root, parts.slice(0, -1)).pages.push(p);
  }
  sortTree(root);
  return root;
}

function buildTagTree(pages: SitePage[]): TreeNode {
  const root = makeRoot();
  for (const p of pages) {
    const tags = p.tags.length > 0 ? p.tags : [UNTAGGED];
    for (const tag of tags) {
      descend(root, tag.split("/").filter(Boolean)).pages.push(p);
    }
  }
  sortTree(root);
  return root;
}

// Tag view: the tag-folder name participates in the filter too (typing
// "math" matches every page under `math/`), the (untagged) bucket is
// excluded so `q='tag'` doesn't surface every untagged page.
function tagFolderMatches(folderPath: string, q: string): boolean {
  return !folderPath.startsWith(UNTAGGED) &&
    folderPath.toLowerCase().includes(q);
}

type PageInFolder = (p: SitePage, folderPath: string, q: string) => boolean;

function buildCounts(
  root: TreeNode,
  q: string,
  match: PageInFolder,
): Map<string, number> {
  const counts = new Map<string, number>();
  function visit(node: TreeNode): number {
    let n = q
      ? node.pages.filter((p) => match(p, node.path, q)).length
      : node.pages.length;
    for (const c of node.children.values()) n += visit(c);
    counts.set(node.path, n);
    return n;
  }
  visit(root);
  return counts;
}

function TreeView(
  { pages, filter, build, match }: {
    pages: SitePage[];
    filter: string;
    build: (pages: SitePage[]) => TreeNode;
    match: PageInFolder;
  },
) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => build(pages), [pages, build]);
  // Strip leading sigils so `#tag` queries narrow like in the app.
  const q = filter.replace(/^#+/, "").toLowerCase();
  const counts = useMemo(
    () => buildCounts(tree, q, match),
    [tree, q, match],
  );

  const toggle = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (tree.children.size === 0 && tree.pages.length === 0) {
    return <p className="coconote-cb-empty">No pages found.</p>;
  }
  return (
    <>
      {[...tree.children.values()].map((node) => (
        <Folder
          key={node.path}
          node={node}
          openPaths={openPaths}
          toggle={toggle}
          q={q}
          counts={counts}
          match={match}
        />
      ))}
      {(q ? tree.pages.filter((p) => match(p, "", q)) : tree.pages).map((
        p,
      ) => <PageLink key={p.path} p={p} />)}
    </>
  );
}

function Folder(
  { node, openPaths, toggle, q, counts, match }: {
    node: TreeNode;
    openPaths: Set<string>;
    toggle: (path: string) => void;
    q: string;
    counts: Map<string, number>;
    match: PageInFolder;
  },
) {
  const matchCount = counts.get(node.path) ?? 0;
  if (q && matchCount === 0) return null;

  // A filter force-opens every folder that still has matches, so
  // matching files and their ancestor folders are all visible.
  const expanded = openPaths.has(node.path) || !!q;
  const filteredPages = q
    ? node.pages.filter((p) => match(p, node.path, q))
    : node.pages;
  const label = node.label === UNTAGGED ? "(untagged)" : node.label;

  return (
    <div className="coconote-cb-folder">
      <div
        className="coconote-cb-folder-head"
        onClick={() => toggle(node.path)}
        role="button"
        aria-expanded={expanded}
      >
        <span className="coconote-cb-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="coconote-cb-tag-label">{label}</span>
        <span className="coconote-cb-tag-count">{matchCount}</span>
      </div>
      {expanded && (
        <div className="coconote-cb-folder-body">
          {[...node.children.values()].map((child) => (
            <Folder
              key={child.path}
              node={child}
              openPaths={openPaths}
              toggle={toggle}
              q={q}
              counts={counts}
              match={match}
            />
          ))}
          {filteredPages.map((p) => <PageLink key={p.path} p={p} />)}
        </div>
      )}
    </div>
  );
}

function PageLink({ p }: { p: SitePage }) {
  const basename = pageBasename(p);
  const basenameStem = basename.replace(/\.[a-z0-9]+$/i, "");
  const showBasename = !!p.title && p.title !== basename &&
    p.title !== basenameStem;
  return (
    <a className="coconote-cb-page" href={pageHref(p)}>
      <span className="coconote-cb-page-name">{p.title || basename}</span>
      {showBasename && (
        <span className="coconote-cb-page-path">{basename}</span>
      )}
    </a>
  );
}

const matchPathPage: PageInFolder = (p, _folderPath, q) => matches(p, q);
const matchTagPage: PageInFolder = (p, folderPath, q) =>
  tagFolderMatches(folderPath, q) || matches(p, q);

export function SitePathView(
  { pages, filter }: { pages: SitePage[]; filter: string },
) {
  return (
    <TreeView
      pages={pages}
      filter={filter}
      build={buildPathTree}
      match={matchPathPage}
    />
  );
}

export function SiteTagView(
  { pages, filter }: { pages: SitePage[]; filter: string },
) {
  return (
    <TreeView
      pages={pages}
      filter={filter}
      build={buildTagTree}
      match={matchTagPage}
    />
  );
}
