// Cache + helpers to enumerate remote vaults' pages and merge them into
// the unified Content browser. Each PageMeta gets a stable `@<label>/`
// path prefix so the navigator can route it back to the remote.

import { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";
import { fsEndpoint } from "../spaces/constants.ts";
import type { PageMeta, PageOrigin } from "coconote/type/page";
import {
  listRemoteVaults,
  type RemoteVault,
} from "./remote_vaults.ts";

/** Per-vault-id cached HttpSpacePrimitives so we re-use one fetch context
 *  (auth token, redirect handling) across calls. Dropped on vault remove. */
const remoteSpaces = new Map<string, { vault: RemoteVault; sp: HttpSpacePrimitives }>();

function ensureSpace(v: RemoteVault): HttpSpacePrimitives {
  const cached = remoteSpaces.get(v.id);
  if (cached && cached.vault.url === v.url && cached.vault.token === v.token) {
    return cached.sp;
  }
  const sp = new HttpSpacePrimitives(
    v.url.replace(/\/+$/, "") + fsEndpoint,
    () => {},
    v.token,
  );
  remoteSpaces.set(v.id, { vault: v, sp });
  return sp;
}

type VaultWithSpace = { vault: RemoteVault; sp: HttpSpacePrimitives };

function findVault(
  pred: (v: RemoteVault) => boolean,
): VaultWithSpace | undefined {
  const v = listRemoteVaults().find(pred);
  if (!v) return undefined;
  return { vault: v, sp: ensureSpace(v) };
}

export function getRemoteSpaceByLabel(
  label: string,
): VaultWithSpace | undefined {
  return findVault((v) => v.label === label);
}

export function getRemoteSpaceById(id: string): VaultWithSpace | undefined {
  return findVault((v) => v.id === id);
}

/** Construct a transient remote-space for a one-off push to a typed URL
 *  (history.md §Push: the "free-input box" half of the target picker).
 *  Bypasses the localStorage registry — the URL is NOT added to
 *  setting.md's Remote list unless the user explicitly adds it there. */
export function makeRemoteSpace(opts: {
  url: string;
  label: string;
  token?: string;
}): { vault: RemoteVault; sp: HttpSpacePrimitives } {
  const v: RemoteVault = {
    id: `transient:${opts.url}`,
    label: opts.label,
    url: opts.url.replace(/\/+$/, ""),
    token: opts.token,
  };
  return { vault: v, sp: ensureSpace(v) };
}

export function pruneStaleRemoteSpaces(): void {
  const live = new Set(listRemoteVaults().map((v) => v.id));
  for (const id of [...remoteSpaces.keys()]) {
    if (!live.has(id)) remoteSpaces.delete(id);
  }
}

/** Path prefix for a remote-hosted file in the unified index. */
export function remotePrefix(label: string): string {
  return `@${label}/`;
}

/** Strip the @<label>/ prefix and return the inner remote path + the
 * matched vault label. Returns null if the input isn't a remote path. */
export function parseRemotePath(p: string): { label: string; rest: string } | null {
  if (!p.startsWith("@")) return null;
  const slash = p.indexOf("/");
  if (slash < 0) return null;
  return { label: p.slice(1, slash), rest: p.slice(slash + 1) };
}

/** Fetch one remote vault's pages (`.md` and `.pdf`), prefix names with
 * `@<label>/`, and tag each with origin metadata. The listing only
 * carries admitted pages, so no coconote filtering is needed here.
 * Returns [] on any failure (logged). */
export async function fetchRemotePages(v: RemoteVault): Promise<PageMeta[]> {
  const sp = ensureSpace(v);
  let files: Awaited<ReturnType<HttpSpacePrimitives["fetchFileList"]>>;
  try {
    files = await sp.fetchFileList();
  } catch (e) {
    console.warn(`[remote-index] ${v.label}: list failed`, e);
    return [];
  }
  const origin: PageOrigin = {
    kind: "remote",
    vaultId: v.id,
    label: v.label,
    url: v.url,
  };
  const out: PageMeta[] = [];
  for (const f of files) {
    if (f.name.startsWith("_")) continue;
    const isMd = f.name.endsWith(".md");
    if (!isMd && !f.name.endsWith(".pdf")) continue;
    // Page-name convention: md drops the extension, pdf keeps it
    // (mirrors the local index in core/space.ts).
    const baseName = isMd ? f.name.slice(0, -3) : f.name;
    const prefixedName = `${remotePrefix(v.label)}${baseName}`;
    out.push({
      ref: prefixedName,
      tag: "page",
      name: prefixedName,
      created: new Date(f.created).toISOString(),
      lastModified: new Date(f.lastModified).toISOString(),
      perm: "ro", // unconditional in the unified index — opens read-only
      tags: f.tags,
      title: f.title,
      origin,
      contentHash: f.contentHash,
    });
  }
  return out;
}

/** Fetch every configured remote's pages, concurrently. */
export async function fetchAllRemotePages(): Promise<PageMeta[]> {
  pruneStaleRemoteSpaces();
  const vaults = listRemoteVaults();
  if (vaults.length === 0) return [];
  const results = await Promise.all(vaults.map(fetchRemotePages));
  return results.flat();
}
