// Right-click menu for a content-browser Path-view file row (Tag view
// is read-only). content.md Right-click menu: a row not in Coconote
// offers only Include. An included row gets the grouped template:
// Rename / Remove, then Push (local) or Pull (remote) + Export (md
// downloads HTML, pdf downloads a baked PDF), then Delete alone.
// Rename rewrites every [[wikilink]] to the old name. Dispatch-only:
// lib/page_ops.ts and lib/export.ts.

import { exportHtml, exportPdfOfPdf } from "../lib/export.ts";
import { deletePage, removeFromIndex, renamePage } from "../lib/page_ops.ts";
import { errMessage } from "../lib/constants.ts";
import { nameToFsPath } from "../lib/path_url.ts";
import { ContextMenuShell, MenuSeparator } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  pageName: string;
  x: number;
  y: number;
  /** Local files get `Push`, remote files `Pull` (content.md push/pull). */
  isRemote: boolean;
  /** Set by the All display mode for non-admitted rows.
   *  content.md: only "Include" is offered. */
  isExcluded: boolean;
  onClose(): void;
  onChanged(): void;
  onPush(localPath: string): void;
  onPull(remotePrefixedPath: string): void;
  onInclude(fsPath: string): void;
};

export function ContentContextMenu(
  {
    client,
    pageName,
    x,
    y,
    isRemote,
    isExcluded,
    onClose,
    onChanged,
    onPush,
    onPull,
    onInclude,
  }: Props,
) {
  const fullPath = nameToFsPath(pageName);
  const isMd = fullPath.toLowerCase().endsWith(".md");

  // content.md: a failed menu action reports in a modal, never silently.
  const fail = (action: string, e: unknown) =>
    client.ui.notice(`${action} failed: ${errMessage(e)}`);

  // Remove flips the include flag (md frontmatter / pdf sidecar), the
  // file stays on disk.
  const onRemove = async () => {
    try {
      await removeFromIndex(fullPath);
      onChanged();
    } catch (e) {
      await fail("Remove", e);
    }
    onClose();
  };

  const onRename = async () => {
    // The root prefix is fixed: edit only the path within the root,
    // then re-attach it. The user can move the file inside the root
    // but cannot change roots.
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
      await fail("Rename", e);
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
      await fail("Delete", e);
    }
    onClose();
  };

  const onSync = () => {
    if (isRemote) onPull(pageName);
    else onPush(fullPath);
    onClose();
  };

  const onIncludeClick = () => {
    onInclude(fullPath);
    onClose();
  };

  // Exports download to the local machine, never into the vault, so
  // they apply to remote rows too. md exports HTML, pdf exports PDF.
  const onExport = async () => {
    try {
      if (isMd) await exportHtml(client, pageName);
      else await exportPdfOfPdf(client, pageName);
    } catch (e) {
      await fail("Export", e);
    }
    onClose();
  };

  const exportButton = (
    <button type="button" onClick={onExport}>
      Export
    </button>
  );

  // file.md / content.md: excluded rows (visible only in the All
  // display mode) expose a single action - Include.
  if (isExcluded) {
    return (
      <ContextMenuShell x={x} y={y} onClose={onClose}>
        <button type="button" onClick={onIncludeClick}>Include</button>
      </ContextMenuShell>
    );
  }

  // Remote rows are read-only locally: the spec authorizes only `pull`,
  // so the Rename / Remove and Delete groups are absent.
  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      {isRemote
        ? (
          <>
            <button type="button" onClick={onSync}>Pull</button>
            {exportButton}
          </>
        )
        : (
          <>
            <button type="button" onClick={onRename}>Rename</button>
            <button type="button" onClick={onRemove}>Remove</button>
            <MenuSeparator />
            <button type="button" onClick={onSync}>Push</button>
            {exportButton}
            <MenuSeparator />
            <button type="button" className="danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
    </ContextMenuShell>
  );
}
