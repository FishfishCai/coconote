// Pull a remote page into a chosen local root (history.md Pull).
// Mirror of sync_push: same id model (frontmatter id for md, sidecar
// metadata.id for PDFs), same synced content (md body / sidecar JSON),
// same merge strategy via lib/sync_core.ts. Assets folders are mirrored
// remote -> local for markdown pages.

import { fileUrl, fsEndpoint } from "../spaces/constants.ts";
import { authedFetch } from "./authed_fetch.ts";
import { getRemoteSpaceByLabel, parseRemotePath } from "./remote_index.ts";
import type { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";
import { extractFrontmatter } from "../markdown/frontmatter.ts";
import { fetchLocalMergeBase } from "./sync_history.ts";
import { headersToFileMeta } from "./util.ts";
import {
  mdAssetsPrefix,
  nameToFsPath,
  pdfSidecarPath,
  stripFirstSegment,
} from "./path_url.ts";
import { merge3Strategy, type SyncListings } from "./sync_core.ts";

export type PullOutcome =
  | { kind: "noop" }
  | { kind: "clean"; localPath: string }
  | { kind: "autoMerged"; localPath: string }
  | {
    kind: "conflict";
    baseText: string;
    localText: string;
    remoteText: string;
    localPath: string;
    remoteLabel: string;
    remotePath: string;
    /** Writes the merged result local-first, mirrors it to the remote,
     *  and records the pull rows (history.md MergeView submit). */
    commitMerged: (merged: Uint8Array) => Promise<void>;
  }
  | {
    /** Something already occupies the proposed local path (history.md
     *  Pull "same relative path holds a same-named file" - confirm
     *  per file before overwriting). */
    kind: "pathCollision";
    localPath: string;
    confirmOverwrite: () => Promise<PullOutcome>;
  }
  | { kind: "remoteMissing" }
  | { kind: "idMissing" };

/** True when ANY file occupies `path` locally (admitted or not). */
async function localPathOccupied(path: string): Promise<boolean> {
  const r = await authedFetch(fileUrl(path), { method: "HEAD" });
  return r.ok;
}

/** First local file (any root) whose page id matches - history.md keys
 *  the branch on "a local file exists with the same page_id". */
async function findLocalById(
  id: string,
  listings?: SyncListings,
): Promise<string | null> {
  let list = listings?.local;
  if (!list) {
    const r = await authedFetch(fsEndpoint);
    if (!r.ok) return null;
    list = (await r.json()) as Array<
      { type: string; path: string; page_id?: string }
    >;
    if (listings) listings.local = list;
  }
  const hit = list.find((e) => e.type === "file" && e.page_id === id);
  return hit?.path ?? null;
}

async function writeLocalPullRow(
  localContentPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const r = await authedFetch(
    `${fileUrl(localContentPath)}?save_type=pull`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    },
  );
  if (!r.ok) throw new Error(`local pull row failed: HTTP ${r.status}`);
}

