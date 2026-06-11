// Line-based 3-way merge (history.md Three-way diff). Region-based
// diff3: a "stable" line is a base line kept verbatim by BOTH sides,
// each region between stable anchors is classified whole (only local
// changed -> local, only remote -> remote, identical change -> either,
// different -> conflict). Deletion counts as a change, so
// modify-vs-delete conflicts instead of taking the surviving side.

import { lcsDiff } from "./lcs.ts";

export type Chunk =
  | { kind: "ok"; text: string }
  | { kind: "conflict"; local: string; base: string; remote: string };

/** Map base-line index -> derived-line index for every line the derived
 *  side kept unchanged (the LCS "same" ops). */
function matchMap(base: string[], derived: string[]): Map<number, number> {
  const map = new Map<number, number>();
  let bi = 0;
  let di = 0;
  for (const op of lcsDiff(base, derived)) {
    if (op.kind === "same") {
      map.set(bi, di);
      bi++;
      di++;
    } else if (op.kind === "del") {
      bi++;
    } else {
      di++;
    }
  }
  return map;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Split into lines, recording whether the text ended with a newline.
 *  Without dropping the trailing "" sentinel, a newline-terminated file
 *  ("a\nb\n") splits to ["a","b",""] and the phantom line doubles the
 *  trailing newline - defeating the noop/fast-forward hash paths on the
 *  next sync. The empty string counts as newline-terminated so merging
 *  into an empty file doesn't flag a phantom newline change. */
function splitLines(s: string): { lines: string[]; nl: boolean } {
  if (s === "") return { lines: [], nl: true };
  const nl = s.endsWith("\n");
  const lines = s.split("\n");
  if (nl) lines.pop();
  return { lines, nl };
}

/** Three-way merge. Returns ordered chunks. Each "ok" chunk's text is
 *  newline-terminated, conflict fields are "" or newline-terminated. */
export function merge3(base: string, local: string, remote: string): Chunk[] {
  const sep = "\n";
  const { lines: baseLines, nl: baseNl } = splitLines(base);
  const { lines: localLines, nl: localNl } = splitLines(local);
  const { lines: remoteLines, nl: remoteNl } = splitLines(remote);

  const ml = matchMap(baseLines, localLines);
  const mr = matchMap(baseLines, remoteLines);

  const out: Chunk[] = [];
  let buf: string[] = [];
  const flushOk = () => {
    if (buf.length === 0) return;
    out.push({ kind: "ok", text: buf.join(sep) + sep });
    buf = [];
  };

  const emitRegion = (bSeg: string[], lSeg: string[], rSeg: string[]) => {
    const lChanged = !arrEq(lSeg, bSeg);
    const rChanged = !arrEq(rSeg, bSeg);
    if (!lChanged && !rChanged) {
      buf.push(...bSeg);
    } else if (!lChanged) {
      buf.push(...rSeg);
    } else if (!rChanged) {
      buf.push(...lSeg);
    } else if (arrEq(lSeg, rSeg)) {
      buf.push(...lSeg);
    } else {
      flushOk();
      out.push({
        kind: "conflict",
        local: lSeg.length ? lSeg.join(sep) + sep : "",
        base: bSeg.length ? bSeg.join(sep) + sep : "",
        remote: rSeg.length ? rSeg.join(sep) + sep : "",
      });
    }
  };

  let b = 0;
  let l = 0;
  let r = 0;
  while (b < baseLines.length) {
    // Advance to the next base line stable on both sides.
    let s = b;
    while (s < baseLines.length && !(ml.has(s) && mr.has(s))) s++;
    if (s === baseLines.length) break; // tail region handled below
    const ls = ml.get(s)!;
    const rs = mr.get(s)!;
    emitRegion(
      baseLines.slice(b, s),
      localLines.slice(l, ls),
      remoteLines.slice(r, rs),
    );
    buf.push(baseLines[s]);
    b = s + 1;
    l = ls + 1;
    r = rs + 1;
  }
  emitRegion(baseLines.slice(b), localLines.slice(l), remoteLines.slice(r));
  flushOk();

  // Trailing newline merges like content: the side that changed it wins.
  const nl = localNl === remoteNl
    ? localNl
    : (localNl === baseNl ? remoteNl : localNl);
  if (!nl && out.length > 0) {
    const last = out[out.length - 1];
    // A trailing conflict keeps its newline-terminated markers - only the
    // common case (ok tail) preserves the missing final newline exactly.
    if (last.kind === "ok") last.text = last.text.replace(/\n$/, "");
  }
  return out;
}
