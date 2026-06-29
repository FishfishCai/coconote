/** The file kind that decides which viewer opens: markdown text editor or
 *  PDF reader. Images are never pages (embed-only). */
export type FileKind = "md" | "pdf";

export type FileMeta = {
  /** Owning file id, from the `X-Id` response header (minted + persisted by
   *  the server on first sight). Absent on non-addressable targets. */
  id?: string;
  /** The wire name of the file actually read - the owner path or, for an
   *  asset read, the flat asset filename. Used for content-type only. */
  name: string;
  created: number;
  lastModified: number;
  contentType: string;
  size: number;
  perm: "ro" | "rw";
  /** Lowercase hex BLAKE3 of file content, the sync-flow fingerprint.
   * Present on read/write responses, absent on HEAD (no bytes there). */
  contentHash?: string;
};

export type PageMeta = {
  /** The file's id - the sole identity for addressing, links, graph nodes,
   *  and the recent list (16-char [a-z0-9]). */
  id: string;
  /** The on-disk path hint, when known (recent / pin entries and loopback
   *  reads carry it). Absent for files reached only by id over refs /
   *  backrefs, where the server hides the path. Used as a recent-list
   *  display label and to derive the assets-dir for PDFs. */
  path?: string;
  /** md (text editor) or pdf (reader). Derived from the path extension or
   *  the response content-type. */
  kind: FileKind;
  created: string;
  lastModified: string;
  perm: "ro" | "rw";
  lastOpened?: number;
  tags?: string[];
  title?: string;
  /** Frontmatter `refs:` - ids this file references. Carried on the index
   *  so the ego-graph / autocomplete can wire edges without re-reading
   *  every body. */
  refs?: string[];
  /** Frontmatter `backrefs:` - ids that reference this file. */
  backrefs?: string[];
  /** Lowercase hex BLAKE3 of the file's content. Set when known (after a
   *  recent read/write), absent on closure-only entries. */
  contentHash?: string;
};
