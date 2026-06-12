// Renderer bridge: exposes `window.coconoteShell` to the sidecar-served
// page. isElectron is the presence flag client/lib/config_path_api.ts
// tests, invoke(cmd, args) calls an ipcMain handler. Also reroutes
// target="_blank" anchor clicks (editor Cmd+Click) to the OS browser.

const { contextBridge, ipcRenderer } = require("electron");

// Everything goes through ipcRenderer so the preload stays sandbox-
// compatible (no `shell` module in a sandboxed preload). The main process
// applies a URL-scheme allowlist before opening anything externally.
contextBridge.exposeInMainWorld("coconoteShell", {
  isElectron: true,
  invoke(channel, args) {
    // Channel allowlist keeps the surface small in case the renderer is
    // ever exposed to untrusted content.
    const allowed = [
      "coconote_config_path",
      "coconote_apply_config_path",
    ];
    if (!allowed.includes(channel)) {
      return Promise.reject(new Error(`channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, args);
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
