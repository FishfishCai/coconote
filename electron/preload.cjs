// Renderer bridge: exposes `window.coconoteShell` to the sidecar-served
// page. isElectron is the presence flag the client tests, invoke(cmd,
// args) calls an ipcMain handler. Also reroutes target="_blank" anchor
// clicks (editor Cmd+Click) to the OS browser.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// OS file-open paths (double-click / "Open with") pushed by the main process.
// Buffer them until the renderer registers its handler: preload runs before
// the page bundle finishes its async boot, so a path that arrives early would
// otherwise be dropped.
const openPathBuffer = [];
let openPathHandler = null;
ipcRenderer.on("coconote_open_path", (_event, osPath) => {
  if (typeof osPath !== "string" || !osPath) return;
  if (openPathHandler) openPathHandler(osPath);
  else openPathBuffer.push(osPath);
});

// Everything goes through ipcRenderer so the preload stays sandbox-
// compatible (no `shell` module in a sandboxed preload). The main process
// applies a URL-scheme allowlist before opening anything externally.
contextBridge.exposeInMainWorld("coconoteShell", {
  isElectron: true,
  invoke(channel, args) {
    // Channel allowlist keeps the surface small in case the renderer is
    // ever exposed to untrusted content.
    const allowed = ["coconote_open_window"];
    if (!allowed.includes(channel)) {
      return Promise.reject(new Error(`channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, args);
  },
  // Register the renderer's OS-open handler and flush anything buffered
  // before it was ready.
  onOpenPath(cb) {
    openPathHandler = typeof cb === "function" ? cb : null;
    if (openPathHandler && openPathBuffer.length) {
      const pending = openPathBuffer.splice(0);
      for (const p of pending) openPathHandler(p);
    }
  },
  // electron >= 32 replaced File.path with webUtils.getPathForFile. Resolve a
  // dropped File to its absolute OS path so the renderer can open it.
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});

// Anchor click interception, capture phase: runs before the page's own
// handlers and can preventDefault cleanly.
window.addEventListener(
  "DOMContentLoaded",
  () => {
    document.addEventListener(
      "click",
      (event) => {
        const path = event.composedPath ? event.composedPath() : [];
        const a = path.find((n) => n && n.tagName === "A");
        if (!a || a.target !== "_blank") return;
        event.preventDefault();
        void ipcRenderer.invoke("coconote_open_external", a.href);
      },
      true,
    );
  },
  { once: true },
);
