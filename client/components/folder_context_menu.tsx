// Folder right-click menu (content.md Right-click menu -> Folder): New
// Markdown / New Folder (create under this folder), Include in Coconote
// (admit every supported file under it), Push (local) / Pull (remote)
// batch sync, Rename / Remove / Delete (non-root local only - roots are
// renamed/dropped via Setting). Ops in lib/page_ops.ts + lib/include.ts.

import {
  createMarkdownPage,
  deleteFolder,
  putDirectory,
  removeFolderFromIndex,
  renameFolder,
} from "../lib/page_ops.ts";
import { fetchExcludedPaths, includePath } from "../lib/include.ts";
import { nameToFsPath } from "../lib/path_url.ts";
import { ContextMenuShell } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  /** Vault-relative folder path, e.g. `main/notes`. Empty for the root. */
  folderPath: string;
  x: number;
  y: number;
  /** Remote folders only support `Pull`, locals get New/New + Push. */
  isRemote: boolean;
  onClose(): void;
  onChanged(): void;
  onPushFolder(folderPath: string): void;
  onPullFolder(remoteFolderPath: string): void;
};

export function FolderContextMenu(
  {
    client,
    folderPath,
    x,
    y,
    isRemote,
    onClose,
    onChanged,
    onPushFolder,
    onPullFolder,
  }: Props,
) {
  // A configured root is a single top-level segment (no "/"). Its
  // rename/remove live in Setting, so the destructive items are hidden.
  const isRoot = !folderPath.includes("/");

  // On-disk paths of every local page under this folder. Drives the
  // recursive folder ops.
  const fullPathsUnder = (): string[] =>
    client.ui.viewState.allPages
      .filter((p) =>
        p.origin?.kind !== "remote" &&
        (p.name === folderPath || p.name.startsWith(`${folderPath}/`))
      )
      .map((p) => nameToFsPath(p.name));

  const onNewMarkdown = async () => {
    const raw = await client.ui.prompt("New markdown filename:", "");
    if (!raw) return onClose();
    const cleaned = raw.trim().replace(/\.md$/i, "");
    if (!cleaned) return onClose();
    const target = (folderPath ? `${folderPath}/${cleaned}` : cleaned) + ".md";
    try {
      // content.md: same-named file on disk with coconote:false -> flip
      // the key instead of overwriting the user's body. An ALREADY
      // included file is left untouched (no bogus edit row).
      const result = await createMarkdownPage(target);
      if (result === "already-included") {
        await client.ui.confirm(`${target} already exists in Coconote.`);
      } else {
        onChanged();
      }
    } catch (e) {
      console.error(`New markdown failed: ${e}`);
    }
    onClose();
  };

  const onNewFolder = async () => {
    const raw = await client.ui.prompt("New folder name:", "");
    if (!raw) return onClose();
    const cleaned = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return onClose();
    // content.md Right-click -> Folder: "creates a new folder UNDER the
    // folder" - concat under folderPath, never as sibling.
    const target = folderPath ? `${folderPath}/${cleaned}` : cleaned;
    try {
      await putDirectory(target);
      onChanged();
    } catch (e) {
      console.error(`New folder failed: ${e}`);
    }
    onClose();
  };

  // content.md: include every supported file under the folder that is
  // not yet included. Counted + confirmed first, because this writes
  // frontmatter / sidecars into possibly many files at once.
  const onIncludeAll = async () => {
    try {
      const targets = (await fetchExcludedPaths())
        .filter((p) => p.startsWith(`${folderPath}/`));
      if (targets.length === 0) {
        await client.ui.confirm(
          `Every supported file under ${folderPath} is already in Coconote.`,
        );
        return onClose();
      }
      const ok = await client.ui.confirm(
        `Include ${targets.length} file(s) under ${folderPath} into Coconote?`,
      );
      if (!ok) return onClose();
      for (const p of targets) await includePath(p);
      onChanged();
    } catch (e) {
      console.error(`Include folder failed: ${e}`);
    }
    onClose();
  };

  // Rename keeps the folder inside its root: edit only the path after the
  // leading root segment, which is re-attached unchanged.
  const onRename = async () => {
    const slash = folderPath.indexOf("/");
    const rootPrefix = slash < 0 ? "" : folderPath.slice(0, slash + 1);
    const rest = slash < 0 ? folderPath : folderPath.slice(slash + 1);
    const raw = await client.ui.prompt("New folder path:", rest);
    if (!raw) return onClose();
    const cleaned = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || cleaned === rest) return onClose();
    try {
      await renameFolder(folderPath, rootPrefix + cleaned, fullPathsUnder());
      onChanged();
    } catch (e) {
      console.error(`Rename folder failed: ${e}`);
    }
    onClose();
  };

  const onRemove = async () => {
    const ok = await client.ui.confirm(
      `Remove every file in ${folderPath} from Coconote? The files stay on disk.`,
    );
    if (!ok) return onClose();
    try {
      await removeFolderFromIndex(fullPathsUnder());
      onChanged();
    } catch (e) {
      console.error(`Remove folder failed: ${e}`);
    }
    onClose();
  };

  const onDelete = async () => {
    const ok = await client.ui.confirm(
      `Delete ${folderPath} and everything in it? This cannot be undone.`,
    );
    if (!ok) return onClose();
    try {
      await deleteFolder(folderPath, fullPathsUnder());
      onChanged();
    } catch (e) {
      console.error(`Delete folder failed: ${e}`);
    }
    onClose();
  };

  const onPush = () => {
    onPushFolder(folderPath);
    onClose();
  };
  const onPull = () => {
    onPullFolder(folderPath);
    onClose();
  };

  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      {isRemote
        ? <button type="button" onClick={onPull}>Pull</button>
        : (
          <>
            <button type="button" onClick={onNewMarkdown}>New Markdown</button>
            <button type="button" onClick={onNewFolder}>New Folder</button>
            <button type="button" onClick={onIncludeAll}>
              Include in Coconote
            </button>
            {isRoot
              ? <button type="button" onClick={onPush}>Push</button>
              // Same action order as the file menu (Rename, Remove,
              // Push, Delete).
              : (
                <>
                  <button type="button" onClick={onRename}>Rename</button>
                  <button type="button" onClick={onRemove}>Remove</button>
                  <button type="button" onClick={onPush}>Push</button>
                  <button type="button" className="danger" onClick={onDelete}>
                    Delete
                  </button>
                </>
              )}
          </>
        )}
    </ContextMenuShell>
  );
}
