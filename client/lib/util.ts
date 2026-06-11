import type { FileMeta } from "coconote/type/page";

/** Escape every RegExp metacharacter in `s`. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/// Translate spec response headers (server.md) into FileMeta:
///   X-Permission     ro/rw
///   X-Last-Modified  ms epoch (integer string)
///   X-Content-Hash   lowercase hex blake3 (GET only — absent on HEAD)
/// Returns undefined when the response carries none of those headers.
export function headersToFileMeta(
  name: string,
  headers: Headers,
): FileMeta | undefined {
  if (!headers.has("X-Last-Modified")) return undefined;
  const sizeStr = headers.get("Content-Length");
  return {
    name,
    size: sizeStr ? +sizeStr : 0,
    contentType: headers.get("Content-Type") ?? "application/octet-stream",
    // Coconote doesn't track a separate creation time on the wire;
    // mirror mtime so callers reading either field still get a value.
    created: +(headers.get("X-Last-Modified") || "0"),
    lastModified: +(headers.get("X-Last-Modified") || "0"),
    perm: (headers.get("X-Permission") as "rw" | "ro") || "ro",
    contentHash: headers.get("X-Content-Hash") ?? undefined,
  };
}
