export type FileMeta = {
  name: string;
  created: number;
  lastModified: number;
  contentType: string;
  size: number;
  perm: "ro" | "rw";
  tags?: string[];
  title?: string;
  /** `prereq:` declarations from the page's frontmatter. Listed by the
   * server so the Graph view can build the prereq DAG without
   * re-reading every file. Empty/absent for non-md and md without
   * prereqs. */
  prereq?: string[];
  /** Heading texts (H1-H4) inside the file. Carried on listings so the
   * Content browser filter can match against "headings inside files"
   * (content.md filter scope) without re-reading every body. */
  headings?: string[];
  /** `[[wikilink]]` raw target strings inside the body (alias stripped).
   * Carried on listings so the Graph view can wire wikilink edges
   * server-side (content.md §Graph view). */
  wikilinks?: string[];
  /** Stable per-page identity from frontmatter `id:`. Server-injected
   * on first `coconote:true` save. Identifies the page across renames /
   * tag changes for cross-vault sync. Absent for non-md or md the
   * user hand-cleared the field on. */
  id?: string;
  /** Lowercase hex BLAKE3 of file content. Present on read/write
   * responses; absent on list / X-Get-Meta responses (which don't have
   * the bytes). Used as the fingerprint for sync flows. */
  contentHash?: string;
};

export type PageOrigin =
  | { kind: "local" }
  | { kind: "remote"; vaultId: string; label: string; url: string };

export type PageMeta = {
  ref: string;
  tag: "page";
  name: string;
  created: string;
  lastModified: string;
  perm: "ro" | "rw";
  lastOpened?: number;
  tags?: string[];
  title?: string;
  /** Where this page lives. Absent / kind:"local" = native local vault.
   * kind:"remote" = lives on a configured remote vault; the page's
   * `name` will already be prefixed with `@<label>/`. */
  origin?: PageOrigin;
  /** `prereq:` declarations from the page's frontmatter; carried on
   * the listing so the Graph view can build the DAG without
   * re-reading every file. */
  prereq?: string[];
  /** Heading texts (H1-H4) inside the page. Carried on listings so the
   * Content browser filter (content.md) can match against them
   * without an extra round-trip per body. */
  headings?: string[];
  /** `[[wikilink]]` raw target strings inside the page body (display
   * alias stripped, external URLs excluded). Carried on listings so
   * the Graph view can build edges from wikilinks alongside `prereq:`
   * without re-reading every body — content.md §Graph view says edges
   * come from BOTH sources. */
  wikilinks?: string[];
  /** Server-injected stable identity (frontmatter `id:`). See the
   * matching field on FileMeta. */
  id?: string;
  /** Lowercase hex BLAKE3 of the file's content. Set when known
   * (after a recent read/write); absent on listing-only entries. */
  contentHash?: string;
};
