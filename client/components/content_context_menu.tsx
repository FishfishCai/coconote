// Right-click menu for a content-browser Path-view file row (Tag view
// is read-only). content.md Right-click menu: .md or .pdf -> Rename /
// Remove / Delete, plus Push (local) or Pull (remote), plus Export as
// PDF / HTML (HTML for md only). Rename rewrites every [[wikilink]] to
// the old name. Dispatch-only: lib/page_ops.ts and lib/export.ts.

import { exportHtml, exportPdfOfMd, exportPdfOfPdf } from "../lib/export.ts";
import { deletePage, removeFromIndex, renamePage } from "../lib/page_ops.ts";
import { nameToFsPath } from "../lib/path_url.ts";
import { ContextMenuShell } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  pageName: string;
  x: number;
  y: number;
  /** Local files get `Push`, remote files `Pull` (content.md push/pull). */
  isRemote: boolean;
  /** Set by "show all supported files" mode for non-admitted rows.
   *  content.md: only "Include in Coconote" is offered. */
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

  // Remove flips the include flag (md frontmatter / pdf sidecar), the
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
    if (isRemote) onPull(pageName);
    else onPush(fullPath);
    onClose();
  };

  const onIncludeClick = () => {
    onInclude(fullPath);
    onClose();
  };

  // Exports download to the local machine, never into the vault, so
  // they apply to remote rows too.
  const onExportPdf = async () => {
    try {
      if (isMd) await exportPdfOfMd(client, pageName);
      else await exportPdfOfPdf(client, pageName);
    } catch (e) {
      console.error(`Export failed: ${e}`);
    }
    onClose();
  };

  const onExportHtml = async () => {
    try {
      await exportHtml(client, pageName);
    } catch (e) {
      console.error(`Export failed: ${e}`);
    }
    onClose();
  };

  const exportButtons = (
    <>
      <button type="button" onClick={onExportPdf}>Export as PDF</button>
      {isMd && (
        <button type="button" onClick={onExportHtml}>Export as HTML</button>
      )}
    </>
  );

  // file.md / content.md: excluded rows (visible only in "show all
  // supported files" mode) expose a single action - Include in Coconote.
  if (isExcluded) {
    return (
      <ContextMenuShell x={x} y={y} onClose={onClose}>
        <button type="button" onClick={onIncludeClick}>
          Include in Coconote
        </button>
      </ContextMenuShell>
    );
  }

  // Remote rows are read-only locally: the spec authorizes only `pull`.
  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      {isRemote
        ? (
          <>
            <button type="button" onClick={onSync}>Pull</button>
            {exportButtons}
          </>
        )
        : (
          <>
            <button type="button" onClick={onRename}>Rename</button>
            <button type="button" onClick={onRemove}>Remove</button>
            <button type="button" onClick={onSync}>Push</button>
            {exportButtons}
            <button type="button" className="danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
    </ContextMenuShell>
  );
}
