// LCS-based line diff feeding diff3.ts. Ported verbatim from
// client/lib/lcs.ts. Standard O(N*M) DP, equal prefix/suffix lines are
// trimmed for the small-DP fast path on the common case.

export type LcsDiffOp =
  | { kind: "same"; line: string }
  | { kind: "del"; line: string }
  | { kind: "ins"; line: string };

function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Diff `a -> b` line-by-line. Operations come out in the order they
 *  would replay when transforming `a` into `b`. */
export function lcsDiff(a: string[], b: string[]): LcsDiffOp[] {
  // Trim the equal prefix/suffix before the quadratic DP.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const coreA = a.slice(head, a.length - tail);
  const coreB = b.slice(head, b.length - tail);

  const dp = lcsTable(coreA, coreB);
  const out: LcsDiffOp[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: "same", line: a[k] });
  let i = 0, j = 0;
  while (i < coreA.length && j < coreB.length) {
    if (coreA[i] === coreB[j]) {
      out.push({ kind: "same", line: coreA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", line: coreA[i] });
      i++;
    } else {
      out.push({ kind: "ins", line: coreB[j] });
      j++;
    }
  }
  while (i < coreA.length) out.push({ kind: "del", line: coreA[i++] });
  while (j < coreB.length) out.push({ kind: "ins", line: coreB[j++] });
  for (let k = a.length - tail; k < a.length; k++) {
    out.push({ kind: "same", line: a[k] });
  }
  return out;
}
