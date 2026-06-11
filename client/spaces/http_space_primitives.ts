import { encodePageURI } from "coconote/lib/ref";
import type { FileMeta } from "coconote/type/page";
import {
  isNetworkError,
  notFoundError,
  offlineError,
  pingTimeout,
} from "coconote/constants";
import { headersToFileMeta } from "../lib/util.ts";

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

export class HttpSpacePrimitives {
  /** Optional Bearer token; injected into every request when set. */
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
      // request token) — only inject when the slot is empty.
      if (!h.has("Authorization")) {
        h.set("Authorization", `Bearer ${this.authToken}`);
      }
      opts.headers = h;
    }
    try {
      const result = await fetch(url, opts);
      // 5xx is a server fault, not connectivity — keep it distinct from
      // offlineError so the UI doesn't report "Offline" for a crash.
      if (result.status >= 500 && result.status < 600) {
        throw new Error(`server error: HTTP ${result.status}`);
      }
      const redirect = result.headers.get("location");
      // opaqueredirect strips Location entirely (web spec), so we can
      // never follow it programmatically — always treat as auth
      // failure and reload.
      if (result.type === "opaqueredirect") {
        this.authErrorCallback("Not authenticated, reloading", "reload");
        throw Error("Not authenticated");
      }
      if (
        (result.status >= 300 && result.status < 400 && redirect) ||
        ((result.status === 401 || result.status === 403) && redirect)
      ) {
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

  async fetchFileList(): Promise<FileMeta[]> {
    const resp = await this.fetch(this.url, { method: "GET" });
    const raw: Array<{
      type?: "file" | "dir";
      path: string;
      page_id?: string;
      title?: string;
      tag?: string[];
      prereq?: string[];
      headings?: string[];
      wikilinks?: string[];
      size?: number;
      mtime?: number;
      perm?: "ro" | "rw";
    }> = await resp.json();
    return raw
      .filter((e) => e.type !== "dir") // Drop dir rows so callers iterating file metadata don't have to skip them.
      .map((e) => ({
        name: e.path,
        size: e.size ?? 0,
        contentType: "",
        created: e.mtime ?? 0,
        lastModified: e.mtime ?? 0,
        perm: e.perm ?? "ro",
        tags: e.tag,
        title: e.title,
        prereq: e.prereq,
        headings: e.headings,
        wikilinks: e.wikilinks,
        id: e.page_id,
      }));
  }

  async readFile(path: string): Promise<{ data: Uint8Array; meta: FileMeta }> {
    const res = await this.fetch(
      `${this.url}/${encodePageURI(path)}`,
      { method: "GET", headers: { Accept: "application/octet-stream" } },
    );
    if (res.status === 404) throw notFoundError;
    // 405 (read-only vault) / 400 (path not in space) must not be
    // returned as if the error body were file content.
    if (!res.ok) throw new Error(`read ${path}: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      meta: headersToFileMeta(path, res.headers)!,
    };
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    ifUnmodifiedSince?: number,
    /** Tags the resulting history row. Sync flows pass "push" / "pull";
     * normal saves omit (or pass "edit"). spec server.md uses
     * `?save_type=` query, not a custom header. */
    saveType?: "edit" | "push" | "pull",
  ): Promise<FileMeta> {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (ifUnmodifiedSince) {
      headers["X-If-Unmodified-Since"] = String(ifUnmodifiedSince);
    }
    let url = `${this.url}/${encodePageURI(path)}`;
    if (saveType && saveType !== "edit") {
      url += `?save_type=${saveType}`;
    }
    const res = await this.fetch(
      url,
      { method: "PUT", headers, body: data as BodyInit },
      0, // no timeout — upload can be large
    );
    if (res.status === 409) {
      const err = new Error("stale write") as StaleWriteError;
      err.stale = true;
      err.serverMeta = headersToFileMeta(path, res.headers)!;
      throw err;
    }
    // 405 read-only vault etc. — surface instead of returning undefined
    // metadata that explodes later in the save loop.
    if (!res.ok) throw new Error(`write ${path}: HTTP ${res.status}`);
    return headersToFileMeta(path, res.headers)!;
  }

  /// spec server.md: HEAD /.file/<path> returns the same headers as GET
  /// without a body or content hash. Use it whenever only metadata is
  /// needed (mtime check, perm display).
  async getFileMeta(path: string): Promise<FileMeta> {
    const res = await this.fetch(
      `${this.url}/${encodePageURI(path)}`,
      { method: "HEAD" },
    );
    if (res.status === 404) throw notFoundError;
    if (!res.ok) throw Error(`Failed to get file meta: ${res.statusText}`);
    return headersToFileMeta(path, res.headers)!;
  }

  /// Liveness probe — spec server.md only exposes `/.health` (no /.ping).
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
