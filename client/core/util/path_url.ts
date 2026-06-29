// Encode a vault-relative path into a URL path that keeps the `/`
// segment separators visible to the server router but escapes every
// other special char inside each segment. `encodeURI` leaves
// `# ? & +` alone (which truncate or rewrite the URL on the way out)
// and `encodeURIComponent` flattens the slashes - neither is right
// on its own.
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// A path is a plain on-disk path string. It is no longer the file
// identity (that is the id) - paths survive only as recent/pin display
// hints, for the pdf assets-dir derivation, and for loopback OS opens.
export type Path = string;

/** Lowercased final extension of a path (`a/b.PDF` -> `pdf`). An empty
 *  path is treated as markdown. A pure FILE/PATH concern shared by the
 *  markdown render path and the links/file layers. */
export function getPathExtension(path: string): string {
  return path !== "" ? path.split(".").pop()!.toLowerCase() : "md";
}

export function isMarkdownPath(path: string): boolean {
  return getPathExtension(path) === "md";
}

/** `"notes/foo.md"` -> `"foo.md"`. Returns the path unchanged when
 *  there is no `/`. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Known on-disk extensions whose basename loses the extension to form
 *  the assets-folder stem (file.md: `notes/foo.md` -> `.foo.assets/`,
 *  `papers/foo.pdf` -> `.foo.assets/`). */
const KNOWN_EXT_RE = /\.(md|pdf)$/i;

/** `"papers/foo.pdf"` -> `"foo"`. */
export function pdfStem(pdfPath: string): string {
  return basename(pdfPath).replace(/\.pdf$/i, "");
}

/** Per-file assets folder prefix (file.md): `"notes/foo.md"` ->
 *  `"notes/.foo.assets/"`, `"papers/foo.pdf"` -> `"papers/.foo.assets/"`.
 *  Strips a known extension to the stem, mirroring the server's single
 *  `util::assets_prefix_for` so the assets-dir naming stays a byte-for-
 *  byte client/server contract. Trailing slash so it can be appended to
 *  directly. */
export function assetsPrefix(path: string): string {
  const i = path.lastIndexOf("/");
  const dir = i < 0 ? "" : path.slice(0, i + 1);
  const stem = path.slice(i + 1).replace(KNOWN_EXT_RE, "");
  return `${dir}.${stem}.assets/`;
}

/** `"papers/foo.pdf"` -> `"papers/.foo.assets/foo.json"` - the PDF's
 *  annotations json, which lives inside its `.<name>.assets/` folder
 *  (file.md: companions are a folder, not a sibling json). */
export function pdfSidecarPath(pdfPath: string): string {
  return `${assetsPrefix(pdfPath)}${pdfStem(pdfPath)}.json`;
}
