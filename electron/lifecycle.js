// Sidecar lifecycle + config-pointer helpers: probe :40704, spawn/locate
// the bundled coconote binary (packaged app or dev tree), and read/write
// the `<standard config dir>/config-path` pointer that redirects the yaml
// lookup (welcome.md). Pointer format is stable across shell versions.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = 40704;
export const HOST = "127.0.0.1";
export const HEALTH_URL = `http://${HOST}:${PORT}/.health`;
const HEALTH_TIMEOUT_MS = 500;
const HEALTH_WAIT_MS = 5000;
const HEALTH_POLL_MS = 150;

let owned = null;
// Child most recently handed to shutdownOwned(), kept so waitForExit()
// can observe its actual exit after `owned` has been cleared.
let lastShutdown = null;

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Returns "coconote" if :40704 answers /.health with `app === "coconote"`,
 * "free" if the connection was refused, "foreign" otherwise.
 */
export async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(HEALTH_URL, { signal: controller.signal });
    if (resp.status !== 200) return "foreign";
    const body = await resp.json().catch(() => null);
    return body && body.app === "coconote" ? "coconote" : "foreign";
  } catch (e) {
    // Node's fetch maps connection-refused to TypeError with cause.code
    // ECONNREFUSED. Anything else (timeout, parse, etc.) is "foreign": we
    // don't want to clobber a port held by something we can't identify.
    const code = e?.cause?.code;
    if (code === "ECONNREFUSED") return "free";
    return "foreign";
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHealth() {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await probe()) === "coconote") return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sidecar binary
// ---------------------------------------------------------------------------

/**
 * Locate the bundled `coconote` binary. `COCONOTE_SERVER_PATH` wins,
 * then a packaged Resources/binaries location (electron-builder maps
 * `extraResources` to `process.resourcesPath`), then dev paths
 * relative to this file.
 */
export function resolveServerBinary() {
  if (process.env.COCONOTE_SERVER_PATH) return process.env.COCONOTE_SERVER_PATH;

  const isWindows = process.platform === "win32";
  const candidates = [];
  // Packaged: builder.config.json `extraResources` copies
  // electron/binaries to Resources/binaries.
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "binaries"));
  }
  // Dev fallback: repo's server-rs cargo output.
  candidates.push(resolve(__dirname, "..", "server-rs", "target", "release"));
  candidates.push(resolve(__dirname, "..", "server-rs", "target", "debug"));

  const exeNames = isWindows ? ["coconote.exe", "coconote"] : ["coconote"];
  for (const dir of candidates) {
    for (const name of exeNames) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function spawnSidecar(bin) {
  shutdownOwned();
  // detached:false keeps the sidecar in our process group: a hard shell
  // crash tears it down too. Clean exits go through shutdownOwned (SIGTERM).
  const child = spawn(bin, ["-p", String(PORT)], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  owned = child;
  child.on("exit", () => {
    if (owned === child) owned = null;
  });
  // spawn reports ENOENT/EACCES asynchronously via 'error' (no throw), so
  // without this listener a bad binary path would only surface as the
  // generic 5s health-wait timeout.
  child.on("error", (err) => {
    console.error("coconote: sidecar spawn failed:", err);
    if (owned === child) owned = null;
  });
  return child;
}

/** SIGTERM the sidecar we own (if any), then SIGKILL after 2 seconds. */
export function shutdownOwned() {
  const child = owned;
  if (!child) return;
  owned = null;
  lastShutdown = child;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  // Best-effort SIGKILL fallback. We don't await: quit must be fast.
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2000);
}

/**
 * Resolve once the child most recently handed to shutdownOwned() has
 * actually exited, bounded by `timeoutMs` (> the 2s SIGKILL fallback, so
 * a stuck child is force-killed before we give up). Relaunching callers
 * must await this: app.exit() right after SIGTERM lets the relaunched
 * shell probe the still-draining old server and adopt the old config.
 * Resolves immediately if nothing was owned or the child already exited.
 */
export function waitForExit(timeoutMs = 3000) {
  const child = lastShutdown;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Config-path pointer (setting.md "Config file")
//
// `<standard config dir>/config-path` overrides the yaml lookup. Same
// file as server-rs/src/config.rs::{read,write}_config_pointer.
// ---------------------------------------------------------------------------

function standardConfigDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA ? join(process.env.APPDATA, "coconote") : null;
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "coconote");
  }
  return process.env.HOME ? join(process.env.HOME, ".config", "coconote") : null;
}

function configPointerPath() {
  const dir = standardConfigDir();
  return dir ? join(dir, "config-path") : null;
}

/**
 * Effective config dir: pointer file content trimmed, or the standard
 * dir when no pointer is set. Pre-fills the Setting input.
 */
export function readEffectiveConfigDir() {
  const ptr = configPointerPath();
  if (ptr && existsSync(ptr)) {
    try {
      const raw = readFileSync(ptr, "utf8").trim();
      if (raw) return raw;
    } catch {
      /* unreadable: fall through to default */
    }
  }
  return standardConfigDir();
}

/**
 * Write the pointer file. Clearing (empty input, or a value matching the
 * standard dir) removes the pointer so on-disk state stays minimal.
 */
export function writeConfigPointer(dir) {
  const ptr = configPointerPath();
  if (!ptr) throw new Error("no $HOME / %APPDATA% to host config pointer");
  mkdirSync(dirname(ptr), { recursive: true });
  const std = standardConfigDir();
  const clear = !dir || (std && dir === std);
  if (clear) {
    if (existsSync(ptr)) rmSync(ptr, { force: true });
  } else {
    writeFileSync(ptr, dir, "utf8");
  }
}
