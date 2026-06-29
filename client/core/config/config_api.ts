// Thin wrappers for the GET /.config and PATCH /.config endpoints. The
// recent list and settings UI reach for these so they live one level up
// instead of being duplicated per file.
//
// Wire shape (server handlers/config): id-addressed. `url` is a list of
// (url, auth) pairs, `recent` / `pin` are lists of (id, path) pairs.

import { authedFetch } from "../transport/authed_fetch.ts";

/** A remote instance the local server can push to / pull from. */
export type ConfigUrl = { url: string; auth: string };

/** A recent / pinned file: `id` is the identity, `path` is the on-disk
 *  hint used to relocate it. */
export type ConfigEntry = { id: string; path: string };

/** Shape of GET /.config (server emits camelCase). */
export type CoconoteConfig = {
  port?: number;
  /** Whether this instance requires an auth token (the token itself is
   *  never returned). */
  hasAuth?: boolean;
  /** Push / pull target instances (SPEC config `url`). */
  url?: ConfigUrl[];
  /** Recently opened files, MRU order (SPEC config `recent`). */
  recent?: ConfigEntry[];
  /** Pinned files (SPEC config `pin`). */
  pin?: ConfigEntry[];
  /** Recent-list cap N (SPEC config `recent_limit`). */
  recentLimit?: number;
  /** Watch roots (SPEC config `watch`). */
  watch?: string[];
  /** The standard user config dir holding coconote.yaml. */
  configDir?: string;
};

/** PATCH /.config body: any subset of these single-entry mutations. The
 *  server returns the updated GET body. `addRecent` is MRU move-to-front
 *  by id and truncates to recentLimit; removes are BY ID. `addWatch` /
 *  `removeWatch` take an absolute existing dir (server answers 400
 *  otherwise). */
export type ConfigPatch =
  | { addUrl: ConfigUrl }
  | { removeUrl: string }
  | { addRecent: ConfigEntry }
  | { removeRecent: string }
  | { addPin: ConfigEntry }
  | { removePin: string }
  | { addWatch: string }
  | { removeWatch: string };

export async function getConfig(): Promise<CoconoteConfig> {
  const res = await authedFetch("/.config");
  if (!res.ok) throw new Error(`GET /.config -> ${res.status}`);
  return res.json();
}

export async function patchConfig(body: ConfigPatch): Promise<CoconoteConfig> {
  const res = await authedFetch("/.config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `PATCH /.config -> ${res.status}`);
  }
  return res.json();
}

/** Add a `watch` directory root to the server config. The server validates
 *  an absolute existing dir and rejects with 400 otherwise (the thrown
 *  Error carries the server's reason text). Returns the updated config. */
export function addWatch(dir: string): Promise<CoconoteConfig> {
  return patchConfig({ addWatch: dir });
}

/** Remove a `watch` directory root from the server config. Returns the
 *  updated config. */
export function removeWatch(dir: string): Promise<CoconoteConfig> {
  return patchConfig({ removeWatch: dir });
}

/** Add (or re-token) a remote instance in the `url` list - a push / pull
 *  peer (design.md config `url`). The server validates an http(s) URL and
 *  rejects otherwise. Returns the updated config. */
export function addUrl(url: string, auth: string): Promise<CoconoteConfig> {
  return patchConfig({ addUrl: { url, auth } });
}

/** Remove a remote instance from the `url` list (by url). Returns the
 *  updated config. */
export function removeUrl(url: string): Promise<CoconoteConfig> {
  return patchConfig({ removeUrl: url });
}
