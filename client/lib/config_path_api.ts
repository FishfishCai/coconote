// Setting → Config file helpers. Same surface whether we're inside the
// Electron desktop shell (IPC + Electron-initiated relaunch) or a
// browser pointed at a headless server (HTTP + server self-exec).
// setting.md §Config file.
//
// All the config endpoints live under /.config: GET returns `configDir`
// alongside the yaml content; PATCH `{configDir}` writes the pointer
// and triggers a self-restart. Electron mirrors the same actions via
// IPC because it owns the sidecar lifecycle.

import { getConfig, patchConfig } from "./config_api.ts";

type Shell = {
  isElectron?: boolean;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function shell(): Shell | null {
  const w = globalThis as typeof globalThis & { coconoteShell?: Shell };
  return w.coconoteShell?.isElectron ? w.coconoteShell : null;
}

export async function getConfigPath(): Promise<string> {
  const s = shell();
  if (s) {
    const v = await s.invoke("coconote_config_path");
    return typeof v === "string" ? v : "";
  }
  const cfg = await getConfig();
  return cfg.configDir ?? "";
}

/**
 * Apply a new config directory.
 *
 * Electron: IPC command writes the pointer and calls `app.relaunch()`
 * — the next thing the user sees is a fresh window.
 *
 * Headless / browser: PATCH `/.config { configDir }`; server writes the
 * pointer and re-execs itself. The fetch usually completes before the
 * server drops, but a connection-reset right after is normal and not
 * an error — callers should treat both outcomes as success.
 */
export async function applyConfigPath(dir: string): Promise<void> {
  const s = shell();
  if (s) {
    await s.invoke("coconote_apply_config_path", { path: dir });
    return;
  }
  await patchConfig({ configDir: dir });
}
