// Electron entry: probe-or-spawn the coconote sidecar on :40704, then load
// the WebView. Only the child we spawned gets SIGTERM (an already-running
// coconote is borrowed). All config, mounted roots included, is coconote.yaml
// in the server's per-user config dir (welcome.md), so no vault-path prompt.

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";

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

// Setting -> Config file IPC. Channel names match what
// client/lib/config_path_api.ts invokes through the preload bridge.
ipcMain.handle("coconote_config_path", () => {
  const dir = readEffectiveConfigDir();
  return dir ? dir : "";
});

ipcMain.handle("coconote_apply_config_path", async (_event, args) => {
  // Renderer payloads are untrusted: accept any shape (no destructure) and
  // reject an empty path with a rejected invoke() promise instead of
  // relaunching on bogus input.
  const p = String(args?.path ?? "").trim();
  if (!p) throw new Error("coconote_apply_config_path: path is empty");
  writeConfigPointer(p);
  // Take the owned sidecar down before relaunch so the fresh shell can bind
  // :40704, and WAIT for the exit: shutdownOwned() only sends SIGTERM, and
  // exiting now would let the relaunched shell probe the still-draining old
  // server and adopt it with the OLD config. relaunch + exit re-execs.
  shutdownOwned();
  await waitForExit(3000);
  app.relaunch();
  app.exit(0);
});

// Export PDF (client/lib/export.ts): render the self-contained HTML
// the client assembled in a hidden window and return the printToPDF
// bytes. A temp file (not a data: URL) keeps loadFile's file: origin so
// document.fonts settles normally.
ipcMain.handle("coconote_export_pdf", async (_event, args) => {
  const html = String(args?.html ?? "");
  if (!html) throw new Error("coconote_export_pdf: html is empty");
  const tmpFile = join(
    app.getPath("temp"),
    `coconote-export-${Date.now()}-${process.pid}.html`,
  );
  await writeFile(tmpFile, html, "utf-8");
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(tmpFile);
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)",
      true,
    );
    return await win.webContents.printToPDF({ printBackground: true });
  } finally {
    win.destroy();
    await unlink(tmpFile).catch(() => {});
  }
});

// Open a URL in the OS browser, but ONLY http/https/mailto: the renderer is
// loopback-served, so an unfiltered openExternal would let page content
// launch file:/// or custom-protocol handlers. Single chokepoint for
// window.open, target=_blank clicks (via preload IPC), and stray navigations.
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
  // macOS Dock: never call app.dock.setIcon. The packaged app already shows
  // icon.icns composited onto the system rounded-square plate, and setIcon
  // would replace that with the raw png (no plate): the "icon changed after
  // launch" bug. Dev runs show Electron's own plated icon, which is fine.
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    title: "Coconote",
    backgroundColor: "#ffffff",
    // Linux: set the window icon explicitly or some DEs show the stock
    // Electron icon. macOS / Windows take theirs from the bundle / exe. The
    // png is packed into the asar via builder.config.json "files".
    ...(process.platform === "linux"
      ? { icon: join(__dirname, "icons/icon.png") }
      : {}),
    // macOS: traffic lights overlay the content area. On Linux / Windows
    // keep the native title bar.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The sidecar URL serves both the HTML/JS bundle and the API.
  win.loadURL(`http://${HOST}:${PORT}/`);

  // target="_blank" / window.open go to the user's browser, not a child
  // BrowserWindow. The preload catches anchor clicks, this covers window.open().
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });

  // Navigations away from the sidecar URL (external links the preload
  // missed) also go to the system browser. Both 127.0.0.1 and localhost
  // are internal (the server logs the latter).
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
  // Force direct connections: the renderer only talks to the loopback
  // sidecar (external links open in the system browser), and skipping
  // Chromium's system-proxy / PAC resolution avoids a one-time stall on
  // the first server request (felt as a slow first panel open).
  await session.defaultSession.setProxy({ mode: "direct" });

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
    // Existing coconote: borrowing. Don't tear it down on quit.
    console.log(`coconote: borrowing existing coconote server on :${PORT}`);
  }

  createWindow();
}

app.whenReady().then(bootstrap);

// macOS idiom: dock click with no windows open re-creates one. The sidecar
// staying alive across this is fine: bootstrap's probe will re-borrow.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrap();
  }
});

// macOS stays resident so `activate` can re-create the window (standard
// idiom). Owned-sidecar cleanup happens in before-quit.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shutdownOwned();
});
