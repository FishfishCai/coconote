// Setting -> Config file helpers (setting.md Config file). Same surface
// inside the Electron desktop shell (IPC + Electron-initiated relaunch)
// or a browser on a headless server (HTTP + server self-exec).
// /.config: GET returns `configDir` alongside the yaml content, PATCH
// `{configDir}` writes the pointer and triggers a self-restart. Electron
// mirrors the same actions via IPC because it owns the sidecar lifecycle.

import { getConfig, patchConfig } from "./config_api.ts";

type Shell = {
  isElectron?: boolean;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/** The Electron preload bridge, or null in a plain browser. */
export function electronShell(): Shell | null {
  const w = globalThis as typeof globalThis & { coconoteShell?: Shell };
  return w.coconoteShell?.isElectron ? w.coconoteShell : null;
}

export async function getConfigPath(): Promise<string> {
  const s = electronShell();
  if (s) {
    const v = await s.invoke("coconote_config_path");
    return typeof v === "string" ? v : "";
  }
  const cfg = await getConfig();
  return cfg.configDir ?? "";
}

/**
 * Apply a new config directory.
 * Electron: IPC writes the pointer and calls `app.relaunch()` - the
 * user next sees a fresh window.
 * Headless / browser: PATCH `/.config { configDir }` - the server writes
 * the pointer and re-execs itself. A connection-reset right after the
 * fetch is normal, not an error - callers treat both outcomes as success.
 */
export async function applyConfigPath(dir: string): Promise<void> {
  const s = electronShell();
  if (s) {
    await s.invoke("coconote_apply_config_path", { path: dir });
    return;
  }
  await patchConfig({ configDir: dir });
}
