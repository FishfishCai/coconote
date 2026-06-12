// Client wrapper for the Export Site action (content.md header button):
// assemble the SiteIo from the live client context, build the file map
// in lib/site_core.ts, zip it with fflate, and hand the archive to the
// browser as coconote-site.zip.

import { type AsyncZippable, zip } from "fflate";
import type { ClientContext as Client } from "../core/context.ts";
import { authedFetch } from "./authed_fetch.ts";
import { downloadBlob, readVaultFile } from "./export.ts";
import { buildSiteFiles, type SiteProgress } from "./site_core.ts";

// Already-compressed payloads gain nothing from another deflate pass.
const STORED_RE = /\.(pdf|woff2|png|jpe?g|gif|webp|avif)$/i;

function zipFiles(files: Map<string, string | Uint8Array>): Promise<Uint8Array> {
  const entries: AsyncZippable = {};
  const enc = new TextEncoder();
  for (const [path, data] of files) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    entries[path] = STORED_RE.test(path) ? [bytes, { level: 0 }] : bytes;
  }
  return new Promise((resolve, reject) =>
    zip(entries, (err, out) => (err ? reject(err) : resolve(out)))
  );
}

/** Build and download the whole vault as a static site. Returns the
 *  vault paths of pages that had to be skipped (unfetchable bytes). */
export async function exportSite(
  client: Client,
  onProgress?: SiteProgress,
): Promise<{ skipped: string[] }> {
  const { files, skipped } = await buildSiteFiles(
    {
      listPages: () => client.ui.viewState.allPages,
      readFile: (path) => readVaultFile(client, path),
      fetchAsset: async (path) => {
        const r = await authedFetch(`/.client/${path}`);
        if (!r.ok) return null;
        return new Uint8Array(await r.arrayBuffer());
      },
      shortWikiLinks: client.config.get("shortWikiLinks", true),
    },
    onProgress,
  );
  const bytes = await zipFiles(files);
  downloadBlob(
    "coconote-site.zip",
    new Blob([bytes as BlobPart], { type: "application/zip" }),
  );
  return { skipped };
}
