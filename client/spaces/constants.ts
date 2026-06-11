import { encodePathSegments } from "../lib/path_url.ts";

export const fsEndpoint = "/.file";

/** Canonical URL for a vault-relative path on the `/.file` endpoint:
 *  `${fsEndpoint}/${encodePathSegments(path)}`. Single source of truth
 *  for the scattered inline `/.file/<enc(path)>` constructions. */
export function fileUrl(path: string): string {
  return `${fsEndpoint}/${encodePathSegments(path)}`;
}

/** Absolute `/.file` base for an HttpSpacePrimitives client and for
 *  opening raw asset URLs: the document base (trailing slashes trimmed)
 *  plus the fs endpoint. */
export function absFsBase(): string {
  return document.baseURI.replace(/\/*$/, "") + fsEndpoint;
}
