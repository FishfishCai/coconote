// Editor commands wired into the custom keymap in editor_state.ts.
// They need syntax-tree / callout-bounds inspection, which is kept out
// of the state/extension-assembly module.

import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  CALLOUT_CLOSE_RE,
  CALLOUT_OPEN_RE,
  findCalloutBounds,
  parseCalloutOpener,
} from "../lib/callout.ts";

// Cmd/Ctrl-A inside code/math/callout selects only the inner content.
// Returns false → caller falls back to default whole-doc select-all.
export function smartSelectAll(view: EditorView): boolean {
  const state = view.state;
  const pos = state.selection.main.from;

  // No single AST node spans the callout body → scan fenced-div lines.
  const cr = calloutInnerRange(state, pos);
  if (cr) {
    view.dispatch({
      selection: EditorSelection.range(cr.from, cr.to),
    });
    return true;
  }

  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    const name = node.type.name;
    if (name === "InlineCode") {
      const text = state.sliceDoc(node.from, node.to);
      const m = /^(`+)/.exec(text);
      const n = m ? m[1].length : 1;
      view.dispatch({
        selection: EditorSelection.range(node.from + n, node.to - n),
      });
      return true;
    }
    if (name === "Math") {
      const text = state.sliceDoc(node.from, node.to);
      const n = text.startsWith("$$") ? 2 : 1;
      view.dispatch({
        selection: EditorSelection.range(node.from + n, node.to - n),
      });
      return true;
    }
    if (name === "FencedCode" || name === "CodeBlock") {
      let child = node.firstChild;
      while (child) {
        if (child.type?.name === "CodeText") {
          view.dispatch({
            selection: EditorSelection.range(child.from, child.to),
          });
          return true;
        }
        child = child.nextSibling;
      }
    }
  }
  return false;
}

// Range = label (if any) → last body line. `::: keyword` and closing
// `:::` always excluded. null when pos isn't inside a well-formed callout.
function calloutInnerRange(
  state: EditorState,
  pos: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  let openerLine: { number: number; from: number; to: number; text: string } | null = null;
  for (let n = line.number; n >= 1; n--) {
    const ln = state.doc.line(n);
    if (CALLOUT_CLOSE_RE.test(ln.text)) return null; // hit closer first
    if (CALLOUT_OPEN_RE.test(ln.text)) {
      openerLine = ln;
      break;
    }
  }
  if (!openerLine) return null;
  const bounds = findCalloutBounds(
    (n) => (n <= state.doc.lines ? state.doc.line(n) : null),
    openerLine.number,
  );
  if (!bounds) return null; // unclosed
  if (line.number > bounds.closerLineNo) return null;
  const labelCol = parseCalloutOpener(openerLine.text)?.labelOffset ?? -1;
  const from = labelCol >= 0
    ? openerLine.from + labelCol
    : (bounds.closerLineNo > openerLine.number + 1
      ? state.doc.line(openerLine.number + 1).from
      : openerLine.to);
  const to = bounds.closerLineNo > openerLine.number + 1
    ? state.doc.line(bounds.closerLineNo - 1).to
    : openerLine.to;
  return { from, to };
}

export function insideList(view: EditorView): boolean {
  const sel = view.state.selection.main;
  for (
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(sel.from, -1);
    node;
    node = node.parent
  ) {
    const n = node.type.name;
    if (n === "ListItem" || n === "BulletList" || n === "OrderedList") {
      return true;
    }
  }
  return false;
}
