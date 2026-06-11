// Persistence + helpers for the remote-vault registry. Stored in
// localStorage so the same browser-side client (Electron BrowserWindow
// or regular browser) keeps the list across sessions. A remote server
// is accepted only when GET /.health returns {app:"coconote"}.


export type RemoteVault = {
  /** Stable client-side id; used as map key. */
  id: string;
  /** User-facing label (the URL hostname by default). */
  label: string;
  /** Base URL with scheme + host + optional port, no trailing slash. */
  url: string;
  /** Optional bearer token (server-side `auth`). */
  token?: string;
};

const STORAGE_KEY = "coconote.remoteVaults";

export function listRemoteVaults(): RemoteVault[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveRemoteVaults(list: RemoteVault[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function upsertRemoteVault(v: RemoteVault): void {
  const list = listRemoteVaults();
  const i = list.findIndex((x) => x.id === v.id);
  if (i >= 0) list[i] = v;
  else list.push(v);
  saveRemoteVaults(list);
}

export function removeRemoteVault(id: string): void {
  saveRemoteVaults(listRemoteVaults().filter((v) => v.id !== id));
}

export type ProbeResult =
  | { ok: true; rootPath?: Record<string, string>; version?: string }
  | { ok: false; error: string };

/** GET <url>/.health and verify the body has app==="coconote". */
export async function probeRemoteVault(
  url: string,
  token?: string,
): Promise<ProbeResult> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/.health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    if (body && body.app === "coconote") {
      return { ok: true, rootPath: body.rootPath, version: body.version };
    }
    return { ok: false, error: "not a coconote server" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

