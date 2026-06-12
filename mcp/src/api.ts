// Thin HTTP layer over the Coconote server API (introduction/server.md)
// plus the vault path conventions ported from client/lib/path_url.ts.
// The Vault class binds one server (url + token): the module-level
// functions delegate to the env-configured local vault, push/pull build
// a second Vault for the remote side.

import { baseUrl, token } from "./config";

// --- path conventions (client/lib/path_url.ts) ---

/** Keep `/` separators visible to the router, escape everything else. */
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** `"main/notes/foo.md"` -> `"notes/foo.md"` (re-rooting for sync). */
export function stripFirstSegment(p: string): string {
  const i = p.indexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Page name -> on-disk path: append .md unless the name already ends
 *  in a literal .md / .pdf. */
export function nameToFsPath(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".pdf") ? name : `${name}.md`;
}

/** `"papers/foo.pdf"` -> `"foo"`. */
export function pdfStem(pdfPath: string): string {
  return basename(pdfPath).replace(/\.pdf$/i, "");
}

/** `"papers/foo.pdf"` -> `"papers/.foo.json"`. */
export function pdfSidecarPath(pdfPath: string): string {
  const i = pdfPath.lastIndexOf("/");
  const dir = i < 0 ? "" : pdfPath.slice(0, i + 1);
  return `${dir}.${pdfStem(pdfPath)}.json`;
}

/** `"notes/foo.md"` -> `"notes/.foo.assets/"` (trailing slash, usable
 *  directly as a listing prefix). */
export function mdAssetsPrefix(mdPath: string): string {
  const i = mdPath.lastIndexOf("/");
  const dir = i < 0 ? "" : mdPath.slice(0, i + 1);
  const stem = mdPath.slice(i + 1).replace(/\.md$/i, "");
  return `${dir}.${stem}.assets/`;
}

// --- wire types (server-rs/src/types.rs, empty fields omitted by serde) ---

export type Entry = {
  type: "file" | "dir";
  path: string;
  page_id?: string;
  title?: string;
  tag?: string[];
  prereq?: string[];
  headings?: string[];
  wikilinks?: string[];
  size: number;
  mtime: number;
  /** Serialized only as false, on the excluded rows of an all listing. */
  coconote?: boolean;
};

export type HistoryRow = { ts: number; save_type: string };

export type FileRead = { text: string; mtime: number };

/** Binary-safe read, with the metadata headers sync needs. */
export type BytesRead = {
  bytes: Uint8Array;
  text: string;
  mtime: number;
  contentHash: string;
  contentType: string;
};

export type WriteOpts = {
  contentType?: string;
  ifUnmodifiedSince?: number;
  /** Tags the history row (server.md PUT ?save_type=). Sync flows pass
   *  push / pull, plain saves omit it. */
  saveType?: "push" | "pull";
};

// --- 404 suggestions (refinement: a missing path lists lookalikes) ---

