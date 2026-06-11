// Renderer-side bridge. Exposes `window.coconoteShell` to the page
// loaded from the sidecar at http://localhost:40704.
//
//   coconoteShell.isElectron       → true (presence test for the
//                                    client-side helper in
//                                    client/lib/config_path_api.ts)
//   coconoteShell.invoke(cmd, args) → call an ipcMain handler
//   coconoteShell.openExternal(url) → open in user's browser
//
// We also intercept `target="_blank"` anchor clicks so the editor's
// Cmd+Click handler lands in the system browser instead of trying to
// open a child BrowserWindow.

const { contextBridge, ipcRenderer } = require("electron");

// Everything goes through ipcRenderer so this preload stays
// sandbox-compatible (the main-process `shell` module isn't available in
// a sandboxed preload). The main process applies a URL-scheme allowlist
// before opening anything externally.
contextBridge.exposeInMainWorld("coconoteShell", {
  isElectron: true,
  invoke(channel, args) {
    // The client only calls the two `coconote_*` channels; an allow
    // list keeps the surface area small in case the renderer is later
    // exposed to untrusted content.
    if (channel !== "coconote_config_path" && channel !== "coconote_apply_config_path") {
      return Promise.reject(new Error(`channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, args);
  },
  openExternal(url) {
    return ipcRenderer.invoke("coconote_open_external", url);
  },
});

// Anchor click interception — installed in capture phase so it runs
// before the page's own handlers and can preventDefault cleanly.
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
