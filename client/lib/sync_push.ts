// Push a local page to a chosen remote root (history.md §Push).
//
// Identity travels via the page id — frontmatter `id:` for markdown,
// sidecar `metadata.id` for PDFs (history.md). The synced CONTENT is the
// md body for markdown pages and the sidecar JSON for PDF pages (the PDF
// binary is frozen on import and only uploaded on first transfer);
// a markdown page's assets folder is mirrored alongside the body.
// Merge base = local latest push/pull row's content (history.md §Merge).
//
// Outcomes:
//   "noop"           — bytes already identical (still records a push row,
//                       per history.md "appends one save_type = push row")
//   "clean"          — remote unchanged since base; write goes through
//   "autoMerged"     — both sides moved, diff3 merged without conflict
//   "conflict"       — diff3 found a conflict; UI pops MergeView and
//                       commits via the carried `commitMerged` closure
//   "pathCollision"  — something already occupies the landing path; the
//                       caller must confirm before `confirmOverwrite`
//   "remoteMissing"  — target vault no longer configured / unreachable
//   "idMissing"      — page has no id yet (md: save it once; pdf: include
//                       it so the sidecar exists)

import { fileUrl, fsEndpoint } from "../spaces/constants.ts";
import { notFoundError } from "./constants.ts";
import { authedFetch } from "./authed_fetch.ts";
import { getRemoteSpaceById, makeRemoteSpace } from "./remote_index.ts";
import type { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";
import { headersToFileMeta } from "./util.ts";
import { extractFrontmatter } from "../markdown/frontmatter.ts";
import { fetchLocalMergeBase } from "./sync_history.ts";
import {
  mdAssetsPrefix,
  pdfSidecarPath,
  stripFirstSegment,
} from "./path_url.ts";
import { merge3Strategy } from "./sync_core.ts";

export type PushOutcome =
  | { kind: "noop" }
  | { kind: "clean"; remotePath: string }
  | { kind: "autoMerged"; remotePath: string }
  | {
    kind: "conflict";
    baseText: string;
    localText: string;
    remoteText: string;
    remotePath: string;
    remoteLabel: string;
    /** Writes the merged result remote-first, mirrors it locally, and
     *  records the push rows (history.md §MergeView submit). */
    commitMerged: (merged: Uint8Array) => Promise<void>;
  }
  | {
    /** Something already occupies the proposed remote path (history.md
     *  §Push "same relative path holds a same-named file" — confirm
     *  per file before overwriting). */
    kind: "pathCollision";
    remotePath: string;
    remoteLabel: string;
    /** Continuation that performs the upload once the user confirms. */
    confirmOverwrite: () => Promise<PushOutcome>;
  }
  | { kind: "remoteMissing" }
  | { kind: "idMissing" };

/** Push target — either a saved vault id (history.md §Push "url list
 *  already saved under setting's Remote") or a typed URL + token
 *  (the "free-input box" half). */
export type PushTarget =
  | { kind: "saved"; vaultId: string }
  | { kind: "url"; url: string; label?: string; token?: string };

async function readLocal(
  path: string,
): Promise<{ bytes: Uint8Array; hash: string } | null> {
  const resp = await authedFetch(fileUrl(path));
  if (!resp.ok) return null;
  return {
    bytes: new Uint8Array(await resp.arrayBuffer()),
    hash: headersToFileMeta(path, resp.headers)?.contentHash ?? "",
  };
}

// Mirror the synced bytes back to the local content path with
// save_type=push so the local history records the sync point — this is
// what fast-forward checks against on the next sync (history.md).
async function recordLocalPushRow(
  localContentPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const r = await authedFetch(
    `${fileUrl(localContentPath)}?save_type=push`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    },
  );
  if (!r.ok) throw new Error(`local push row failed: HTTP ${r.status}`);
}

/** True when ANY file occupies `path` on the remote (admitted or not —
 *  the listing only carries admitted pages, so probe the path itself). */
async function remotePathOccupied(
  sp: HttpSpacePrimitives,
  path: string,
): Promise<boolean> {
  try {
    await sp.getFileMeta(path);
    return true;
  } catch (e: unknown) {
    if (e === notFoundError) return false;
    throw e;
  }
}

/** Copy every file under the local md page's assets folder to the
 *  matching remote folder. Runs BEFORE the remote md write so the
 *  remote's push row snapshots the fresh assets (history.md: a page's
 *  file set = md body + assets images). Remote-only extras are left in
 *  place — push mirrors content, it doesn't garbage-collect. */
async function pushAssets(
  localMdPath: string,
  sp: HttpSpacePrimitives,
  remoteMdPath: string,
): Promise<void> {
  const prefix = mdAssetsPrefix(localMdPath);
  const listResp = await authedFetch(fsEndpoint);
  if (!listResp.ok) return;
  const rows = (await listResp.json()) as Array<{ type: string; path: string }>;
  const remotePrefix = mdAssetsPrefix(remoteMdPath);
  for (const row of rows) {
    if (row.type !== "file" || !row.path.startsWith(prefix)) continue;
    const local = await readLocal(row.path);
    if (!local) continue;
    await sp.writeFile(
      remotePrefix + row.path.slice(prefix.length),
      local.bytes,
    );
  }
}

