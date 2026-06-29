// setting.md L96 lists two OS-driven ways to open a file beyond the recent
// picker and link-follow: double-clicking it in the file manager and dragging
// it into the window. This wires both for the desktop shell:
//   - double-click / "Open with": the electron main process resolves the OS
//     path and pushes it over the `coconote_open_path` IPC channel (preload
//     exposes it as coconoteShell.onOpenPath).
//   - drag-in: a window-level drop handler reads the dropped file's OS path
//     through the preload webUtils bridge.
// Either way the absolute path is resolved to an id and opened (recorded in
// recent) via navigator.openOsPath. No-op in a plain browser, which can see
// neither the IPC channel nor a file's OS path.

import type { Client } from "./client.ts";
import { electronShell } from "./lifecycle.ts";
import { openOsPath } from "./navigator.ts";

export function wireOsFileOpen(client: Client): void {
  // OS file-open is a desktop-shell feature: a plain browser can see neither
  // the IPC channel nor a dropped file's OS path, and we must not change its
  // native file-drop behaviour. Bail out unless we're in electron.
  const shell = electronShell();
  if (!shell) return;

  // Double-click / "Open with" -> main forwards the absolute path here.
  shell.onOpenPath?.((path) => void openOsPath(client, path));

  const draggingFiles = (dt: DataTransfer | null) =>
    !!dt && Array.from(dt.types).includes("Files");

  // A drop target only fires `drop` if `dragover` preventDefaults, so allow
  // the drop for file drags. Capture phase keeps the editor's own text-drag
  // handling untouched (it sees non-file drags as before).
  globalThis.addEventListener("dragover", (e: DragEvent) => {
    if (draggingFiles(e.dataTransfer)) e.preventDefault();
  }, true);

  globalThis.addEventListener("drop", (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return; // text drag -> leave to editor
    // Stop electron's default file: navigation (will-navigate would bounce it
    // to the external-link rejecter) and open the dropped file(s) instead.
    e.preventDefault();
    e.stopPropagation();
    if (!shell.getPathForFile) return;
    for (const file of Array.from(files)) {
      const path = shell.getPathForFile(file);
      if (path) void openOsPath(client, path);
    }
  }, true);
}
