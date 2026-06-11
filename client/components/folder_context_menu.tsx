// Folder right-click menu (content.md §Right-click menu → Folder):
//   • New Markdown – prompts for a name; creates <folder>/<name>.md
//                    with `coconote: true` frontmatter. If a same-named
//                    file already exists with `coconote: false`, flip
//                    that key to true instead of overwriting; if it is
//                    already included, surface "already exists".
//   • New Folder   – prompts for a name; PUT /.file/<folder>/<name>?type=dir.
// Dispatch-only: the file operations live in lib/page_ops.ts.

import { createMarkdownPage, putDirectory } from "../lib/page_ops.ts";
import { ContextMenuShell } from "./context_menu_shell.tsx";
import type { ClientContext as Client } from "../core/context.ts";

type Props = {
  client: Client;
  /** Vault-relative folder path, e.g. `main/notes`. Empty for the root. */
  folderPath: string;
  x: number;
  y: number;
  /** Remote folders only support `Pull`; locals get New/New + Push. */
  isRemote?: boolean;
  onClose(): void;
  onChanged(): void;
  onPushFolder?(folderPath: string): void;
  onPullFolder?(remoteFolderPath: string): void;
};

export function FolderContextMenu(
  {
    client,
    folderPath,
    x,
    y,
    isRemote = false,
    onClose,
    onChanged,
    onPushFolder,
    onPullFolder,
  }: Props,
) {
  const onNewMarkdown = async () => {
    const raw = await client.ui.prompt("New markdown filename:", "");
    if (!raw) return onClose();
    const cleaned = raw.trim().replace(/\.md$/i, "");
    if (!cleaned) return onClose();
    const target = (folderPath ? `${folderPath}/${cleaned}` : cleaned) + ".md";
    try {
      // content.md: same-named file already on disk with coconote:false
      // → flip the key instead of overwriting the user's body. A file
      // that is ALREADY included is left untouched (no bogus edit row).
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
    // content.md §Right-click → Folder: "creates a new folder UNDER the
    // folder" — concat under folderPath, never as sibling.
    const target = folderPath ? `${folderPath}/${cleaned}` : cleaned;
    try {
      await putDirectory(target);
      onChanged();
    } catch (e) {
      console.error(`New folder failed: ${e}`);
    }
    onClose();
  };

  const onPush = () => {
    onPushFolder?.(folderPath);
    onClose();
  };
  const onPull = () => {
    onPullFolder?.(folderPath);
    onClose();
  };

  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      {isRemote
        ? onPullFolder && (
          <button type="button" onClick={onPull}>Pull</button>
        )
        : (
          <>
            <button type="button" onClick={onNewMarkdown}>New Markdown</button>
            <button type="button" onClick={onNewFolder}>New Folder</button>
            {onPushFolder && (
              <button type="button" onClick={onPush}>Push</button>
            )}
          </>
        )}
    </ContextMenuShell>
  );
}
