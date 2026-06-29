export const fsEndpoint = "/.file";

/** Canonical `/.file?id=` URL for a file id (SPEC server API: every
 *  endpoint is addressed by `?id=<id>`). Single source of truth for the
 *  scattered inline `/.file?id=` constructions. */
export function fileUrl(id: string): string {
  return `${fsEndpoint}?id=${encodeURIComponent(id)}`;
}

/** `/.file?id=<owner>&asset=<flat filename>` - read/write an image (or the
 *  pdf sidecar json) inside the owner's `.<name>.assets/` companion dir.
 *  The asset is a flat filename, never a path. */
export function assetUrl(ownerId: string, asset: string): string {
  return `${fileUrl(ownerId)}&asset=${encodeURIComponent(asset)}`;
}

/** Absolute `/.file` base - for HttpSpacePrimitives. */
export function absFsBase(): string {
  return document.baseURI.replace(/\/*$/, "") + fsEndpoint;
}

/** Canonical `/.history?id=` URL for a file id (server.md: history is
 *  addressed by `?id=`). `extra` appends extra query string (e.g.
 *  `&ts=`). Single source of truth shared by the merge-base lookup and the
 *  history panel. */
export function historyUrl(id: string, extra = ""): string {
  return `/.history?id=${encodeURIComponent(id)}${extra}`;
}
