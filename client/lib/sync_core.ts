// Shared core for push (sync_push.ts) and pull (sync_pull.ts).
// Spec: history.md §Push / §Pull. The two flows mirror each other —
// source ↔ target swap, write-direction swap — but the merge math
// itself is identical.

import { merge3 } from "./diff3.ts";

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
 *  (spec history.md), what should the sync flow do?
 *  Hash equality skips the round-trip; equal-to-base means fast-
 *  forward; both moved triggers diff3. */
export function merge3Strategy(
  sourceText: string,
  sourceHash: string,
  targetText: string,
  targetHash: string,
  baseText: string,
): MergeDecision {
  if (sourceHash && sourceHash === targetHash) return { kind: "noop" };
  // Fast-forward (history.md §Push / §Pull): target side unchanged
  // since the merge base — copy source straight over.
  if (baseText && baseText === targetText) return { kind: "clean" };
  // Both sides moved → diff3.
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
