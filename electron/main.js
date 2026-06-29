// Electron entry: probe-or-spawn the coconote sidecar on :40704, then load
// the WebView. Only the child we spawned gets SIGTERM (an already-running
// coconote is borrowed). All config, mounted roots included, is coconote.yaml
// in the server's per-user config dir, so no vault-path prompt.

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
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
  resolveServerBinary,
} from "./lifecycle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Single-instance lock: one process owns the shared sidecar. A second
// launch is routed here instead of starting a rival process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Flipped true once bootstrap() has the sidecar healthy. A second launch
// (or macOS activate) must not open a window against a not-yet-ready or
// since-died server.
let ready = false;

// OS file-open queue (double-click a file in the file manager, or "Open
// with" Coconote). macOS delivers these via open-file,
// Windows/Linux via the launch argv (first instance) or second-instance argv.
// Paths that arrive before a window exists wait here; bootstrap drains them.
let pendingOpenPaths = [];
// process.argv is the ORIGINAL launch argv and never changes, so its file arg
// must be consumed exactly once - not re-opened on every activate/bootstrap.
let firstLaunchConsumed = false;

// Pull a file path Coconote was asked to open out of an argv. Skips the
// launcher (and the app path under `electron .` dev runs) and matches only the
// associated extensions so a stray flag/value isn't mistaken for a document.
function fileArgFrom(argv) {
  const rest = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of rest) {
    if (!a || a.startsWith("-")) continue;
    if (/\.(md|pdf)$/i.test(a) && existsSync(a)) return a;
  }
  return null;
}

// Hand an OS path to a renderer window. Wait for the load to finish so the
// preload's IPC bridge is attached (it buffers until the renderer subscribes,
// so an early frame is safe regardless).
function sendOpenPath(win, osPath) {
  if (!win || !osPath) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => wc.send("coconote_open_path", osPath));
  } else {
    wc.send("coconote_open_path", osPath);
  }
}

// macOS double-click / "Open with" / drag-onto-dock. Fires before `ready` on a
// cold launch, so queue until bootstrap opens a window; afterwards open a
// fresh window for the file (one file per window) and forward the path.
app.on("open-file", (event, osPath) => {
  event.preventDefault();
  if (ready && BrowserWindow.getAllWindows().length > 0) {
    const win = createWindow();
    win.show();
    win.focus();
    sendOpenPath(win, osPath);
  } else {
    pendingOpenPaths.push(osPath);
    if (ready) void bootstrap(); // all windows were closed - re-open
  }
});

// A second launch opens a fresh window in this instance (multi-window),
// rather than only re-focusing an existing one - so launching the app
// again always yields a usable window. Mirror activate's reuse-or-bootstrap
// logic: if every window was closed (macOS stays resident) the sidecar may
// have died, so re-probe/re-borrow it via bootstrap before opening; if the
// first launch's bootstrap has not finished yet, bootstrap will open the
// window when it completes. Either way bring the app forward.
app.on("second-instance", (_event, argv) => {
  app.focus({ steal: true });
  // Windows/Linux route a file double-click / "Open with" through a second
  // launch whose argv carries the path.
  const filePath = fileArgFrom(argv);
  if (!ready || BrowserWindow.getAllWindows().length === 0) {
    if (filePath) pendingOpenPaths.push(filePath);
    void bootstrap();
    return;
  }
  const win = createWindow();
  win.show();
  win.focus();
  if (filePath) sendOpenPath(win, filePath);
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

// Open an INTERNAL page in a new Electron window (editor Cmd/Ctrl+Click on a
// wikilink). Renderer payloads are untrusted: accept any shape (no
// destructure), resolve the path against the loopback origin, and open a
// window ONLY when it stays on http://HOST:PORT. This rejects external URLs,
// other schemes (file:, javascript:), and protocol-relative //host hijacks -
// those must never become a borderless app window. Returns whether a window
// was opened so the renderer doesn't silently fall through to globalThis.open.
const INTERNAL_ORIGIN = `http://${HOST}:${PORT}`;
ipcMain.handle("coconote_open_window", (_event, args) => {
  const raw = String(args?.path ?? "");
  let u;
  try {
    // Base resolves relative paths like "notes/foo"; an absolute href that
    // points elsewhere keeps its own origin and fails the check below.
    u = new URL(raw, `${INTERNAL_ORIGIN}/`);
  } catch {
    return false;
  }
  if (u.origin !== INTERNAL_ORIGIN) return false;
  // Strip the leading slash: createWindow appends the path to the origin.
  createWindow(`${u.pathname}${u.search}${u.hash}`.replace(/^\//, ""));
  return true;
});

function createWindow(loadPath) {
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

  // The sidecar URL serves both the HTML/JS bundle and the API. Each
  // BrowserWindow is an independent renderer (its own client, collab WS,
  // and history), so windows opened at different paths view different
  // pages side-by-side. The shared sidecar is process-wide (lifecycle.js).
  win.loadURL(`http://${HOST}:${PORT}/${loadPath || ""}`);

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

// Custom application menu. Mostly role-based so standard behavior (copy /
// paste / undo, window cycling, the macOS app menu) stays intact. Two
// deliberate departures from the default Electron menu:
//   - File > New Window (Cmd/Ctrl+N) opens a fresh window at the root, and
//     Close Window (Cmd/Ctrl+W) via role: "close".
//   - The View menu OMITS zoomIn / zoomOut / resetZoom. Those default roles
//     bind Cmd/Ctrl +/-/0 at the window level and scale the WHOLE app, which
//     preempts the renderer's per-reader zoom. Dropping them lets the
//     renderer handle Cmd/Ctrl +/-/0 itself.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const fileMenu = {
    label: "File",
    submenu: [
      {
        label: "New Window",
        accelerator: "CmdOrCtrl+N",
        id: "new-window",
        click: () => createWindow(),
      },
      { role: "close" }, // Close Window, CmdOrCtrl+W
    ],
  };
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    fileMenu,
    { role: "editMenu" }, // copy / paste / undo - REQUIRED or those keys break
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // No zoomIn / zoomOut / resetZoom: see comment above.
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

// Guards bootstrap against overlapping runs. second-instance can fire while
// the first launch's bootstrap is still probing/spawning; without this two
// concurrent bootstraps could both see "free" and double-spawn the sidecar.
let bootstrapping = false;

async function bootstrap() {
  if (bootstrapping) return;
  bootstrapping = true;
  try {
    await bootstrapInner();
  } finally {
    bootstrapping = false;
  }
}

async function bootstrapInner() {
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

  // Sidecar is healthy: a second-instance / activate may now open a window
  // directly instead of re-bootstrapping.
  ready = true;

  // First launch on Windows/Linux carries any "open this file" path in argv.
  // Consume it once (process.argv is immutable across re-bootstraps).
  if (!firstLaunchConsumed) {
    firstLaunchConsumed = true;
    const launchPath = fileArgFrom(process.argv);
    if (launchPath) pendingOpenPaths.push(launchPath);
  }

  if (pendingOpenPaths.length === 0) {
    createWindow();
    return;
  }
  // Open each queued file in its own window (one file per window) and forward
  // the path once the window has loaded.
  const paths = pendingOpenPaths;
  pendingOpenPaths = [];
  for (const osPath of paths) {
    sendOpenPath(createWindow(), osPath);
  }
}

app.whenReady().then(() => {
  // The application menu is global (not per-window), so set it once. Cmd+N
  // -> New Window and the zoom-role omission both live here.
  Menu.setApplicationMenu(buildAppMenu());
  return bootstrap();
});

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
