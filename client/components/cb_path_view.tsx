// Path view: the vault as a Finder-style folder tree, keyed on the
// page's on-disk path. Right-click a page row → New / Rename / Remove
// / Delete (analogous to a regular file manager).
//
// Tree shape: first path segment = a root (`main`, `@label/…`); each
// subsequent `/` opens another folder. Leaves are pages.

import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import type { PageMeta } from "coconote/type/page";
import { ContentContextMenu } from "./content_context_menu.tsx";
import { FolderContextMenu } from "./folder_context_menu.tsx";
import {
  type BatchChoice,
  PullModal,
  PushModal,
  type PushTargetChoice,
} from "./sync_modals.tsx";
import { authedFetch } from "../lib/authed_fetch.ts";
import { includePath } from "../lib/include.ts";
import { toPath } from "../lib/ref.ts";
import { pageMatchesQuery as pageMatches } from "../lib/page_match.ts";
import { stringSetCodec, useLocalStorageState } from "../lib/dom_hooks.ts";

const DISPLAY_MODE_KEY = "coconote.contentBrowserDisplayMode";
type DisplayMode = "included" | "all";

type ServerListEntry = {
  type: "file" | "dir";
  path: string;
  page_id?: string;
  title?: string;
  tag?: string[];
  coconote?: boolean;
};

const OPEN_KEY = "coconote.contentBrowserOpenPaths";

type PathLeaf = {
  page: PageMeta;
  /** True when the row is admitted (`coconote: true`). Greyed when false. */
  included: boolean;
};

type PathNode = {
  path: string; // joined from root, no trailing slash
  label: string;
  pages: PathLeaf[];
  children: Map<string, PathNode>;
  /** True iff every descendant page lives on the local vault. */
  isLocal: boolean;
};

function buildPathTree(
  pages: PageMeta[],
  excludedNames: ReadonlySet<string> = new Set(),
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
    // content.md §Path view: top-level folders are the roots — local
    // roots show their yaml name, url-mounted roots display "root<url>".
    // Collapse the synthetic `@label` level into the remote root folder
    // so the tree's top level is exactly the roots.
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
  // Synthesize PageMeta-shaped rows for the excluded paths so the same
  // PageRow renderer handles both. created/lastModified are sentinel
  // 1970-01-01 — excluded rows are render-only and never participate
  // in time-based sorts; if a future sort-by-mtime is added, change
  // these to optional in PageMeta and treat undefined as "always last".
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
  return root;
}

