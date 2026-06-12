// Folder right-click menu (content.md Right-click menu -> Folder).
// Grouped template: New Markdown / New Folder, Include (N) when N
// excluded files sit under the folder (local roots only), Rename /
// Remove, Push (local) / Pull (remote) batch sync, Delete alone.
// Rename / Remove / Delete are non-root local only (roots are renamed
// or dropped via Setting) and broadcast over the included pages under
// the folder. A folder with zero included pages (All view only) offers
// only Include (N). Ops in lib/page_ops.ts + lib/include.ts.

import { useEffect, useState } from "preact/hooks";
import {
  createMarkdownPage,
  deleteFolder,
  putDirectory,
  removeFolderFromIndex,
  renameFolder,
} from "../lib/page_ops.ts";
import { fetchExcludedPaths, includePath } from "../lib/include.ts";
import { errMessage } from "../lib/constants.ts";
import { nameToFsPath } from "../lib/path_url.ts";
import { ContextMenuShell, MenuSeparator } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  /** Vault-relative folder path, e.g. `main/notes`. Empty for the root. */
  folderPath: string;
  x: number;
  y: number;
  /** Remote folders only support `Pull`, locals get the full template. */
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

  // Excluded supported files under this folder, for the Include (N)
  // label and the Rename warning. null while the listing loads. Local
  // roots only: remotes expose no excluded data.
  const [excludedUnder, setExcludedUnder] = useState<string[] | null>(null);
  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    void fetchExcludedPaths()
      .then((all) => {
        if (cancelled) return;
        setExcludedUnder(all.filter((p) => p.startsWith(`${folderPath}/`)));
      })
      .catch(() => {/* listing failed: no Include item */});
    return () => {
      cancelled = true;
    };
  }, [isRemote, folderPath]);

  // On-disk paths of every local page under this folder. Drives the
  // recursive folder ops.
  const fullPathsUnder = (): string[] =>
    client.ui.viewState.allPages
      .filter((p) =>
        p.origin?.kind !== "remote" &&
        (p.name === folderPath || p.name.startsWith(`${folderPath}/`))
      )
      .map((p) => nameToFsPath(p.name));

  // content.md: a failed menu action reports in a modal, never silently.
  const fail = (action: string, e: unknown) =>
    client.ui.notice(`${action} failed: ${errMessage(e)}`);

  const onNewMarkdown = async () => {
    const raw = await client.ui.prompt("New markdown filename:", "");
    if (!raw) return onClose();
    const cleaned = raw.trim().replace(/\.md$/i, "");
    if (!cleaned) return onClose();
    const target = (folderPath ? `${folderPath}/${cleaned}` : cleaned) + ".md";
    try {
      // content.md: same-named file on disk with coconote:false -> flip
      // the key instead of overwriting the user's body, with a notice.
      // An ALREADY included file is left untouched (no bogus edit row).
      const result = await createMarkdownPage(target);
      if (result === "already-included") {
        await client.ui.notice(`${target} already exists in Coconote.`);
      } else {
        if (result === "admitted") {
          await client.ui.notice(
            `${target} already existed on disk and was included instead of created.`,
          );
        }
        onChanged();
      }
    } catch (e) {
      await fail("New markdown", e);
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
      await fail("New folder", e);
    }
    onClose();
  };

  // content.md: include every excluded supported file under the folder.
  // Confirmed first, because this writes frontmatter / sidecars into
  // possibly many files at once.
  const onIncludeAll = async (targets: string[]) => {
    const ok = await client.ui.confirm(
      `Include ${targets.length} file(s) under ${folderPath} into Coconote?`,
    );
    if (!ok) return onClose();
    try {
      for (const p of targets) await includePath(p);
      onChanged();
    } catch (e) {
      await fail("Include", e);
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
    const newFolder = rootPrefix + cleaned;
    // content.md: only the included pages move, warn when excluded
    // files would stay behind.
    if (excludedUnder && excludedUnder.length > 0) {
      const ok = await client.ui.confirm(
        `Rename ${folderPath} to ${newFolder}? ` +
          `${excludedUnder.length} files not in Coconote will stay in the old folder.`,
      );
      if (!ok) return onClose();
    }
    try {
      await renameFolder(folderPath, newFolder, fullPathsUnder());
      onChanged();
    } catch (e) {
      await fail("Rename folder", e);
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
      await fail("Remove folder", e);
    }
    onClose();
  };

  const onDelete = async () => {
    const targets = fullPathsUnder();
    // content.md: Delete states its actual scope - the included pages.
    const ok = await client.ui.confirm(
      `Delete ${targets.length} Coconote pages under ${folderPath}? ` +
        `Files not in Coconote stay on disk.`,
    );
    if (!ok) return onClose();
    try {
      await deleteFolder(folderPath, targets);
      onChanged();
    } catch (e) {
      await fail("Delete folder", e);
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

  if (isRemote) {
    return (
      <ContextMenuShell x={x} y={y} onClose={onClose}>
        <button type="button" onClick={onPull}>Pull</button>
      </ContextMenuShell>
    );
  }

  const includeItem = excludedUnder && excludedUnder.length > 0
    ? (
      <button type="button" onClick={() => onIncludeAll(excludedUnder)}>
        Include ({excludedUnder.length})
      </button>
    )
    : null;

  // Fully-excluded folder (subtree holds zero included pages, possible
  // only in the All display mode): Include is the only sane action, so
  // it is the only item. Hold the menu until the listing arrives.
  if (fullPathsUnder().length === 0) {
    if (!includeItem) return null;
    return (
      <ContextMenuShell x={x} y={y} onClose={onClose}>
        {includeItem}
      </ContextMenuShell>
    );
  }

  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      <button type="button" onClick={onNewMarkdown}>New Markdown</button>
      <button type="button" onClick={onNewFolder}>New Folder</button>
      {includeItem && (
        <>
          <MenuSeparator />
          {includeItem}
        </>
      )}
      <MenuSeparator />
      {!isRoot && (
        <>
          <button type="button" onClick={onRename}>Rename</button>
          <button type="button" onClick={onRemove}>Remove</button>
          <MenuSeparator />
        </>
      )}
      <button type="button" onClick={onPush}>Push</button>
      {!isRoot && (
        <>
          <MenuSeparator />
          <button type="button" className="danger" onClick={onDelete}>
            Delete
          </button>
        </>
      )}
    </ContextMenuShell>
  );
}
