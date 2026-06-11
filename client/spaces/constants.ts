import { encodePathSegments } from "../lib/path_url.ts";

export const fsEndpoint = "/.file";

/** Canonical URL for a vault-relative path on the `/.file` endpoint:
 *  `${fsEndpoint}/${encodePathSegments(path)}`. Single source of truth
 *  for the scattered inline `/.file/<enc(path)>` constructions. */
export function fileUrl(path: string): string {
  return `${fsEndpoint}/${encodePathSegments(path)}`;
}
