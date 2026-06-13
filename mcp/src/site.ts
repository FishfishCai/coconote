// export_site internals: the Node-side twin of client/lib/site_export.ts.
// The whole site assembly is client/lib/site_core.ts buildSiteFiles
// (DOM-free by design), bundled in. Only the SiteIo wiring over api.ts
// and the destination-directory write are here.

import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildSiteFiles, type SiteIo } from "../../client/lib/site_core.ts";
import { isUnderFolder } from "../../client/lib/path_url.ts";
import type { PageMeta } from "../../client/types/page.ts";
import * as api from "./api";
import { writeDest } from "./export";

/** Included md / pdf pages as the PageMeta array site_core resolves
 *  against (the app's allPages): like export.ts loadPageContext but
 *  with pdf rows and the graph edge fields the manifest needs. With
 *  `folder` set, only pages under that subtree are kept, exactly like the
 *  client's exportFolderSite (in-folder wikilinks stay relative, links
 *  pointing outside degrade to spans). */
async function listSitePages(folder?: string): Promise<PageMeta[]> {
  return (await api.listEntries())
    .filter((e) => e.type === "file" && /\.(md|pdf)$/i.test(e.path))
    .map((e): PageMeta => {
      const name = e.path.replace(/\.md$/i, "");
      return {
        ref: name,
        tag: "page",
        name,
        created: "",
        lastModified: "",
        perm: "rw",
        title: e.title,
        tags: e.tag,
        prereq: e.prereq,
        headings: e.headings,
        wikilinks: e.wikilinks,
      };
    })
    .filter((p) => !folder || isUnderFolder(p.name, folder));
}

/** The SiteIo of client/lib/site_export.ts rebuilt over the HTTP api:
 *  pages from the listing (scoped to `folder` when set), file bytes via
 *  /.file (null skips the page), viewer assets via the authed /.client
 *  fetch. */
function makeIo(folder?: string): SiteIo {
  return {
    listPages: () => listSitePages(folder),
    readFile: (path) =>
      api.readBytesOrNull(path).then((got) => got?.bytes ?? null).catch(() => null),
    fetchAsset: async (path) => {
      const r = await api.fetchPath(`/.client/${path}`);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

export type SiteResult = { dest: string; files: number; bytes: number; skipped: string[] };

/** Build the static site into the directory `dest` (created when missing,
 *  must be empty). With `folder` set the site covers only that subtree,
 *  like the app's folder Export. */
export async function exportSite(dest: string, folder?: string): Promise<SiteResult> {
  if (!isAbsolute(dest)) {
    throw new Error(
      `dest must be an absolute directory path on the machine running the MCP server, got: ${dest}`,
    );
  }
  const existing = await readdir(dest).catch(() => [] as string[]);
  if (existing.length > 0) {
    throw new Error(
      `${dest} is not empty (${existing.length} entries). export_site writes a complete ` +
        `fresh site: deploy pipelines clean the directory first, then re-call.`,
    );
  }
  const { files, skipped } = await buildSiteFiles(makeIo(folder));
  let bytes = 0;
  for (const [rel, data] of files) bytes += await writeDest(join(dest, rel), data);
  return { dest, files: files.size, bytes, skipped };
}
