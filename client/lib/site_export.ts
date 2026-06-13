// Client wrappers for the Export / Download actions on the whole vault
// (content.md header button) and on a single folder (content.md folder
// right-click menu). Export builds a read-only static site (site_core.ts),
// Download a faithful raw copy. All three assemble file maps and share the
// zip+save tail below.

import { type AsyncZippable, zip } from "fflate";
import type { ClientContext as Client } from "../core/context.ts";
import { authedFetch } from "./authed_fetch.ts";
import { readVaultFile, saveBlobAs } from "./export.ts";
import { buildSiteFiles, type SiteProgress } from "./site_core.ts";
import {
  isUnderFolder,
  mdAssetsPrefix,
  nameToFsPath,
  pdfSidecarPath,
} from "./path_url.ts";
import type { PageMeta } from "coconote/type/page";

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

/** Zip `files` and hand the archive to the browser as `name`. */
async function zipAndSave(
  name: string,
  files: Map<string, string | Uint8Array>,
): Promise<void> {
  const bytes = await zipFiles(files);
  await saveBlobAs(
    name,
    new Blob([bytes as BlobPart], { type: "application/zip" }),
  );
}

/** `"main/notes/papers"` -> `"papers"`, `"main"` -> `"main"`. */
function lastSegment(folderPath: string): string {
  return folderPath.split("/").pop() ?? folderPath;
}

/** Build the static-site file map for the pages `listPages` yields and
 *  download it as `name`. Shared by exportSite (whole vault) and
 *  exportFolderSite (one subtree). Returns the skipped vault paths. */
async function buildAndSaveSite(
  client: Client,
  name: string,
  listPages: () => readonly PageMeta[],
  onProgress?: SiteProgress,
): Promise<{ skipped: string[] }> {
  const { files, skipped } = await buildSiteFiles(
    {
      listPages,
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
  await zipAndSave(name, files);
  return { skipped };
}

/** Build and download the whole vault as a static site. Returns the
 *  vault paths of pages that had to be skipped (unfetchable bytes). */
export function exportSite(
  client: Client,
  onProgress?: SiteProgress,
): Promise<{ skipped: string[] }> {
  return buildAndSaveSite(
    client,
    "coconote-site.zip",
    () => client.ui.viewState.allPages,
    onProgress,
  );
}

/** Build and download the `folderPath` subtree as a static site. Scoping
 *  listPages to the subtree makes buildSiteFiles resolve wikilinks among
 *  those pages only: in-folder links stay relative, links pointing
 *  outside degrade to spans. Full vault paths are kept inside the zip. */
export function exportFolderSite(
  client: Client,
  folderPath: string,
  onProgress?: SiteProgress,
): Promise<{ skipped: string[] }> {
  const allPages = client.ui.viewState.allPages;
  return buildAndSaveSite(
    client,
    `${lastSegment(folderPath)}-site.zip`,
    () => allPages.filter((p) => isUnderFolder(p.name, folderPath)),
    onProgress,
  );
}

/** On-disk paths of every local (non-remote) page under `folderPath`.
 *  Drives the folder's raw Download here and the recursive
 *  rename/remove/delete ops in folder_context_menu.tsx. */
export function localFsPathsUnder(
  client: Client,
  folderPath: string,
): string[] {
  return client.ui.viewState.allPages
    .filter((p) =>
      p.origin?.kind !== "remote" && isUnderFolder(p.name, folderPath)
    )
    .map((p) => nameToFsPath(p.name));
}

/** Add `path`'s raw bytes to `files` when readable, ignoring failures so
 *  one unreadable file never aborts the whole download. */
async function addRaw(
  client: Client,
  files: Map<string, Uint8Array>,
  path: string,
): Promise<void> {
  const data = await readVaultFile(client, path);
  if (data) files.set(path, data);
}

/** A faithful raw copy of the folder's included local pages: the md
 *  source / original pdf bytes, plus each md page's assets folder and
 *  each pdf's sidecar. Saved as `${lastSegment}.zip` with full vault
 *  paths. Unreadable / missing files are skipped silently. */
export async function downloadFolder(
  client: Client,
  folderPath: string,
): Promise<void> {
  const fsPaths = localFsPathsUnder(client, folderPath);

  // Mirror the whole-vault export: fetch every page and its sidecars in
  // parallel rather than serializing the round-trips.
  const files = new Map<string, Uint8Array>();
  await Promise.all(fsPaths.map(async (fsPath) => {
    await addRaw(client, files, fsPath);
    const lower = fsPath.toLowerCase();
    if (lower.endsWith(".md")) {
      const prefix = mdAssetsPrefix(fsPath);
      const r = await authedFetch(`/.file?prefix=${encodeURIComponent(prefix)}`);
      if (r.ok) {
        const assetPaths = (await r.json()) as string[];
        await Promise.all(assetPaths.map((a) => addRaw(client, files, a)));
      }
    } else if (lower.endsWith(".pdf")) {
      await addRaw(client, files, pdfSidecarPath(fsPath));
    }
  }));

  await zipAndSave(`${lastSegment(folderPath)}.zip`, files);
}