async function writeLocalFile(path: string, bytes: Uint8Array): Promise<void> {
  const r = await authedFetch(fileUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  if (!r.ok) throw new Error(`local write failed: HTTP ${r.status}`);
}

/** Copy every file under the remote md page's assets folder to the
 *  matching local folder, BEFORE the local md write so the local pull
 *  row snapshots the fresh assets (history.md: page file set = md body
 *  + assets images). Local-only extras are left in place. */
async function pullAssets(
  sp: HttpSpacePrimitives,
  remoteMdPath: string,
  localMdPath: string,
): Promise<void> {
  // Assets live in a dot-dir, which the plain listing prunes - only
  // the ?prefix= endpoint can see them.
  const remotePrefix = mdAssetsPrefix(remoteMdPath);
  const localPrefix = mdAssetsPrefix(localMdPath);
  let paths: string[];
  try {
    paths = await sp.listUnderPrefix(remotePrefix);
  } catch {
    return;
  }
  for (const p of paths) {
    const { data } = await sp.readFile(p);
    await writeLocalFile(localPrefix + p.slice(remotePrefix.length), data);
  }
}

export async function pullRemoteToLocal(
  remotePrefixedPath: string,
  targetRootName: string,
  /** Set by folder batches to share one local listing per batch. */
  listings?: SyncListings,
): Promise<PullOutcome> {
  const split = parseRemotePath(remotePrefixedPath);
  if (!split) return { kind: "remoteMissing" };
  const r = getRemoteSpaceByLabel(split.label);
  if (!r) return { kind: "remoteMissing" };

  // The remote index strips `.md` from markdown names, PDFs keep their
  // extension. Restore the on-disk path before reading.
  const remoteFsPath = nameToFsPath(split.rest);
  const isPdf = remoteFsPath.toLowerCase().endsWith(".pdf");
  const remoteContentPath = isPdf ? pdfSidecarPath(remoteFsPath) : remoteFsPath;

  const { data: remoteBytes, meta: remoteMeta } = await r.sp.readFile(
    remoteContentPath,
  );
  const remoteText = new TextDecoder().decode(remoteBytes);
  const id = isPdf
    ? (JSON.parse(remoteText)?.metadata?.id as string | undefined)
    : extractFrontmatter(remoteText).id;
  if (!id) return { kind: "idMissing" };

  // Direct download (history.md Pull): no local file with this id.
  const localPath = await findLocalById(id, listings);
  if (!localPath) {
    const fallback = `${targetRootName}/${stripFirstSegment(remoteFsPath)}`;
    const fallbackContent = isPdf ? pdfSidecarPath(fallback) : fallback;
    const doDownload = async (): Promise<PullOutcome> => {
      if (isPdf) {
        // First transfer: the binary travels once, then stays frozen.
        const { data: pdfBytes } = await r.sp.readFile(remoteFsPath);
        await writeLocalFile(fallback, pdfBytes);
      } else {
        await pullAssets(r.sp, remoteFsPath, fallback);
      }
      await writeLocalPullRow(fallbackContent, remoteBytes);
      return { kind: "clean", localPath: fallback };
    };
    // history.md Pull: same relative path already holds a file ->
    // confirm overwrite (any occupant counts, id-less included).
    if (await localPathOccupied(fallback)) {
      return {
        kind: "pathCollision",
        localPath: fallback,
        confirmOverwrite: doDownload,
      };
    }
    return doDownload();
  }

  const localContentPath = isPdf ? pdfSidecarPath(localPath) : localPath;
  const localResp = await authedFetch(fileUrl(localContentPath));
  if (!localResp.ok) {
    throw new Error(`local read failed: HTTP ${localResp.status}`);
  }
  const localBytes = new Uint8Array(await localResp.arrayBuffer());
  const localHash =
    headersToFileMeta(localContentPath, localResp.headers)?.contentHash ?? "";
  const localText = new TextDecoder().decode(localBytes);
  const remoteHash = remoteMeta.contentHash ?? "";
  const base = await fetchLocalMergeBase(id);
  const baseText = base?.content ?? "";

  // For pull, the "target" we're writing INTO is local, the source is the remote.
  const decision = merge3Strategy(
    remoteText,
    remoteHash,
    localText,
    localHash,
    baseText,
  );

  if (decision.kind === "noop") {
    // Identical bytes - still append the pull row so the merge base
    // advances (history.md: "appends one save_type = pull row").
    await writeLocalPullRow(localContentPath, localBytes);
    return { kind: "noop" };
  }

  if (decision.kind === "clean") {
    if (!isPdf) await pullAssets(r.sp, remoteFsPath, localPath);
    await writeLocalPullRow(localContentPath, remoteBytes);
    return { kind: "clean", localPath };
  }

  if (decision.kind === "autoMerged") {
    // Pull-triggered merge writes local + mirrors remote (history.md).
    if (!isPdf) await pullAssets(r.sp, remoteFsPath, localPath);
    await writeLocalPullRow(localContentPath, decision.mergedBytes);
    await r.sp.writeFile(
      remoteContentPath,
      decision.mergedBytes,
      undefined,
      "pull",
    );
    return { kind: "autoMerged", localPath };
  }

  return {
    kind: "conflict",
    baseText: decision.baseText,
    localText: decision.targetText,
    remoteText: decision.sourceText,
    localPath,
    remoteLabel: r.vault.label,
    remotePath: remoteFsPath,
    commitMerged: async (merged: Uint8Array) => {
      if (!isPdf) await pullAssets(r.sp, remoteFsPath, localPath);
      await writeLocalPullRow(localContentPath, merged);
      await r.sp.writeFile(remoteContentPath, merged, undefined, "pull");
    },
  };
}
