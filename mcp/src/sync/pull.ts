// Pull a remote page into a local root, ported from client/lib/
// sync_pull.ts (history.md Pull). Mirror of push.ts: same id model,
// same synced content (md body / sidecar JSON), same merge strategy.
// The client resolves saved vaults from localStorage - here the remote
// url/token are explicit params and the remote listing is read
// directly, so the @label/ path plumbing is gone.

import * as api from "../api";
import { contentId, copyAssets, fetchLocalMergeBase, merge3Strategy, type SyncOutcome } from "./core";

export type PullArgs = {
  remoteUrl: string;
  remotePath: string;
  targetRoot: string;
  remoteToken?: string;
  overwrite?: boolean;
  mergedContent?: string;
};

export async function pullPage(a: PullArgs): Promise<SyncOutcome> {
  const remote = api.remoteVault(a.remoteUrl, a.remoteToken, `remote server ${a.remoteUrl}`);
  await remote.health();

  // Tolerate the index name form (md drops the extension on the wire).
  const remoteFsPath = api.nameToFsPath(a.remotePath);
  const isPdf = remoteFsPath.toLowerCase().endsWith(".pdf");
  const remoteContentPath = isPdf ? api.pdfSidecarPath(remoteFsPath) : remoteFsPath;

  const remoteGot = await remote.readBytes(remoteContentPath);
  const id = contentId(isPdf, remoteGot.text);
  if (!id) {
    throw new Error(
      `${remoteFsPath} on the remote has no page id ` +
        `(${isPdf ? "sidecar metadata.id" : "frontmatter id"}), so it cannot sync.`,
    );
  }

  // First local file (any root) whose page id matches - history.md keys
  // the branch on "a local file exists with the same page_id".
  const localHit = (await api.listEntries()).find(
    (e) => e.type === "file" && e.page_id === id,
  );

  const writeLocalPullRow = (path: string, body: string | Uint8Array) =>
    api.writeFile(path, body, { saveType: "pull" });

  // commitMerged path: write the merged result to both sides, each
  // tagged save_type=pull.
  if (a.mergedContent !== undefined) {
    if (!localHit) {
      throw new Error(
        "merged_content was passed but no local file shares this page id, " +
          "so nothing is in conflict. Re-call pull_page without merged_content.",
      );
    }
    const localPath = localHit.path;
    const localContentPath = isPdf ? api.pdfSidecarPath(localPath) : localPath;
    if (!isPdf) await copyAssets(remote, remoteFsPath, api.localVault, localPath);
    await writeLocalPullRow(localContentPath, a.mergedContent);
    await remote.writeFile(remoteContentPath, a.mergedContent, { saveType: "pull" });
    return {
      outcome: "merged",
      localPath,
      remotePath: remoteFsPath,
      message: `Merged content written to both sides (save_type=pull on each).`,
    };
  }

  // Direct download - no local file with this id.
  if (!localHit) {
    const localPath = `${a.targetRoot}/${api.stripFirstSegment(remoteFsPath)}`;
    // history.md Pull: same relative path already holds a file ->
    // confirm overwrite (any occupant counts, id-less included).
    if (!a.overwrite && (await api.exists(localPath))) {
      return {
        outcome: "pathCollision",
        localPath,
        message:
          `${localPath} locally already holds an unrelated file (different page id). ` +
          `Re-call pull_page with overwrite: true to replace it, or pull into another target_root.`,
      };
    }
    const localContentPath = isPdf ? api.pdfSidecarPath(localPath) : localPath;
    if (isPdf) {
      // First transfer: the binary travels once, then stays frozen.
      const pdf = await remote.readBytes(remoteFsPath);
      await api.writeFile(localPath, pdf.bytes, { contentType: pdf.contentType });
    } else {
      await copyAssets(remote, remoteFsPath, api.localVault, localPath);
    }
    await writeLocalPullRow(localContentPath, remoteGot.bytes);
    return { outcome: "clean", localPath, message: `Downloaded ${remoteFsPath} to ${localPath}.` };
  }

  const localPath = localHit.path;
  const localContentPath = isPdf ? api.pdfSidecarPath(localPath) : localPath;
  const localGot = await api.readBytes(localContentPath);
  const baseText = await fetchLocalMergeBase(id);
  // For pull, the "target" we're writing INTO is local, the source is the remote.
  const decision = merge3Strategy(
    remoteGot.text,
    remoteGot.contentHash,
    localGot.text,
    localGot.contentHash,
    baseText,
  );

  if (decision.kind === "noop") {
    // Identical bytes - still append the pull row so the merge base advances.
    await writeLocalPullRow(localContentPath, localGot.bytes);
    return {
      outcome: "noop",
      localPath,
      message: `Both sides already identical at ${localPath}, recorded the pull row.`,
    };
  }

  if (decision.kind === "clean") {
    if (!isPdf) await copyAssets(remote, remoteFsPath, api.localVault, localPath);
    await writeLocalPullRow(localContentPath, remoteGot.bytes);
    return {
      outcome: "clean",
      localPath,
      message: `Fast-forwarded ${localPath} (local unchanged since the merge base).`,
    };
  }

  if (decision.kind === "autoMerged") {
    if (!isPdf) await copyAssets(remote, remoteFsPath, api.localVault, localPath);
    await writeLocalPullRow(localContentPath, decision.mergedText);
    await remote.writeFile(remoteContentPath, decision.mergedText, { saveType: "pull" });
    return {
      outcome: "autoMerged",
      localPath,
      message:
        `Both sides had changed in disjoint regions: diff3 merged cleanly and ` +
        `both sides now hold the merged text of ${localPath}.`,
    };
  }

  return {
    outcome: "conflict",
    localPath,
    remotePath: remoteFsPath,
    baseText: decision.baseText,
    localText: decision.targetText,
    remoteText: decision.sourceText,
    message:
      "Both sides changed the same region. Produce one merged full text from " +
      "baseText / localText / remoteText, then re-call pull_page with merged_content " +
      "set to it (this writes the merge to both sides).",
  };
}
