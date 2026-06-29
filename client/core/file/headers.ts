import type { FileMeta } from "coconote/type/page";

/// Translate spec response headers (server.md) into FileMeta:
///   X-Id             owning md/pdf id (minted + persisted by the server)
///   X-Permission     ro/rw
///   X-Last-Modified  ms epoch (integer string)
///   X-Content-Hash   lowercase hex blake3 (GET only - absent on HEAD)
/// Returns undefined when the response carries none of those headers.
export function headersToFileMeta(
  name: string,
  headers: Headers,
): FileMeta | undefined {
  if (!headers.has("X-Last-Modified")) return undefined;
  const sizeStr = headers.get("Content-Length");
  return {
    id: headers.get("X-Id") ?? undefined,
    name,
    size: sizeStr ? +sizeStr : 0,
    contentType: headers.get("Content-Type") ?? "application/octet-stream",
    // Coconote doesn't track a separate creation time on the wire -
    // mirror mtime so callers reading either field still get a value.
    created: +headers.get("X-Last-Modified")!,
    lastModified: +headers.get("X-Last-Modified")!,
    perm: (headers.get("X-Permission") as "rw" | "ro") || "ro",
    contentHash: headers.get("X-Content-Hash") ?? undefined,
  };
}