function buildCounts(root: PathNode, q: string): Map<string, number> {
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

type Props = {
  client: Client;
  allPages: PageMeta[];
  filter: string;
};

export function CbPathView({ client, allPages, filter }: Props) {
  const [openPaths, setOpenPaths] = useLocalStorageState<Set<string>>(
    OPEN_KEY,
    () => new Set(),
    stringSetCodec,
  );
  const [displayMode, setDisplayMode] = useLocalStorageState<DisplayMode>(
    DISPLAY_MODE_KEY,
    () => "included",
  );
  const [excludedNames, setExcludedNames] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<
    {
      pageName: string;
      x: number;
      y: number;
      isRemote: boolean;
      isExcluded: boolean;
    } | null
  >(null);
  const [folderCtx, setFolderCtx] = useState<
    { folderPath: string; x: number; y: number; isRemote: boolean } | null
  >(null);
  const [pushOne, setPushOne] = useState<string | null>(null);
  const [pullOne, setPullOne] = useState<string | null>(null);
  // Batch push/pull over a folder: the first item collects the target
  // interactively, later items auto-run with it; `choice` carries the
  // collision dialog's "apply the same choice to the rest" memory.
  const [batchSync, setBatchSync] = useState<
    | null
    | {
      kind: "push" | "pull";
      queue: string[];
      index: number;
      label: string;
      pushTarget?: PushTargetChoice;
      pullRoot?: string;
      choice: BatchChoice;
    }
  >(null);
  // Bumped from refresh() so the excluded-list refetch fires even when
  // allPages.length is unchanged (Rename/Push/Pull/Retitle/Retag don't
  // change the count).
  const [refreshTick, setRefreshTick] = useState(0);

  // In "all" mode pull the unified list once and again whenever a file
  // is flipped. Local roots only — remote rows can never be marked
  // excluded from the client's perspective.
  useEffect(() => {
    if (displayMode !== "all") {
      setExcludedNames(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await authedFetch("/.file?all=1");
        if (!r.ok) return;
        const list = (await r.json()) as ServerListEntry[];
        if (cancelled) return;
        const excluded = new Set<string>();
        for (const e of list) {
          if (e.type !== "file") continue;
          if (e.coconote === false) excluded.add(e.path);
        }
        setExcludedNames(excluded);
      } catch {/* ignore */}
    })();
    return () => {
      cancelled = true;
    };
  }, [displayMode, allPages.length, refreshTick]);

  const tree = useMemo(
    () => buildPathTree(allPages, excludedNames),
    [allPages, excludedNames],
  );
  const q = filter.replace(/^#+/, "").toLowerCase();
  const counts = useMemo(() => buildCounts(tree, q), [tree, q]);
  // No open-state effect on filter: `expanded = isOpen || !!q` already
  // force-opens matching folders for the duration of the filter.

  const toggle = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onContext = (leaf: PathLeaf, e: MouseEvent) => {
    const isRemote = leaf.page.origin?.kind === "remote";
    setCtxMenu({
      pageName: leaf.page.name,
      x: e.clientX,
      y: e.clientY,
      isRemote,
      isExcluded: !leaf.included,
    });
  };

  const onInclude = async (pageName: string) => {
    // pageName drops the .md extension; restore for md/pdf paths.
    const lower = pageName.toLowerCase();
    const fsPath = lower.endsWith(".pdf") || lower.endsWith(".md")
      ? pageName
      : pageName + ".md";
    try {
      await includePath(fsPath);
      // Optimistically drop the entry so the row leaves the greyed
      // bucket immediately; the next /.file?all=1 round-trip via
      // refresh() will confirm.
      setExcludedNames((prev) => {
        const next = new Set(prev);
        next.delete(fsPath);
        return next;
      });
      refresh();
    } catch (e) {
      console.error(`Include failed: ${e}`);
    }
  };

  const onFolderContext = (
    folderPath: string,
    isRemote: boolean,
    e: MouseEvent,
  ) => {
    setFolderCtx({ folderPath, x: e.clientX, y: e.clientY, isRemote });
  };

  // navigate(null) just shows the browser — it doesn't re-fetch. By
  // the time onChanged fires the mutating action has awaited its
  // server write, so re-pull the page list and also bump refreshTick
  // so the excluded-list effect re-runs (Rename/Push/Pull/Retitle/
  // Retag leave allPages.length unchanged).
  const refresh = () => {
    void client.updatePageListCache();
    setRefreshTick((n) => n + 1);
  };

  const startFolderBatch = (
    kind: "push" | "pull",
    folderPath: string,
  ) => {
    const queue: string[] = [];
    for (const p of allPages) {
      const inFolder = folderPath === ""
        ? true
        : p.name === folderPath || p.name.startsWith(folderPath + "/");
      if (!inFolder) continue;
      const isRemote = p.origin?.kind === "remote";
      if (kind === "push" && !isRemote) {
        // Page names: md drops the extension, pdf keeps it. A dotted
        // page name ("notes.v2") still needs the .md restored.
        const lower = p.name.toLowerCase();
        const fsPath = lower.endsWith(".pdf") || lower.endsWith(".md")
          ? p.name
          : p.name + ".md";
        queue.push(fsPath);
      } else if (kind === "pull" && isRemote) {
        queue.push(p.name);
      }
    }
    if (queue.length === 0) return;
    setBatchSync({
      kind,
      queue,
      index: 0,
      label: folderPath || "vault",
      choice: { current: null },
    });
  };

  const batchNext = () => {
    if (!batchSync) return;
    const next = batchSync.index + 1;
    if (next >= batchSync.queue.length) {
      setBatchSync(null);
      refresh();
      return;
    }
    setBatchSync({ ...batchSync, index: next });
  };

  return (
    <>
      <div className="coconote-cb-display-toggle">
        <button
          type="button"
          className={displayMode === "included" ? "on" : ""}
          onClick={() => setDisplayMode("included")}
        >
          Coconote files only
        </button>
        <button
          type="button"
          className={displayMode === "all" ? "on" : ""}
          onClick={() => setDisplayMode("all")}
        >
          All supported files
        </button>
      </div>
      {tree.children.size === 0
        ? <p className="coconote-cb-empty">No pages found.</p>
        : (
          [...tree.children.values()].sort(sortNodes).map((node) => (
            <PathFolder
              key={node.path}
              node={node}
              openPaths={openPaths}
              toggle={toggle}
              q={q}
              counts={counts}
              client={client}
              onContext={onContext}
              onFolderContext={onFolderContext}
            />
          ))
        )}
      {ctxMenu && (
        <ContentContextMenu
          client={client}
          pageName={ctxMenu.pageName}
          x={ctxMenu.x}
          y={ctxMenu.y}
          isRemote={ctxMenu.isRemote}
          isExcluded={ctxMenu.isExcluded}
          showRename={!ctxMenu.isRemote && !ctxMenu.isExcluded}
          onClose={() => setCtxMenu(null)}
          onChanged={refresh}
          onPush={(p) => setPushOne(p)}
          onPull={(p) => setPullOne(p)}
          onInclude={(p) => void onInclude(p)}
        />
      )}
      {folderCtx && (
        <FolderContextMenu
          client={client}
          folderPath={folderCtx.folderPath}
          x={folderCtx.x}
          y={folderCtx.y}
          isRemote={folderCtx.isRemote}
          onClose={() => setFolderCtx(null)}
          onChanged={refresh}
          onPushFolder={(p) => startFolderBatch("push", p)}
          onPullFolder={(p) => startFolderBatch("pull", p)}
        />
      )}
      {pushOne && (
        <PushModal
          client={client}
          localPath={pushOne}
          onClose={() => {
            setPushOne(null);
            refresh();
          }}
        />
      )}
      {pullOne && (
        <PullModal
          client={client}
          remotePrefixedPath={pullOne}
          onClose={() => {
            setPullOne(null);
            refresh();
          }}
        />
      )}
      {batchSync && batchSync.kind === "push" && (
        <PushModal
          key={`batch-push-${batchSync.index}`}
          client={client}
          localPath={batchSync.queue[batchSync.index]}
          initialTarget={batchSync.pushTarget}
          autoRun={batchSync.index > 0 && !!batchSync.pushTarget}
          batchChoice={batchSync.choice}
          onTargetChosen={(t) =>
            setBatchSync((s) => (s ? { ...s, pushTarget: t } : s))}
          onClose={batchNext}
        />
      )}
      {batchSync && batchSync.kind === "pull" && (
        <PullModal
          key={`batch-pull-${batchSync.index}`}
          client={client}
          remotePrefixedPath={batchSync.queue[batchSync.index]}
          initialRoot={batchSync.pullRoot}
          autoRun={batchSync.index > 0 && !!batchSync.pullRoot}
          batchChoice={batchSync.choice}
          onRootChosen={(root) =>
            setBatchSync((s) => (s ? { ...s, pullRoot: root } : s))}
          onClose={batchNext}
        />
      )}
    </>
  );
}

type FolderProps = {
  node: PathNode;
  openPaths: Set<string>;
  toggle: (path: string) => void;
  q: string;
  counts: Map<string, number>;
  client: Client;
  onContext(l: PathLeaf, e: MouseEvent): void;
  onFolderContext(folderPath: string, isRemote: boolean, e: MouseEvent): void;
};

function PathFolder(
  {
    node,
    openPaths,
    toggle,
    q,
    counts,
    client,
    onContext,
    onFolderContext,
  }: FolderProps,
) {
  const matchCount = counts.get(node.path) ?? 0;
  if (q && matchCount === 0) return null;

  const isOpen = openPaths.has(node.path);
  const expanded = isOpen || !!q;
  const filteredPages = q
    ? node.pages.filter((l) => pageMatches(l.page, q))
    : node.pages;

  return (
    <div className="coconote-cb-folder">
      <div
        className="coconote-cb-folder-head"
        onClick={() => toggle(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          onFolderContext(node.path, !node.isLocal, e);
        }}
        role="button"
        aria-expanded={expanded}
      >
        <span className="coconote-cb-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="coconote-cb-tag-label">{node.label}</span>
        <span className="coconote-cb-tag-count">{matchCount}</span>
      </div>
      {expanded && (
        <div className="coconote-cb-folder-body">
          {[...node.children.values()].sort(sortNodes).map((child) => (
            <PathFolder
              key={child.path}
              node={child}
              openPaths={openPaths}
              toggle={toggle}
              q={q}
              counts={counts}
              client={client}
              onContext={onContext}
              onFolderContext={onFolderContext}
            />
          ))}
          {filteredPages
            .slice()
            .sort((a, b) => a.page.name.localeCompare(b.page.name))
            .map((l) => (
              <PageRow
                key={l.page.ref + (l.included ? "" : "?excluded")}
                leaf={l}
                client={client}
                onContext={onContext}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function PageRow(
  { leaf, client, onContext }: {
    leaf: PathLeaf;
    client: Client;
    onContext(l: PathLeaf, e: MouseEvent): void;
  },
) {
  const p = leaf.page;
  const isRemote = p.origin?.kind === "remote";
  const excluded = !leaf.included;
  // In path view the path itself is already implied by the tree
  // position, so show the leaf basename + title (if distinct).
  const basename = p.name.split("/").pop() ?? p.name;
  // For "title test1 · basename test1.pdf" the suffix is redundant —
  // hide it whenever the title matches either the full basename or
  // the basename with any single extension stripped.
  const basenameStem = basename.replace(/\.[a-z0-9]+$/i, "");
  const showBasename =
    !!p.title && p.title !== basename && p.title !== basenameStem;
  const onActivate = () => {
    if (excluded) return;
    client.navigate({ path: toPath(p.name) });
  };
  // <button> instead of <a href>: an anchor's href is followed under
  // certain WebView paths (e.g. macOS WKWebView re-emits a click after
  // a right-click in some cases) which would race the context menu
  // open. A button has no default activation behavior, so right-click
  // can NEVER navigate. Cmd+Click in spec only applies to wikilinks
  // inside the editor, not Content browser rows.
  return (
    <button
      type="button"
      className={
        "coconote-cb-page" +
        (isRemote ? " coconote-cb-page-remote" : "") +
        (excluded ? " coconote-cb-page-excluded" : "")
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContext(leaf, e);
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onActivate();
      }}
    >
      <span className="coconote-cb-page-name">{p.title || basename}</span>
      {showBasename && (
        <span className="coconote-cb-page-path">{basename}</span>
      )}
      {isRemote && p.origin?.kind === "remote" && (
        <span className="coconote-cb-page-origin" title={p.origin.url}>
          {p.origin.label} ↗
        </span>
      )}
    </button>
  );
}
