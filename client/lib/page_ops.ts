// Page-level file operations for the content-browser context menus
// (content.md §Right-click menu). The menus stay dispatch-only — every
// multi-step transaction (rename with rollback, physical delete with
// sidecar/assets cleanup, New Markdown admission) lives here.

import { authedFetch } from "./authed_fetch.ts";
import { mdAssetsPrefix } from "./path_url.ts";
import { fileUrl } from "../spaces/constants.ts";
import { refactorLinks } from "./refactor_links.ts";
import { setFrontmatterKey } from "./frontmatter_edit.ts";
import { stripFrontmatter } from "../markdown/frontmatter.ts";
import { loadSidecar, saveSidecar, sidecarPath } from "../pdf/notes_client.ts";

/** PUT a text body to `/.file/<path>`. Throws on a non-2xx response. */
export async function putFileBody(path: string, body: string): Promise<void> {
  const r = await authedFetch(fileUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!r.ok) throw new Error(`PUT ${r.status} ${await r.text()}`);
}

/** PUT `/.file/<path>?type=dir` — create a folder. */
export async function putDirectory(path: string): Promise<void> {
  const r = await authedFetch(`${fileUrl(path)}?type=dir`, {
    method: "PUT",
  });
  if (!r.ok) throw new Error(`PUT ${r.status} ${await r.text()}`);
}

/** content.md §Remove (markdown flavour): the file stays on disk but
 *  its frontmatter `coconote:` flips to false so it drops out of the
 *  index. Mirror of lib/include.ts `includeMarkdown`. */
export async function removeMarkdownFromIndex(path: string): Promise<void> {
  const r = await authedFetch(fileUrl(path));
  if (!r.ok) throw new Error(`read ${r.status}`);
  const next = setFrontmatterKey(await r.text(), "coconote", "false");
  await putFileBody(path, next);
}

/** content.md §Remove: flip a page out of the index, by file kind. The
 *  file stays on disk (md frontmatter / pdf sidecar `coconote: false`). */
export async function removeFromIndex(fullPath: string): Promise<void> {
  const lower = fullPath.toLowerCase();
  if (lower.endsWith(".md")) {
    await removeMarkdownFromIndex(fullPath);
  } else if (lower.endsWith(".pdf")) {
    const cur = await loadSidecar(fullPath);
    cur.metadata.coconote = false;
    await saveSidecar(fullPath, cur);
  }
}

/** Folder Rename: move every page under `oldFolder` to `newFolder`,
 *  reusing renamePage so each file's wikilinks, assets, and sidecar
 *  follow. `fullPaths` are the affected pages' on-disk paths. */
export async function renameFolder(
  oldFolder: string,
  newFolder: string,
  fullPaths: string[],
): Promise<void> {
  for (const fp of fullPaths) {
    await renamePage(fp, newFolder + fp.slice(oldFolder.length));
  }
}

/** Folder Remove: flip every page under the folder out of the index. */
export async function removeFolderFromIndex(fullPaths: string[]): Promise<void> {
  for (const fp of fullPaths) await removeFromIndex(fp);
}

/** Folder Delete: physically delete every page under the folder (with its
 *  assets / sidecar), then best-effort remove the now-empty directory. */
export async function deleteFolder(
  folderPath: string,
  fullPaths: string[],
): Promise<void> {
  for (const fp of fullPaths) await deletePage(fp);
  // The server only deletes empty dirs; ignore failure when subdirs remain.
  try {
    await authedFetch(fileUrl(folderPath), { method: "DELETE" });
  } catch { /* non-empty or already gone */ }
}

/** Rename / move a page: read old → probe target (refuse to clobber) →
 *  PUT new → DELETE old, rolling the copy back if the delete fails so
 *  two files never share the same `id:`. Then carries the PDF sidecar /
 *  markdown assets folder along and rewrites every [[wikilink]] that
 *  pointed at the old name (content.md §Rename — same rule for .md and
 *  .pdf). Throws when the core move fails; sidecar / assets / wikilink
 *  follow-ups only log. */
export async function renamePage(
  fullPath: string,
  newFullPath: string,
): Promise<void> {
  const lower = fullPath.toLowerCase();
  const isMd = lower.endsWith(".md");
  const isPdf = lower.endsWith(".pdf");

  const oldFsPath = fileUrl(fullPath);
  const newFsPath = fileUrl(newFullPath);

  const readRes = await authedFetch(oldFsPath);
  if (!readRes.ok) throw new Error(`read old ${readRes.status}`);
  const body = await readRes.arrayBuffer();

  const probeRes = await authedFetch(newFsPath, { method: "HEAD" });
  if (probeRes.ok) {
    throw new Error(`target ${newFullPath} already exists`);
  }
  const putRes = await authedFetch(newFsPath, {
    method: "PUT",
    headers: {
      "Content-Type": readRes.headers.get("Content-Type") ??
        "application/octet-stream",
    },
    body,
  });
  if (!putRes.ok) {
    throw new Error(`PUT new ${putRes.status} ${await putRes.text()}`);
  }
  const delRes = await authedFetch(oldFsPath, { method: "DELETE" });
  if (!delRes.ok) {
    // Roll back so we don't leave two copies sharing the same `id:`.
    await authedFetch(newFsPath, { method: "DELETE" }).catch(() => {});
    throw new Error(`delete old ${delRes.status}`);
  }

  // Move the PDF sidecar alongside, if any.
  if (isPdf) {
    const oldSc = fileUrl(sidecarPath(fullPath));
    const newSc = fileUrl(sidecarPath(newFullPath));
    const r = await authedFetch(oldSc);
    if (r.ok) {
      const data = await r.arrayBuffer();
      await authedFetch(newSc, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: data,
      }).catch(() => {});
      await authedFetch(oldSc, { method: "DELETE" }).catch(() => {});
    }
  }

  // Move the markdown assets folder, if any. file.md:
  // ".<name>.assets/ follows the markdown file on rename".
  if (isMd) {
    try {
      await moveAssetsFolder(fullPath, newFullPath);
    } catch (e) {
      console.error(`Assets folder move failed: ${e}`);
    }
  }

  // Rewrite every [[wikilink]] in the vault that pointed at the
  // old name (content.md §Rename — same rule for .md and .pdf).
  try {
    await refactorLinks(fullPath, newFullPath);
  } catch (e) {
    console.error(`Wikilink refactor failed: ${e}`);
  }
}

