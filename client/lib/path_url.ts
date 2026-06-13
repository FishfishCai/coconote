// Encode a vault-relative path into a URL path that keeps the `/`
// segment separators visible to the server router but escapes every
// other special char inside each segment. `encodeURI` leaves
// `# ? & +` alone (which truncate or rewrite the URL on the way out)
// and `encodeURIComponent` flattens the slashes - neither is right
// on its own.
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `"main/notes/foo.md"` -> `"notes/foo.md"`. Used wherever a vault-
 *  rooted local path needs to land under a different root prefix
 *  (sync push/pull). */
export function stripFirstSegment(p: string): string {
  const i = p.indexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** `"notes/foo.md"` -> `"foo.md"`. Returns the path unchanged when
 *  there is no `/`. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Index page name -> on-disk path. md page names drop the extension
 *  in the index while pdf names keep it, so only a literal .md / .pdf
 *  suffix counts as already-present: a dotted name like "notes.v2" is
 *  still a markdown page whose file appends ".md". */
export function nameToFsPath(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".pdf")
    ? name
    : `${name}.md`;
}

/** True when `name` is the folder itself or sits anywhere under it.
 *  The `+ "/"` guard keeps `notes/a` from matching the folder `note`.
 *  Shared by every folder-subtree filter (rename/remove/delete, push,
 *  Download, Export). */
export function isUnderFolder(name: string, folderPath: string): boolean {
  return name === folderPath || name.startsWith(`${folderPath}/`);
}

/** `"papers/foo.pdf"` -> `"foo"`. */
export function pdfStem(pdfPath: string): string {
  return basename(pdfPath).replace(/\.pdf$/i, "");
}

/** `"papers/foo.pdf"` -> `"papers/.foo.json"` (file.md PDF sidecar). */
export function pdfSidecarPath(pdfPath: string): string {
  const i = pdfPath.lastIndexOf("/");
  const dir = i < 0 ? "" : pdfPath.slice(0, i + 1);
  return `${dir}.${pdfStem(pdfPath)}.json`;
}

/** `"notes/foo.md"` -> `"notes/.foo.assets/"` (file.md Markdown assets).
 *  Trailing slash so it can be used directly as a listing prefix. */
export function mdAssetsPrefix(mdPath: string): string {
  const i = mdPath.lastIndexOf("/");
  const dir = i < 0 ? "" : mdPath.slice(0, i + 1);
  const stem = mdPath.slice(i + 1).replace(/\.md$/i, "");
  return `${dir}.${stem}.assets/`;
}

