// Shared core for push (sync_push.ts) and pull (sync_pull.ts). Spec:
// history.md Push / Pull. The two flows mirror each other (source <->
// target swap, write-direction swap) but the merge math is identical.

import { merge3 } from "./diff3.ts";
import type { FileMeta } from "coconote/type/page";

/** Per-batch listing cache. A folder push/pull threads one of these
 *  through every queue item so each side's vault listing is fetched
 *  once per batch instead of once per file. Single-file syncs pass
 *  nothing and fetch directly. Snapshots are safe within a batch:
 *  branch decisions key on page ids, which are unique per file. */
export type SyncListings = {
  /** Remote listings keyed by the remote space URL. */
  remote?: Map<string, FileMeta[]>;
  /** Raw local /.file rows. */
  local?: Array<{ type: string; path: string; page_id?: string }>;
};

/** What `merge3Strategy` decided. Use to drive the per-flow writes. */
export type MergeDecision =
  | { kind: "noop" }
  | { kind: "clean" }
  | { kind: "autoMerged"; mergedBytes: Uint8Array }
  | {
    kind: "conflict";
    baseText: string;
    sourceText: string;
    targetText: string;
  };

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
  const conflicts = chunks.filter((c) => c.kind === "conflict").length;
  if (conflicts === 0) {
    const merged = chunks
      .map((c) => (c.kind === "ok" ? c.text : ""))
      .join("");
    return {
      kind: "autoMerged",
      mergedBytes: new TextEncoder().encode(merged),
    };
  }
  return { kind: "conflict", baseText, sourceText, targetText };
}
