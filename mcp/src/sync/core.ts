// Shared core for push.ts / pull.ts, ported from client/lib/
// sync_core.ts and sync_history.ts. Spec: history.md Push / Pull. The
// two flows mirror each other (source <-> target swap, write-direction
// swap) but the merge math is identical.

import * as api from "../api";
import { frontmatterId } from "../frontmatter";
import { merge3 } from "./diff3";

/** What `merge3Strategy` decided. Use to drive the per-flow writes. */
export type MergeDecision =
  | { kind: "noop" }
  | { kind: "clean" }
  | { kind: "autoMerged"; mergedText: string }
  | { kind: "conflict"; baseText: string; sourceText: string; targetText: string };

/** Pure decision: given the same-id pair plus the local merge-base
 *  (spec history.md), what should the sync flow do? Hash equality skips
 *  the round-trip, equal-to-base fast-forwards, both moved triggers diff3. */
export function merge3Strategy(
  sourceText: string,
  sourceHash: string,
  targetText: string,
  targetHash: string,
  baseText: string,
): MergeDecision {
  if (sourceHash && sourceHash === targetHash) return { kind: "noop" };
  // Fast-forward (history.md Push / Pull): target side unchanged
  // since the merge base - copy source straight over.
  if (baseText && baseText === targetText) return { kind: "clean" };
  // Both sides moved -> diff3.
  const chunks = merge3(baseText, sourceText, targetText);
  if (chunks.some((c) => c.kind === "conflict")) {
    return { kind: "conflict", baseText, sourceText, targetText };
  }
  return {
    kind: "autoMerged",
    mergedText: chunks.map((c) => (c.kind === "ok" ? c.text : "")).join(""),
  };
}

/** Merge base = content of the LOCAL latest push/pull row (history.md
 *  Merge), "" when no sync has happened yet. Rows arrive newest first. */
export async function fetchLocalMergeBase(id: string): Promise<string> {
  const rows = await api.historyList(id).catch(() => [] as api.HistoryRow[]);
  const sync = rows.find((row) => row.save_type === "push" || row.save_type === "pull");
  if (!sync) return "";
  return await api.historySnapshot(id, sync.ts).catch(() => "");
}

/** Page id of a content file: sidecar metadata.id for the PDF sidecar
 *  JSON, frontmatter id for md. */
export function contentId(isPdf: boolean, text: string): string {
  if (!isPdf) return frontmatterId(text);
  try {
    const id = (JSON.parse(text) as { metadata?: { id?: unknown } })?.metadata?.id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** Mirror an md page's assets folder from one vault to another, BEFORE
 *  the content write so the target's sync row snapshots the fresh
 *  assets (history.md: a page's file set = md body + assets images).
 *  Target-only extras are left in place - sync mirrors content, it
 *  doesn't garbage-collect. */
export async function copyAssets(
  from: api.Vault,
  fromMdPath: string,
  to: api.Vault,
  toMdPath: string,
): Promise<void> {
  // Assets live in a dot-dir, which the plain listing prunes - only
  // the ?prefix= endpoint can see them.
  const fromPrefix = api.mdAssetsPrefix(fromMdPath);
  const toPrefix = api.mdAssetsPrefix(toMdPath);
  const paths = await from.listUnderPrefix(fromPrefix).catch(() => [] as string[]);
  for (const p of paths) {
    const got = await from.readBytesOrNull(p).catch(() => null);
    if (!got) continue;
    await to.writeFile(toPrefix + p.slice(fromPrefix.length), got.bytes, {
      contentType: got.contentType,
    });
  }
}

/** Structured tool outcomes shared by push_page / pull_page. */
export type SyncOutcome = {
  outcome: "noop" | "clean" | "autoMerged" | "merged" | "pathCollision" | "conflict";
  message: string;
  remotePath?: string;
  localPath?: string;
  baseText?: string;
  localText?: string;
  remoteText?: string;
};
