// Right-click menu shown on a content-browser Path-view file row
// (Tag view is read-only). Per content.md §Right-click menu:
// Folder → New Markdown / New Folder; .md or .pdf → Rename / Remove /
// Delete (Push/Pull also appear depending on local vs remote).
// Rename rewrites every [[wikilink]] pointing at the old name.
// Dispatch-only: the multi-step transactions live in lib/page_ops.ts.

import { deletePage, removeFromIndex, renamePage } from "../lib/page_ops.ts";
import { ContextMenuShell } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  pageName: string;
  x: number;
  y: number;
  showRename?: boolean;
  /** Local files get a `Push`, remote files get a `Pull`. content.md §push/pull. */
  isRemote?: boolean;
  /** Set by "show all supported files" mode for non-admitted rows.
   *  content.md: only "Include in Coconote" is offered. */
  isExcluded?: boolean;
  onClose(): void;
  onChanged(): void;
  onPush?(localPath: string): void;
  onPull?(remotePrefixedPath: string): void;
  onInclude?(fsPath: string): void;
};

export function ContentContextMenu(
  {
    client,
    pageName,
    x,
    y,
    showRename = false,
    isRemote = false,
    isExcluded = false,
    onClose,
    onChanged,
    onPush,
    onPull,
    onInclude,
  }: Props,
) {
  // pageName drops the .md extension for markdown pages, so only a
  // literal .md / .pdf suffix counts as "already has one" — a dotted
  // page name like "notes.v2" is still a markdown page whose on-disk
  // path appends .md (same rule as cb_path_view's onInclude).
  const lower = pageName.toLowerCase();
  const fullPath = lower.endsWith(".md") || lower.endsWith(".pdf")
    ? pageName
    : pageName + ".md";
  const isMd = fullPath.toLowerCase().endsWith(".md");

  // Remove flips the include flag (md frontmatter / pdf sidecar); the
  // file stays on disk.
  const onRemove = async () => {
    try {
      await removeFromIndex(fullPath);
      onChanged();
    } catch (e) {
      console.error(`Remove failed: ${e}`);
    }
    onClose();
  };

  const onRename = async () => {
    // The leading root name is fixed: show and edit only the path within
    // the root, then re-attach the same root prefix. The user can move the
    // file inside the root but cannot change which root it lives in.
    const slash = pageName.indexOf("/");
    const rootPrefix = slash < 0 ? "" : pageName.slice(0, slash + 1);
    const restName = slash < 0 ? pageName : pageName.slice(slash + 1);
    const rawNew = await client.ui.prompt(
      isMd ? "New page name:" : "New file path:",
      restName,
    );
    if (!rawNew) return onClose();
    const cleanedNew = rawNew.trim().replace(/^\/+/, "");
    if (!cleanedNew || cleanedNew === restName) return onClose();
    const newRest = isMd
      ? cleanedNew.replace(/\.md$/i, "") + ".md"
      : cleanedNew;
    const newFullPath = rootPrefix + newRest;
    if (newFullPath === fullPath) return onClose();
    try {
      await renamePage(fullPath, newFullPath);
      onChanged();
    } catch (e) {
      console.error(`Rename failed: ${e}`);
    }
    onClose();
  };

  const onDelete = async () => {
    const ok = await client.ui.confirm(
      `Delete ${fullPath}? This cannot be undone.`,
    );
    if (!ok) return onClose();
    try {
      await deletePage(fullPath);
      onChanged();
    } catch (e) {
      console.error(`Delete failed: ${e}`);
    }
    onClose();
  };

  const onSync = () => {
    if (isRemote) onPull?.(pageName);
    else onPush?.(fullPath);
    onClose();
  };

  const onIncludeClick = () => {
    onInclude?.(fullPath);
    onClose();
  };

  // file.md / content.md: excluded rows (default-mode is filtered out
  // already; here we're in "show all supported files") expose only one
  // action — Include in Coconote.
  if (isExcluded) {
    return (
      <ContextMenuShell x={x} y={y} onClose={onClose}>
        <button type="button" onClick={onIncludeClick}>
          Include in Coconote
        </button>
      </ContextMenuShell>
    );
  }

  // Remote rows are read-only locally: spec only authorizes `pull` on
  // them. Drop the mutating actions when isRemote.
  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      {isRemote
        ? (
          <button type="button" onClick={onSync}>Pull</button>
        )
        : (
          <>
            {showRename && (
              <button type="button" onClick={onRename}>Rename</button>
            )}
            <button type="button" onClick={onRemove}>Remove</button>
            <button type="button" onClick={onSync}>Push</button>
            <button type="button" className="danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
    </ContextMenuShell>
  );
}
