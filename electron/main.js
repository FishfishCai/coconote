// Electron entry. Probe-or-spawn the coconote sidecar on :40704 before
// loading the WebView. 1:1 app ⇔ owned sidecar (we only SIGTERM the
// child we spawned ourselves — a previously-running coconote is
// borrowed). All config — including which roots to mount — lives in
// coconote.yaml, loaded by the server itself from the standard per-user
// config dir (welcome.md §coconote.yaml). The shell never asks for a
// vault path.

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

import {
  PORT,
  HOST,
  HEALTH_URL,
  probe,
  waitForHealth,
  spawnSidecar,
  shutdownOwned,
  waitForExit,
  resolveServerBinary,
  readEffectiveConfigDir,
  writeConfigPointer,
} from "./lifecycle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Single-instance: focus the existing window on a second launch.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const all = BrowserWindow.getAllWindows();
  if (all.length > 0) {
    const w = all[0];
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

// Setting → Config file IPC. Channel names match what
// client/lib/config_path_api.ts invokes through the preload bridge.
ipcMain.handle("coconote_config_path", () => {
  const dir = readEffectiveConfigDir();
  return dir ? dir : "";
});

ipcMain.handle("coconote_apply_config_path", async (_event, args) => {
  // Renderer payloads are untrusted: tolerate any shape (no destructure)
  // and reject an empty path with a clean error reply (a rejected
  // invoke() promise) instead of relaunching on bogus input.
  const p = String(args?.path ?? "").trim();
  if (!p) throw new Error("coconote_apply_config_path: path is empty");
  writeConfigPointer(p);
  // Take the owned sidecar down before relaunch so the fresh shell can
  // bind :40704 — and WAIT for it to actually exit. shutdownOwned() only
  // sends SIGTERM; exiting immediately would let the relaunched shell
  // probe the still-draining old server and adopt it with the OLD
  // config. relaunch + exit then re-execs the Electron app.
  shutdownOwned();
  await waitForExit(3000);
  app.relaunch();
  app.exit(0);
});

// Open a URL in the OS browser — but ONLY http/https/mailto. The renderer
// is loopback-served, so an unfiltered openExternal would let page content
// launch file:/// or custom-protocol handlers. Single chokepoint for
// window.open, target=_blank clicks (via preload IPC), and stray
// navigations.
function openExternalSafe(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl ?? ""));
  } catch {
    return;
  }
  if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
    void shell.openExternal(u.href);
  }
}
ipcMain.handle("coconote_open_external", (_event, url) => openExternalSafe(url));

function createWindow() {
  // macOS Dock: a packaged app gets icon.icns from the bundle, but a dev
  // run (`npx electron .`) uses the stock Electron binary whose bundle
  // icon is the Electron logo — set it at runtime so dev matches.
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(join(__dirname, "icons/icon.png"));
    } catch { /* icon missing in a stripped build — keep the default */ }
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    title: "Coconote",
    backgroundColor: "#ffffff",
    // Linux: set the window icon explicitly or some DEs show the stock
    // Electron icon. macOS / Windows take theirs from the bundle / exe;
    // the png is packed into the asar via builder.config.json "files".
    ...(process.platform === "linux"
      ? { icon: join(__dirname, "icons/icon.png") }
      : {}),
    // macOS: traffic lights overlay the content area. On Linux / Windows
    // keep the native title bar.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          titleBarOverlay: false,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  // The renderer talks to the sidecar at http://localhost:40704; that
  // URL serves both the HTML/JS bundle and the API.
  win.loadURL(`http://${HOST}:${PORT}/`);

  // Click on `target="_blank"` and window.open in the renderer should
  // open in the user's browser, not a child BrowserWindow. The preload
  // script catches anchor clicks; this covers window.open().
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });

  // Any navigation away from the sidecar URL (mostly external links
  // missed by the preload) should also go to the system browser. Both
  // 127.0.0.1 and localhost are internal (the server logs the latter).
  win.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith(`http://${HOST}:${PORT}`) &&
      !url.startsWith(`http://localhost:${PORT}`)
    ) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  return win;
}

async function bootstrap() {
  const probeResult = await probe();
  if (probeResult === "foreign") {
    dialog.showErrorBox(
      "coconote",
      `Port ${PORT} is busy with a non-coconote process. Quit it and ` +
        `relaunch (try \`lsof -i :${PORT}\`).`,
    );
    app.exit(1);
    return;
  }

  if (probeResult === "free") {
    const bin = resolveServerBinary();
    if (!bin || !existsSync(bin)) {
      dialog.showErrorBox(
        "coconote",
        `Failed to launch coconote: bundled sidecar not found.\n\n` +
          `Set COCONOTE_SERVER_PATH or run \`make build\`.`,
      );
      app.exit(1);
      return;
    }
    try {
      spawnSidecar(bin);
    } catch (e) {
      dialog.showErrorBox("coconote", `Failed to launch coconote:\n${e.message ?? e}`);
      app.exit(1);
      return;
    }
    const healthy = await waitForHealth();
    if (!healthy) {
      dialog.showErrorBox(
        "coconote",
        `coconote failed to start (no ${HEALTH_URL} response within 5s).`,
      );
      shutdownOwned();
      app.exit(1);
      return;
    }
  } else {
    // Existing coconote — borrowing. Don't tear it down on quit.
    console.log(`coconote: borrowing existing coconote server on :${PORT}`);
  }

  createWindow();
}

app.whenReady().then(bootstrap);

// macOS: re-create the window when the dock icon is clicked and no
// other windows are open (standard macOS-app idiom). Keeping the
// sidecar alive across this is fine — bootstrap's probe will re-borrow.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrap();
  }
});

// Quit when all windows close, except on macOS where the app stays
// resident and `activate` re-creates the window (standard macOS idiom;
// otherwise the activate handler below is unreachable). Owned-sidecar
// cleanup happens in before-quit.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdownOwned();
});