/** Physically delete a page plus its PDF sidecar / markdown assets
 *  folder (content.md §Delete). The caller owns the confirmation UI. */
export async function deletePage(fullPath: string): Promise<void> {
  const lower = fullPath.toLowerCase();
  const isMd = lower.endsWith(".md");
  const isPdf = lower.endsWith(".pdf");

  const r = await authedFetch(fileUrl(fullPath), {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`delete ${r.status}`);
  if (isPdf) {
    await authedFetch(fileUrl(sidecarPath(fullPath)), {
      method: "DELETE",
    }).catch(() => {});
  } else if (isMd) {
    // Clean up the .<name>.assets/ folder so it doesn't have to
    // wait for the server's boot-time orphan sweep (file.md §Delete).
    await deleteAssetsFolder(assetsDirFor(fullPath));
  }
}

export type CreateMarkdownResult = "created" | "admitted" | "already-included";

/** "New Markdown" (content.md §Right-click menu → Folder): create
 *  `<target>` with `coconote: true` frontmatter. A same-named file
 *  already on disk with `coconote: false` gets the key flipped instead
 *  of being overwritten; one that is ALREADY included is left untouched
 *  (no bogus edit row) — the caller surfaces "already exists". */
export async function createMarkdownPage(
  target: string,
): Promise<CreateMarkdownResult> {
  const existing = await authedFetch(fileUrl(target));
  if (!existing.ok) {
    await putFileBody(target, "---\ncoconote: true\n---\n");
    return "created";
  }
  const body = await existing.text();
  if (hasCoconoteTrue(body)) return "already-included";
  await putFileBody(target, setFrontmatterKey(body, "coconote", "true"));
  return "admitted";
}

/** True when the YAML frontmatter already says `coconote: true`.
 *  `extractFrontmatter` doesn't surface the admission key, so locate
 *  the block via stripFrontmatter and match the key line directly. */
function hasCoconoteTrue(body: string): boolean {
  const { offset } = stripFrontmatter(body);
  if (offset === 0) return false; // no frontmatter block at all
  const yaml = body.slice(0, offset);
  return /^coconote[ \t]*:[ \t]*true[ \t]*(#.*)?$/m.test(yaml);
}

/** `notes/foo.md` → `notes/.foo.assets`. Mirrors orphan.rs naming
 *  (file.md: `<name>` carries no extension). Same derivation as
 *  `mdAssetsPrefix`, minus its trailing slash. */
function assetsDirFor(mdPath: string): string {
  return mdAssetsPrefix(mdPath).replace(/\/$/, "");
}

async function moveAssetsFolder(
  oldMdPath: string,
  newMdPath: string,
): Promise<void> {
  const oldDir = assetsDirFor(oldMdPath);
  const newDir = assetsDirFor(newMdPath);
  // The regular /.file listing filters out dot-prefixed dirs, so the
  // assets folder is invisible there. Use the explicit prefix endpoint
  // which the server backs with list_under_prefix.
  const prefix = oldDir + "/";
  const listRes = await authedFetch(
    `/.file?prefix=${encodeURIComponent(prefix)}`,
  );
  if (!listRes.ok) return;
  const paths = (await listRes.json()) as string[];
  if (paths.length === 0) return;
  for (const oldPath of paths) {
    const r = await authedFetch(fileUrl(oldPath));
    if (!r.ok) continue;
    const bytes = await r.arrayBuffer();
    const ct = r.headers.get("Content-Type") ?? "application/octet-stream";
    const newPath = newDir + "/" + oldPath.slice(prefix.length);
    await authedFetch(fileUrl(newPath), {
      method: "PUT",
      headers: { "Content-Type": ct },
      body: bytes,
    }).catch(() => {});
    await authedFetch(fileUrl(oldPath), {
      method: "DELETE",
    }).catch(() => {});
  }
}

/** Delete every file under `dir` (the markdown's `.<name>.assets/`),
 *  then the directory itself (content.md §Right-click menu: Delete
 *  "physically deletes the file and its assets folder"). The server's
 *  DELETE accepts empty dirs; absent/non-empty failures are quietly
 *  ignored — the boot-time orphan sweep is the backstop. */
async function deleteAssetsFolder(dir: string): Promise<void> {
  const prefix = dir + "/";
  const listRes = await authedFetch(
    `/.file?prefix=${encodeURIComponent(prefix)}`,
  );
  if (!listRes.ok) return;
  const paths = (await listRes.json()) as string[];
  for (const p of paths) {
    await authedFetch(fileUrl(p), { method: "DELETE" }).catch(() => {});
  }
  await authedFetch(fileUrl(dir), { method: "DELETE" }).catch(
    () => {},
  );
}
