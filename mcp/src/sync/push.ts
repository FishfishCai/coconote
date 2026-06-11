// Push a local page to a remote root, ported from client/lib/
// sync_push.ts (history.md Push). Identity travels via the page id
// (frontmatter id for md, sidecar metadata.id for PDFs). Synced CONTENT
// is the md body, or the sidecar JSON for PDFs (the binary is frozen on
// import and only uploaded on first transfer). An md page's assets
// folder is mirrored alongside the body. Merge base = local latest
// push/pull row's content.
//
// The client's interactive continuations (confirmOverwrite /
// commitMerged closures) become re-calls here: `overwrite: true` reruns
// the collision branch, `merged_content` runs the commitMerged path.

import * as api from "../api";
import { contentId, copyAssets, fetchLocalMergeBase, merge3Strategy, type SyncOutcome } from "./core";

export type PushArgs = {
  path: string;
  targetUrl: string;
  targetRoot: string;
  targetToken?: string;
  overwrite?: boolean;
  mergedContent?: string;
};

export async function pushPage(a: PushArgs): Promise<SyncOutcome> {
  const remote = api.remoteVault(a.targetUrl, a.targetToken, `target server ${a.targetUrl}`);
  await remote.health();

  const isPdf = a.path.toLowerCase().endsWith(".pdf");
  // The synced content: md body, or the PDF's sidecar JSON (file.md).
  const localContentPath = isPdf ? api.pdfSidecarPath(a.path) : a.path;
  const local = await api.readBytesOrNull(localContentPath);
  if (!local) {
    throw new Error(
      isPdf
        ? `${a.path} has no sidecar at ${localContentPath}: include the PDF first (set_included).`
        : `${a.path} not found.`,
    );
  }
  const id = contentId(isPdf, local.text);
  if (!id) {
    throw new Error(
      `${a.path} has no page id yet, so it cannot sync. ` +
        `The server assigns one on the first indexed save (coconote: true).`,
    );
  }

  // Locate the existing remote sibling by id, vault-wide - history.md's
  // branch condition is "a remote file exists with the same page_id",
  // not "...under the chosen root".
  const candidate = (await remote.listEntries()).find(
    (e) => e.type === "file" && e.page_id === id,
  );

  // Mirror the synced bytes back locally with save_type=push so local
  // history records the sync point (the next sync's merge base).
  const recordLocalPushRow = (body: string | Uint8Array) =>
    api.writeFile(localContentPath, body, { saveType: "push" });

  // commitMerged path (history.md MergeView submit): write the merged
  // result to both sides, each tagged save_type=push.
  if (a.mergedContent !== undefined) {
    if (!candidate) {
      throw new Error(
        "merged_content was passed but the target has no file with this page id, " +
          "so nothing is in conflict. Re-call push_page without merged_content.",
      );
    }
    const remotePath = candidate.path;
    const remoteContentPath = isPdf ? api.pdfSidecarPath(remotePath) : remotePath;
    if (!isPdf) await copyAssets(api.localVault, a.path, remote, remotePath);
    await remote.writeFile(remoteContentPath, a.mergedContent, { saveType: "push" });
    await recordLocalPushRow(a.mergedContent);
    return {
      outcome: "merged",
      remotePath,
      message: `Merged content written to both sides of ${remotePath} (save_type=push on each).`,
    };
  }

  // Direct upload - no remote with this id yet.
  if (!candidate) {
    const remotePath = `${a.targetRoot}/${api.stripFirstSegment(a.path)}`;
    // history.md Push: same relative path already holds a file ->
    // confirm overwrite. Probe the path itself - the listing only
    // carries admitted pages, but ANY occupant counts.
    if (!a.overwrite && (await remote.exists(remotePath))) {
      return {
        outcome: "pathCollision",
        remotePath,
        message:
          `${remotePath} on the target already holds an unrelated file (different page id). ` +
          `Re-call push_page with overwrite: true to replace it, or push to another target_root.`,
      };
    }
    const remoteContentPath = isPdf ? api.pdfSidecarPath(remotePath) : remotePath;
    if (isPdf) {
      // First transfer: the binary travels once, then stays frozen.
      const pdf = await api.readBytes(a.path);
      await remote.writeFile(remotePath, pdf.bytes, { contentType: pdf.contentType });
    } else {
      await copyAssets(api.localVault, a.path, remote, remotePath);
    }
    await remote.writeFile(remoteContentPath, local.bytes, { saveType: "push" });
    await recordLocalPushRow(local.bytes);
    return { outcome: "clean", remotePath, message: `Uploaded ${a.path} to ${remotePath}.` };
  }

  const remotePath = candidate.path;
  const remoteContentPath = isPdf ? api.pdfSidecarPath(remotePath) : remotePath;
  const remoteGot = await remote.readBytes(remoteContentPath);
  const baseText = await fetchLocalMergeBase(id);
  const decision = merge3Strategy(
    local.text,
    local.contentHash,
    remoteGot.text,
    remoteGot.contentHash,
    baseText,
  );

  if (decision.kind === "noop") {
    // Bytes already identical - still append the push row so the merge
    // base advances to the converged content.
    await recordLocalPushRow(local.bytes);
    return {
      outcome: "noop",
      remotePath,
      message: `Both sides already identical at ${remotePath}, recorded the push row.`,
    };
  }

  if (decision.kind === "clean") {
    if (!isPdf) await copyAssets(api.localVault, a.path, remote, remotePath);
    await remote.writeFile(remoteContentPath, local.bytes, { saveType: "push" });
    await recordLocalPushRow(local.bytes);
    return {
      outcome: "clean",
      remotePath,
      message: `Fast-forwarded ${remotePath} (target unchanged since the merge base).`,
    };
  }

  if (decision.kind === "autoMerged") {
    if (!isPdf) await copyAssets(api.localVault, a.path, remote, remotePath);
    await remote.writeFile(remoteContentPath, decision.mergedText, { saveType: "push" });
    await recordLocalPushRow(decision.mergedText);
    return {
      outcome: "autoMerged",
      remotePath,
      message:
        `Both sides had changed in disjoint regions: diff3 merged cleanly and ` +
        `both sides now hold the merged text of ${remotePath}.`,
    };
  }

  return {
    outcome: "conflict",
    remotePath,
    baseText: decision.baseText,
    localText: decision.sourceText,
    remoteText: decision.targetText,
    message:
      "Both sides changed the same region. Produce one merged full text from " +
      "baseText / localText / remoteText, then re-call push_page with merged_content " +
      "set to it (this writes the merge to both sides).",
  };
}
