// Exported-site manifest contract (content.md Export site): the
// generator writes assets/manifest.js defining window.COCONOTE_SITE,
// the viewer bundle (viewer.ts) reads it back here. Everything is
// relative-path so the site works from file:// and from any
// subdirectory: page hrefs are derived from the vault path by
// extension swap and never fetched at runtime.

export type SitePage = {
  /** Vault logical path, e.g. `notes/algebra.md` or `papers/p.pdf`. */
  path: string;
  kind: "md" | "pdf";
  title: string;
  tags: string[];
  headings: string[];
  /** Resolved wikilink targets, as vault paths. */
  links: string[];
  /** Resolved `prereq:` targets, as vault paths. */
  prereqs: string[];
};

export type SiteManifest = { pages: SitePage[] };

export type SiteView = "path" | "tag" | "graph";

/** window.COCONOTE_SITE, typed without a global declaration so this
 *  module can't collide with the generator-side site_*.ts modules. */
export function readManifest(): SiteManifest | undefined {
  return (window as unknown as { COCONOTE_SITE?: SiteManifest })
    .COCONOTE_SITE;
}

/** Relative href for a page: md swaps the extension for `.html`, pdf
 *  keeps its path. Segments are URI-encoded individually so `/` stays
 *  a separator. */
export function pageHref(p: SitePage): string {
  const raw = p.kind === "md"
    ? p.path.replace(/\.md$/i, "") + ".html"
    : p.path;
  return raw.split("/").map(encodeURIComponent).join("/");
}

export function pageBasename(p: SitePage): string {
  return p.path.split("/").pop() ?? p.path;
}
