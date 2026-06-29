import type { FileMeta } from "coconote/type/page";
import {
  isNetworkError,
  notFoundError,
  offlineError,
  pingTimeout,
} from "coconote/constants";
import { headersToFileMeta } from "../file/index.ts";

const defaultFetchTimeout = 30000;

export interface StaleWriteError extends Error {
  stale: true;
  serverMeta: FileMeta;
}
export function isStaleWriteError(e: unknown): e is StaleWriteError {
  return (
    typeof e === "object" &&
    e !== null &&
    "stale" in e &&
    (e as { stale?: unknown }).stale === true
  );
}

/** save_type query for PUT /.file (server records the history row). */
export type SaveType = "edit" | "push" | "pull";

/** A /.file address: by canonical id, or by loopback OS path. An optional
 *  `asset` selects a flat companion file inside the owner's `.assets/`. */
export type FileAddr =
  | { id: string; asset?: string }
  | { path: string; asset?: string };

function addrQuery(addr: FileAddr): string {
  const parts: string[] = [];
  if ("id" in addr) parts.push(`id=${encodeURIComponent(addr.id)}`);
  else parts.push(`path=${encodeURIComponent(addr.path)}`);
  if (addr.asset) parts.push(`asset=${encodeURIComponent(addr.asset)}`);
  return parts.join("&");
}

function addrLabel(addr: FileAddr): string {
  return "id" in addr ? addr.id : addr.path;
}

export class HttpSpacePrimitives {
  /** Optional Bearer token - injected into every request when set. */
  authToken?: string;

  constructor(
    readonly url: string,
    private authErrorCallback: (message: string, ...args: unknown[]) => void,
    authToken?: string,
  ) {
    this.authToken = authToken;
  }

  private async fetch(
    url: string,
    options: RequestInit,
    timeout: number = defaultFetchTimeout,
  ): Promise<Response> {
    // Clone so reusing the same options object across calls doesn't
    // inherit a stale signal (already aborted) or a duplicate header.
    const opts: RequestInit = { ...options, redirect: "manual" };
    if (timeout > 0) opts.signal = AbortSignal.timeout(timeout);
    if (this.authToken) {
      const h = new Headers(opts.headers ?? {});
      // Respect a caller-supplied Authorization (e.g. one-off per-
      // request token) - only inject when the slot is empty.
      if (!h.has("Authorization")) {
        h.set("Authorization", `Bearer ${this.authToken}`);
      }
      opts.headers = h;
    }
    try {
      const result = await fetch(url, opts);
      // 5xx is a server fault, not connectivity - keep it distinct from
      // offlineError so the UI doesn't report "Offline" for a crash.
      if (result.status >= 500 && result.status < 600) {
        throw new Error(`server error: HTTP ${result.status}`);
      }
      const redirect = result.headers.get("location");
      // opaqueredirect strips Location entirely (web spec), so we can
      // never follow it programmatically - always treat as auth
      // failure and reload.
      if (result.type === "opaqueredirect") {
        this.authErrorCallback("Not authenticated, reloading", "reload");
        throw Error("Not authenticated");
      }
      if ((result.status === 401 || result.status === 403) && redirect) {
        this.authErrorCallback("Auth redirect", redirect);
        throw Error("Not authenticated");
      }
      if (result.status === 401 || result.status === 403) {
        this.authErrorCallback("Not authenticated, reloading");
        throw Error("Not authenticated");
      }
      return result;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      if (isNetworkError(e)) throw offlineError;
      throw e;
    }
  }

  /** GET /.file?id= (or ?path= loopback, or &asset=). Returns the bytes
   *  plus FileMeta (meta.id is the owning id from X-Id). */
  async readFile(
    addr: FileAddr,
  ): Promise<{ data: Uint8Array; meta: FileMeta }> {
    const res = await this.fetch(
      `${this.url}?${addrQuery(addr)}`,
      { method: "GET", headers: { Accept: "application/octet-stream" } },
    );
    if (res.status === 404) throw notFoundError;
    // 405 (read-only) / 400 (bad id / remote path) must not be returned as
    // if the error body were file content.
    if (!res.ok) throw new Error(`read ${addrLabel(addr)}: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      meta: headersToFileMeta(addrLabel(addr), res.headers)!,
    };
  }

  /** PUT /.file?id= (or ?path= loopback, or &asset=). `saveType` /
   *  `peer` tag the history row; `ifUnmodifiedSince` drives optimistic
   *  concurrency (409 on stale). */
  async writeFile(
    addr: FileAddr,
    data: Uint8Array,
    opts: {
      ifUnmodifiedSince?: number;
      saveType?: SaveType;
      peer?: string;
    } = {},
  ): Promise<FileMeta> {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (opts.ifUnmodifiedSince) {
      headers["X-If-Unmodified-Since"] = String(opts.ifUnmodifiedSince);
    }
    let url = `${this.url}?${addrQuery(addr)}`;
    if (opts.saveType && opts.saveType !== "edit") {
      url += `&save_type=${opts.saveType}`;
    }
    if (opts.peer) url += `&peer=${encodeURIComponent(opts.peer)}`;
    const res = await this.fetch(
      url,
      { method: "PUT", headers, body: data as BodyInit },
      0, // no timeout - upload can be large
    );
    if (res.status === 409) {
      const err = new Error("stale write") as StaleWriteError;
      err.stale = true;
      err.serverMeta = headersToFileMeta(addrLabel(addr), res.headers)!;
      throw err;
    }
    // 405 read-only etc. - surface instead of returning undefined metadata
    // that explodes later in the save loop.
    if (!res.ok) throw new Error(`write ${addrLabel(addr)}: HTTP ${res.status}`);
    return headersToFileMeta(addrLabel(addr), res.headers)!;
  }

  /// HEAD /.file?id= returns the same headers as GET without a body or
  /// content hash. Use it whenever only metadata is needed (mtime check,
  /// perm display, learning a path's id).
  async getFileMeta(addr: FileAddr): Promise<FileMeta> {
    const res = await this.fetch(
      `${this.url}?${addrQuery(addr)}`,
      { method: "HEAD" },
    );
    if (res.status === 404) throw notFoundError;
    if (!res.ok) throw Error(`Failed to get file meta: ${res.statusText}`);
    return headersToFileMeta(addrLabel(addr), res.headers)!;
  }

  /** Loopback-only GET /.resolve?path= - OS path -> id (mints one if the
   *  file has none). */
  async resolvePath(path: string): Promise<string> {
    const res = await this.fetch(
      new URL("../.resolve", this.url + "/").toString() +
        `?path=${encodeURIComponent(path)}`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`resolve path: HTTP ${res.status}`);
    const j = await res.json();
    if (typeof j?.id !== "string") throw new Error("resolve path: no id");
    return j.id;
  }

  /// Liveness probe - spec server.md only exposes `/.health` (no /.ping).
  async ping(): Promise<string | undefined> {
    // Walk one path segment up from this.url so a trailing slash
    // doesn't strip a different segment than expected.
    const healthUrl = new URL("../.health", this.url + "/").toString();
    const resp = await this.fetch(
      healthUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      pingTimeout,
    );
    if (!resp.ok) throw Error(`Ping failed: ${resp.status} ${resp.statusText}`);
    try {
      const j = await resp.json();
      return typeof j?.version === "string" ? j.version : undefined;
    } catch {
      return undefined;
    }
  }
}
