// Tag view: pages grouped by their frontmatter `tag:` declarations
// into a slash-nested folder tree. No right-click menu — per design,
// tag organization is metadata-driven, edited in frontmatter, not
// through Finder-style CRUD.

import { useMemo } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import type { PageMeta } from "coconote/type/page";
import { pageMatchesQuery } from "../lib/page_match.ts";
import { toPath } from "../lib/ref.ts";
import { stringSetCodec, useLocalStorageState } from "../lib/dom_hooks.ts";

const OPEN_TAGS_KEY = "coconote.contentBrowserOpenTags";
const UNTAGGED = "__untagged__";

type TagNode = {
  path: string;
  label: string;
  pages: PageMeta[];
  children: Map<string, TagNode>;
};

function buildTagTree(pages: PageMeta[]): TagNode {
  const root: TagNode = { path: "", label: "", pages: [], children: new Map() };
  for (const p of pages) {
    const tags = p.tags && p.tags.length > 0 ? p.tags : [UNTAGGED];
    for (const tag of tags) {
      const parts = tag.split("/").filter(Boolean);
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const partPath = parts.slice(0, i + 1).join("/");
        let child = cur.children.get(part);
        if (!child) {
          child = { path: partPath, label: part, pages: [], children: new Map() };
          cur.children.set(part, child);
        }
        cur = child;
      }
      cur.pages.push(p);
    }
  }
  return root;
}

// `p.tags` deliberately NOT consulted: the page is already placed under
// this folder, so checking sibling tags would cross-list it under
// unrelated folders. UNTAGGED short-circuits so `q='tag'` doesn't
// surface every untagged page under the (untagged) bucket.
function pageMatches(p: PageMeta, folderPath: string, q: string): boolean {
  // Tag-folder name participates in the filter too (so typing "math"
  // matches every page under `math/`), then the shared name/title/
  // headings predicate handles the rest.
  const tagHit = folderPath !== UNTAGGED &&
    folderPath.toLowerCase().includes(q);
  if (tagHit) return true;
  return pageMatchesQuery(p, q);
}

function buildCountIndex(root: TagNode, q: string): Map<string, number> {
  const counts = new Map<string, number>();
  function visit(node: TagNode): number {
    let n = q
      ? node.pages.filter((p) => pageMatches(p, node.path, q)).length
      : node.pages.length;
    for (const c of node.children.values()) n += visit(c);
    counts.set(node.path, n);
    return n;
  }
  visit(root);
  return counts;
}

function sortTagNodes(a: TagNode, b: TagNode): number {
  const au = a.label === UNTAGGED ? 1 : 0;
  const bu = b.label === UNTAGGED ? 1 : 0;
  if (au !== bu) return au - bu;
  return a.label.localeCompare(b.label);
}

type Props = {
  client: Client;
  allPages: PageMeta[];
  filter: string;
};

export function CbTagView({ client, allPages, filter }: Props) {
  const [openTags, setOpenTags] = useLocalStorageState<Set<string>>(
    OPEN_TAGS_KEY,
    () => new Set(),
    stringSetCodec,
  );

  const tree = useMemo(() => buildTagTree(allPages), [allPages]);
  // Strip leading sigils so `#tag` chips and `##tag` typos both narrow.
  const q = filter.replace(/^#+/, "").toLowerCase();
  const counts = useMemo(() => buildCountIndex(tree, q), [tree, q]);

  const toggle = (path: string) => {
    setOpenTags((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (tree.children.size === 0) {
    return <p className="coconote-cb-empty">No pages found.</p>;
  }
  return (
    <>
      {[...tree.children.values()].sort(sortTagNodes).map((node) => (
        <TagFolder
          key={node.path}
          node={node}
          openTags={openTags}
          toggle={toggle}
          q={q}
          counts={counts}
          client={client}
        />
      ))}
    </>
  );
}

type FolderProps = {
  node: TagNode;
  openTags: Set<string>;
  toggle: (path: string) => void;
  q: string;
  counts: Map<string, number>;
  client: Client;
};

function TagFolder({ node, openTags, toggle, q, counts, client }: FolderProps) {
  const matchCount = counts.get(node.path) ?? 0;
  if (q && matchCount === 0) return null;

  const isOpen = openTags.has(node.path);
  const filteredPages = q
    ? node.pages.filter((p) => pageMatches(p, node.path, q))
    : node.pages;
  const forceOpen = !!q;
  const expanded = isOpen || forceOpen;
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
          {[...node.children.values()].sort(sortTagNodes).map((child) => (
            <TagFolder
              key={child.path}
              node={child}
              openTags={openTags}
              toggle={toggle}
              q={q}
              counts={counts}
              client={client}
            />
          ))}
          {filteredPages
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => <PageRow key={p.ref} p={p} client={client} />)}
        </div>
      )}
    </div>
  );
}

function PageRow({ p, client }: { p: PageMeta; client: Client }) {
  const isRemote = p.origin?.kind === "remote";
  return (
    // Use a button to avoid the <a href> right-click navigation race
    // that the path view also fixed; tag view is read-only so there's
    // no extra context-menu plumbing to preserve.
    <button
      type="button"
      className={"coconote-cb-page" +
        (isRemote ? " coconote-cb-page-remote" : "")}
      onClick={() => {
        client.navigate({ path: toPath(p.name) });
      }}
    >
      <span className="coconote-cb-page-name">{p.title || p.name}</span>
      {p.title && p.title !== p.name && (
        <span className="coconote-cb-page-path">{p.name}</span>
      )}
      {isRemote && p.origin?.kind === "remote" && (
        <span className="coconote-cb-page-origin" title={p.origin.url}>
          {p.origin.label} ↗
        </span>
      )}
    </button>
  );
}