function editDistance(a: string, b: string): number {
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

/** Up to 3 listing paths whose basename resembles `path`'s basename. */
function similarPaths(path: string, entries: Entry[]): string[] {
  const want = basename(path).toLowerCase();
  return entries
    .filter((e) => e.type === "file")
    .map((e) => {
      const have = basename(e.path).toLowerCase();
      const score = 1 - editDistance(want, have) / Math.max(want.length, have.length);
      return { path: e.path, score };
    })
    .filter((c) => c.score >= 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((c) => c.path);
}

// --- the per-server client ---

export class Vault {
  /**
   * `base` / `tok` are thunks so the local vault keeps its lazy
   * env-config semantics (importing the bundle never throws).
   * `label` names the server in error messages.
   */
  constructor(
    private readonly base: () => string,
    private readonly tok: () => string,
    private readonly label = "Coconote server",
  ) {}

  url(): string {
    return this.base().replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const t = this.tok();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  private fileUrl(path: string): string {
    return `${this.url()}/.file/${encodePathSegments(path)}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...this.headers(), ...(init.headers as Record<string, string> | undefined) };
    try {
      return await fetch(url, { ...init, headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `cannot reach ${this.label} at ${this.url()} (${msg}). ` +
          `Check that the Coconote app or server is running and the URL is correct.`,
      );
    }
  }

  private async fail(what: string, res: Response, path?: string): Promise<never> {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    let hint = "";
    if (res.status === 403) {
      hint = " (auth failed: provide the auth token from the server's coconote.yaml," +
        " via COCONOTE_TOKEN or the tool's token argument)";
    }
    if (res.status === 409) hint = " (the file changed concurrently: re-read and retry)";
    if (res.status === 404 && path) hint = await this.suggestSuffix(path);
    throw new Error(`${what}: HTTP ${res.status}${body ? ` ${body}` : ""}${hint}`);
  }

  /** ` Similar known paths: a, b, c` or empty. Never throws. */
  private async suggestSuffix(path: string): Promise<string> {
    const similar = await this.listEntries()
      .then((entries) => similarPaths(path, entries))
      .catch(() => [] as string[]);
    return similar.length > 0 ? ` Similar known paths: ${similar.join(", ")}` : "";
  }

  /** Authed GET of a server-absolute path (e.g. /.client/main.css). */
  async fetchPath(path: string): Promise<Response> {
    return await this.request(`${this.url()}${path}`);
  }

  /** `GET /.health` as a liveness/identity probe. */
  async health(): Promise<void> {
    const res = await this.request(`${this.url()}/.health`);
    if (!res.ok) await this.fail(`health probe of ${this.label}`, res);
    const j = (await res.json().catch(() => null)) as { app?: string } | null;
    if (!j || typeof j !== "object") {
      throw new Error(`${this.url()} answered /.health but not like a Coconote server.`);
    }
  }

  /** Vault listing. `all` adds the supported files not in the Coconote
   *  index (the app's All view), their rows carrying coconote: false. */
  async listEntries(all = false): Promise<Entry[]> {
    const res = await this.request(`${this.url()}/.file${all ? "?all=1" : ""}`);
    if (!res.ok) await this.fail("list vault", res);
    return (await res.json()) as Entry[];
  }

  /** Flat path array under a prefix, dot-dirs included. */
  async listUnderPrefix(prefix: string): Promise<string[]> {
    const res = await this.request(`${this.url()}/.file?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) await this.fail(`list prefix ${prefix}`, res);
    return (await res.json()) as string[];
  }

  async readFile(path: string): Promise<FileRead> {
    const { text, mtime } = await this.readBytes(path);
    return { text, mtime };
  }

  /** Null only on 404, every other failure throws. */
  async readFileOrNull(path: string): Promise<FileRead | null> {
    const got = await this.readBytesOrNull(path);
    return got && { text: got.text, mtime: got.mtime };
  }

  async readBytes(path: string): Promise<BytesRead> {
    const got = await this.readBytesOrNull(path);
    if (got === null) {
      throw new Error(`${path} not found (HTTP 404).${await this.suggestSuffix(path)}`);
    }
    return got;
  }

  async readBytesOrNull(path: string): Promise<BytesRead | null> {
    const res = await this.request(this.fileUrl(path));
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(`read ${path}`, res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      mtime: parseInt(res.headers.get("x-last-modified") ?? "0", 10) || 0,
      contentHash: res.headers.get("x-content-hash") ?? "",
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** HEAD probe: does ANY file occupy `path`? */
  async exists(path: string): Promise<boolean> {
    const res = await this.request(this.fileUrl(path), { method: "HEAD" });
    return res.ok;
  }

  async writeFile(path: string, body: string | Uint8Array, opts: WriteOpts = {}): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": opts.contentType ?? "application/octet-stream",
    };
    if (opts.ifUnmodifiedSince !== undefined) {
      headers["X-If-Unmodified-Since"] = String(opts.ifUnmodifiedSince);
    }
    const url = this.fileUrl(path) + (opts.saveType ? `?save_type=${opts.saveType}` : "");
    const res = await this.request(url, { method: "PUT", headers, body: body as RequestInit["body"] });
    if (!res.ok) await this.fail(`write ${path}`, res);
  }

  async deleteFile(path: string): Promise<void> {
    const res = await this.request(this.fileUrl(path), { method: "DELETE" });
    if (!res.ok) await this.fail(`delete ${path}`, res, path);
  }

  /** PUT ?type=dir creates an empty directory. */
  async mkdir(path: string): Promise<void> {
    const res = await this.request(`${this.fileUrl(path)}?type=dir`, { method: "PUT" });
    if (!res.ok) await this.fail(`create folder ${path}`, res);
  }

  // --- history endpoints (keyed by page id, not path) ---

  private historyUrl(pageId: string): string {
    return `${this.url()}/.history/${encodeURIComponent(pageId)}`;
  }

  async historyList(pageId: string): Promise<HistoryRow[]> {
    const res = await this.request(this.historyUrl(pageId));
    if (!res.ok) await this.fail(`history of page ${pageId}`, res);
    return (await res.json()) as HistoryRow[];
  }

  async historySnapshot(pageId: string, ts: number): Promise<string> {
    const res = await this.request(`${this.historyUrl(pageId)}?ts=${ts}`);
    if (!res.ok) await this.fail(`history snapshot ${pageId}@${ts}`, res);
    return await res.text();
  }

  async historyRestore(pageId: string, ts: number): Promise<void> {
    const res = await this.request(`${this.historyUrl(pageId)}/restore?ts=${ts}`, { method: "POST" });
    if (!res.ok) await this.fail(`restore ${pageId}@${ts}`, res);
  }

  async historyPin(pageId: string): Promise<void> {
    const res = await this.request(`${this.historyUrl(pageId)}/pin`, { method: "POST" });
    if (!res.ok) await this.fail(`pin ${pageId}`, res);
  }

  async historyDeleteVersion(pageId: string, ts: number): Promise<void> {
    const res = await this.request(`${this.historyUrl(pageId)}?ts=${ts}`, { method: "DELETE" });
    if (!res.ok) await this.fail(`delete version ${pageId}@${ts}`, res);
  }
}

/** A Vault for an explicit url + token (push/pull remote side). */
export function remoteVault(url: string, token: string | undefined, label: string): Vault {
  return new Vault(() => url, () => token ?? "", label);
}

// --- the env-configured local vault, kept as module-level functions ---

export const localVault = new Vault(baseUrl, token);
const local = localVault; // short alias for the delegate lines below

export const listEntries = (all?: boolean) => local.listEntries(all);
export const listUnderPrefix = (prefix: string) => local.listUnderPrefix(prefix);
export const readFile = (path: string) => local.readFile(path);
export const readFileOrNull = (path: string) => local.readFileOrNull(path);
export const readBytes = (path: string) => local.readBytes(path);
export const readBytesOrNull = (path: string) => local.readBytesOrNull(path);
export const exists = (path: string) => local.exists(path);
export const fetchPath = (path: string) => local.fetchPath(path);
export const writeFile = (path: string, body: string | Uint8Array, opts: WriteOpts = {}) =>
  local.writeFile(path, body, opts);
export const deleteFile = (path: string) => local.deleteFile(path);
export const mkdir = (path: string) => local.mkdir(path);
export const historyList = (pageId: string) => local.historyList(pageId);
export const historySnapshot = (pageId: string, ts: number) => local.historySnapshot(pageId, ts);
export const historyRestore = (pageId: string, ts: number) => local.historyRestore(pageId, ts);
export const historyPin = (pageId: string) => local.historyPin(pageId);
export const historyDeleteVersion = (pageId: string, ts: number) =>
  local.historyDeleteVersion(pageId, ts);
