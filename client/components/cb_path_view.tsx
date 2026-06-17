// Path view: the vault as a Finder-style folder tree keyed on the
// page's on-disk path. First segment = a root (`main`, `@label/...`),
// each further `/` opens a folder, leaves are pages. Right-click a
// row -> the grouped context menu (content_context_menu.tsx for files,
// folder_context_menu.tsx for folders).

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
import {
  buildCounts,
  buildPathTree,
  type PathLeaf,
  type PathNode,
} from "./path_tree.ts";
import { fetchExcludedPaths, includePath } from "../lib/include.ts";
import { errMessage } from "../lib/constants.ts";
import { nameToFsPath } from "../lib/path_url.ts";
import type { SyncListings } from "../lib/sync_core.ts";
import { toPath } from "../lib/ref.ts";
import { pageMatchesQuery as pageMatches } from "../lib/page_match.ts";
import { stringSetCodec, useLocalStorageState } from "../lib/dom_hooks.ts";

// Owned by ContentBrowser: the toggle lives in its header and the
// chosen mode arrives here as a prop.
export type DisplayMode = "included" | "all";

const OPEN_KEY = "coconote.contentBrowserOpenPaths";

type Props = {
  client: Client;
  allPages: PageMeta[];
  filter: string;
  displayMode: DisplayMode;
};

export function CbPathView({ client, allPages, filter, displayMode }: Props) {
  const [openPaths, setOpenPaths] = useLocalStorageState<Set<string>>(
    OPEN_KEY,
    () => new Set(),
    stringSetCodec,
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
  // Folder batch push/pull: the first item collects the target
  // interactively, later items auto-run with it. `choice` carries the
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
      /** Listing cache shared by every item in the batch. */
      listings: SyncListings;
    }
  >(null);
  // Bumped from refresh() so the excluded-list refetch fires even when
  // allPages.length is unchanged (Rename/Push/Pull/Retitle/Retag don't
  // change the count).
  const [refreshTick, setRefreshTick] = useState(0);

  // In "all" mode fetch the unified list once and again whenever a file
  // is flipped. Local roots only: remote rows can never be marked
  // excluded from the client's perspective.
  useEffect(() => {
    if (displayMode !== "all") {
      setExcludedNames(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const excluded = await fetchExcludedPaths();
        if (!cancelled) setExcludedNames(new Set(excluded));
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
    const fsPath = nameToFsPath(pageName);
    try {
      await includePath(fsPath);
      // Optimistically drop the entry so the row leaves the greyed
      // bucket immediately, the next /.file?all=1 round-trip via
      // refresh() confirms.
      setExcludedNames((prev) => {
        const next = new Set(prev);
        next.delete(fsPath);
        return next;
      });
      refresh();
    } catch (e) {
      await client.ui.notice(`Include failed: ${errMessage(e)}`);
    }
  };

  const onFolderContext = (
    folderPath: string,
    isRemote: boolean,
    e: MouseEvent,
  ) => {
    setFolderCtx({ folderPath, x: e.clientX, y: e.clientY, isRemote });
  };

  // navigate(null) only shows the browser, it never re-fetches. By the
  // time onChanged fires the mutating action has awaited its server
  // write, so re-pull the page list and bump refreshTick so the
  // excluded-list effect re-runs (see refreshTick above).
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
      const inFolder = p.name === folderPath ||
        p.name.startsWith(folderPath + "/");
      if (!inFolder) continue;
      const isRemote = p.origin?.kind === "remote";
      if (kind === "push" && !isRemote) {
        queue.push(nameToFsPath(p.name));
      } else if (kind === "pull" && isRemote) {
        queue.push(p.name);
      }
    }
    if (queue.length === 0) return;
    setBatchSync({
      kind,
      queue,
      index: 0,
      label: folderPath,
      choice: { current: null },
      listings: {},
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
      {tree.children.size === 0
        ? <p className="coconote-cb-empty">No pages found.</p>
        : (
          [...tree.children.values()].map((node) => (
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
          listings={batchSync.listings}
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
          listings={batchSync.listings}
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
          {[...node.children.values()].map((child) => (
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
          {filteredPages.map((l) => (
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
  // The tree position already implies the path, so show the leaf
  // basename + title (if distinct).
  const basename = p.name.split("/").pop() ?? p.name;
  // Hide the basename suffix when the title matches the full basename
  // or the basename minus one extension (e.g. title "test1" next to
  // "test1.pdf" would be redundant).
  const basenameStem = basename.replace(/\.[a-z0-9]+$/i, "");
  const showBasename =
    !!p.title && p.title !== basename && p.title !== basenameStem;
  const onActivate = () => {
    if (excluded) return;
    client.navigate({ path: toPath(p.name) });
  };
  // <button> not <a href>: some WebViews (e.g. macOS WKWebView) can
  // re-emit a click after a right-click, following the href and racing
  // the context menu open. A button has no default activation, so
  // right-click can NEVER navigate. The spec's Cmd+Click applies only
  // to editor wikilinks, not Content browser rows.
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
