// Line-level diff for the history panel preview (history.md -
// "A git-diff-style red/green block highlights the difference between
// this version and the current on-disk content"). Built on the shared
// LCS helper, which trims equal prefix/suffix lines to shrink the DP.

import { lcsDiff } from "./lcs.ts";

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string };

/** Produce a line-level diff. `from` is the "old" side (rendered with
 *  `del` lines = removed when moving to `to`), `to` is the "new" side
 *  (rendered with `add` lines = introduced since `from`). */
export function lineDiff(from: string, to: string): DiffLine[] {
  // Prefix/suffix trimming lives inside lcsDiff.
  return lcsDiff(from.split("\n"), to.split("\n")).map((op) =>
    op.kind === "ins"
      ? { kind: "add", text: op.line }
      : { kind: op.kind, text: op.line }
  );
}
