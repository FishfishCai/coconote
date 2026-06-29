// Sidecar lifecycle: probe :40704, spawn/locate the bundled coconote
// binary (packaged app or dev tree), wait for health, and shut down the
// child we own.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
