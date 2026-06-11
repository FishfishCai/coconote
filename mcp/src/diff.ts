// fast-diff wrapper producing splice ops whose indices are valid
// against the PROGRESSIVELY UPDATED text, so they can be replayed as
// sequential Y.Text delete/insert calls inside one transaction.
//
// Index units: fast-diff operates on JS strings and Y.Text in JS
// indexes in UTF-16 code units, so the indices transfer 1:1.

import diff from "fast-diff";
import type * as Y from "yjs";

export type Splice = { index: number; deleteLen: number; insertText: string };

export function computeSplices(oldText: string, newText: string): Splice[] {
  const out: Splice[] = [];
  let index = 0;
  for (const [op, text] of diff(oldText, newText)) {
    if (op === diff.EQUAL) {
      index += text.length;
    } else if (op === diff.DELETE) {
      out.push({ index, deleteLen: text.length, insertText: "" });
      // index stays: after the delete is applied the cursor is here.
    } else {
      const last = out[out.length - 1];
      if (last && last.index === index && last.insertText === "") {
        last.insertText = text; // fold delete+insert into one replace
      } else {
        out.push({ index, deleteLen: 0, insertText: text });
      }
      index += text.length;
    }
  }
  return out;
}

/** Replay splices in order. Call inside one doc.transact. */
export function applySplices(ytext: Y.Text, splices: Splice[]): void {
  for (const s of splices) {
    if (s.deleteLen > 0) ytext.delete(s.index, s.deleteLen);
    if (s.insertText !== "") ytext.insert(s.index, s.insertText);
  }
}