export async function pushLocalToRemote(
  localPath: string,
  target: PushTarget,
  /** Root prefix on the remote where a NEW file lands (history.md
   *  "Target url root" — second-level pick in the modal). An existing
   *  same-id file is matched vault-wide regardless of this root. */
  targetRootName: string,
): Promise<PushOutcome> {
  const isPdf = localPath.toLowerCase().endsWith(".pdf");
  // The synced content: md body, or the PDF's sidecar JSON (file.md).
  const localContentPath = isPdf ? pdfSidecarPath(localPath) : localPath;

  const local = await readLocal(localContentPath);
  if (!local) return { kind: "idMissing" };
  const localText = new TextDecoder().decode(local.bytes);
  const id = isPdf
    ? (JSON.parse(localText)?.metadata?.id as string | undefined)
    : extractFrontmatter(localText).id;
  if (!id) return { kind: "idMissing" };

  const r = target.kind === "saved"
    ? getRemoteSpaceById(target.vaultId)
    : makeRemoteSpace({
      url: target.url,
      label: target.label ?? new URL(target.url).host,
      token: target.token,
    });
  if (!r) return { kind: "remoteMissing" };

  // Locate the existing remote sibling by id, vault-wide — history.md's
  // branch condition is "a remote file exists with the same page_id",
  // not "…under the chosen root".
  const remoteList = await r.sp.fetchFileList();
  const candidate = remoteList.find((f) => f.id === id);

  // Direct upload — no remote with this id yet (history.md).
  if (!candidate) {
    const remotePath = `${targetRootName}/${stripFirstSegment(localPath)}`;
    const remoteContentPath = isPdf ? pdfSidecarPath(remotePath) : remotePath;
    const doUpload = async (): Promise<PushOutcome> => {
      if (isPdf) {
        // First transfer: the binary travels once, then stays frozen.
        const pdfLocal = await readLocal(localPath);
        if (!pdfLocal) return { kind: "remoteMissing" };
        await r.sp.writeFile(remotePath, pdfLocal.bytes);
      } else {
        await pushAssets(localPath, r.sp, remotePath);
      }
      await r.sp.writeFile(remoteContentPath, local.bytes, undefined, "push");
      await recordLocalPushRow(localContentPath, local.bytes);
      return { kind: "clean", remotePath };
    };
    // history.md §Push: same relative path already holds a file →
    // confirm overwrite. Probe the path itself — the listing only
    // carries admitted pages, but ANY occupant counts.
    if (await remotePathOccupied(r.sp, remotePath)) {
      return {
        kind: "pathCollision",
        remotePath,
        remoteLabel: r.vault.label,
        confirmOverwrite: doUpload,
      };
    }
    return doUpload();
  }

  const remotePath = candidate.name;
  const remoteContentPath = isPdf ? pdfSidecarPath(remotePath) : remotePath;
  const { data, meta } = await r.sp.readFile(remoteContentPath);
  const remoteHash = meta.contentHash ?? "";
  const remoteText = new TextDecoder().decode(data);
  const base = await fetchLocalMergeBase(id);
  const baseText = base?.content ?? "";

  const decision = merge3Strategy(
    localText,
    local.hash,
    remoteText,
    remoteHash,
    baseText,
  );

  if (decision.kind === "noop") {
    // Bytes already identical — still append the push row so the merge
    // base advances to the converged content (history.md: "the local
    // history appends one save_type = push row", no exception).
    await recordLocalPushRow(localContentPath, local.bytes);
    return { kind: "noop" };
  }

  if (decision.kind === "clean") {
    if (!isPdf) await pushAssets(localPath, r.sp, remotePath);
    await r.sp.writeFile(remoteContentPath, local.bytes, undefined, "push");
    await recordLocalPushRow(localContentPath, local.bytes);
    return { kind: "clean", remotePath };
  }

  if (decision.kind === "autoMerged") {
    // Push-triggered merge writes remote + mirrors local (history.md).
    if (!isPdf) await pushAssets(localPath, r.sp, remotePath);
    await r.sp.writeFile(
      remoteContentPath,
      decision.mergedBytes,
      undefined,
      "push",
    );
    await recordLocalPushRow(localContentPath, decision.mergedBytes);
    return { kind: "autoMerged", remotePath };
  }

  return {
    kind: "conflict",
    baseText: decision.baseText,
    localText: decision.sourceText,
    remoteText: decision.targetText,
    remotePath,
    remoteLabel: r.vault.label,
    commitMerged: async (merged: Uint8Array) => {
      if (!isPdf) await pushAssets(localPath, r.sp, remotePath);
      await r.sp.writeFile(remoteContentPath, merged, undefined, "push");
      await recordLocalPushRow(localContentPath, merged);
    },
  };
}
