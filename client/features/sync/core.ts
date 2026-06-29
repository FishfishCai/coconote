// Shared core for push (sync_push.ts) and pull (sync_pull.ts). Spec:
// history.md Push / Pull. The two flows mirror each other (source <->
// target swap, write-direction swap) but the merge math is identical.

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

/** Side-effect bundle a sync flow supplies to `applyOutcome`. The merge
 *  math is shared (sync_core); only these direction-specific writes
 *  differ between push (local -> remote) and pull (remote -> local). */
export type OutcomeIO = {
  /** Mirror the markdown body's assets to the other side. Skipped for
   *  PDFs (the binary travels separately) and on a noop. */
  mirrorAssets: () => Promise<void>;
  /** Persist `bytes` and record the sync history row(s) for this
   *  direction. `merged` is false for a fast-forward (the source side is
   *  unchanged) and true when `bytes` is a freshly merged result that
   *  must be written back to BOTH ends. */
  write: (bytes: Uint8Array, merged: boolean) => Promise<void>;
  /** Record the local sync row without transferring content (noop: bytes
   *  already identical, but the row marks the sync point). */
  recordOnly: (bytes: Uint8Array) => Promise<void>;
  /** Source bytes for the clean (fast-forward) case. */
  sourceBytes: Uint8Array;
  /** True for a PDF sidecar sync (suppresses asset mirroring). */
  isPdf: boolean;
};

/** What a resolved (non-conflict) outcome turned into. `conflict` is left
 *  to the caller, which owns the MergeView UI. */
export type AppliedOutcome =
  | { kind: "noop" }
  | { kind: "clean" }
  | { kind: "autoMerged" }
  | { kind: "conflict"; baseText: string; sourceText: string; targetText: string };

/** Shared write dispatch for both flows (history.md Push / Pull). Given
 *  the merge decision, run the direction's asset mirror + content write +
 *  history row, identically for push and pull. Conflict is returned
 *  verbatim for the caller's MergeView. */
export async function applyOutcome(
  decision: MergeDecision,
  io: OutcomeIO,
): Promise<AppliedOutcome> {
  switch (decision.kind) {
    case "noop":
      await io.recordOnly(io.sourceBytes);
      return { kind: "noop" };
    case "clean":
      if (!io.isPdf) await io.mirrorAssets();
      await io.write(io.sourceBytes, /*merged=*/ false);
      return { kind: "clean" };
    case "autoMerged":
      if (!io.isPdf) await io.mirrorAssets();
      await io.write(decision.mergedBytes, /*merged=*/ true);
      return { kind: "autoMerged" };
    case "conflict":
      return decision;
  }
}

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
