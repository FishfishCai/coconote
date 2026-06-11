import { encodePathSegments } from "../lib/path_url.ts";

export const fsEndpoint = "/.file";

/** Canonical `/.file` URL for a vault-relative path - single source of
 *  truth for the scattered inline `/.file/<enc(path)>` constructions. */
export function fileUrl(path: string): string {
  return `${fsEndpoint}/${encodePathSegments(path)}`;
}

/** Absolute `/.file` base - for HttpSpacePrimitives and raw asset URLs. */
export function absFsBase(): string {
  return document.baseURI.replace(/\/*$/, "") + fsEndpoint;
}
