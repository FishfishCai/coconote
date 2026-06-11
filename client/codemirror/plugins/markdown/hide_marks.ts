// Originally derived from https://codeberg.org/retronav/ixora (Apache 2.0).
import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
} from "../../util/util.ts";

const INLINE_HOST = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Highlight",
]);
const INLINE_MARK = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "HighlightMark",
]);

export function hideMarksPlugin() {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    const tree = syntaxTree(state);
    tree.iterate({
      enter({ name, from, to, node }) {
        if (name === "HeaderMark" && node.parent?.name.startsWith("ATXHeading")) {
          const lineFrom = state.doc.lineAt(from).from;
          const lineTo = state.doc.lineAt(to).to;
          if (isCursorInRange(state, [lineFrom, lineTo])) return;
          const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
          widgets.push(invisibleDecoration.range(from, end));
          return;
        }
        // Only the first `>` on a line is a quote marker (rendered as the
        // left border via `.coconote-line-blockquote`); any subsequent `>` on
        // the same line is plain text. Reveal markers when the cursor is
        // anywhere inside the OUTERMOST enclosing Blockquote so sibling
        // lines (and sibling nesting levels) don't re-flow while editing.
        if (name === "QuoteMark") {
          const line = state.doc.lineAt(from);
          const prefix = state.sliceDoc(line.from, from);
          if (!/^\s*$/.test(prefix)) return;
          let bq: SyntaxNode | null = null;
          for (let p = node.parent; p; p = p.parent) {
            if (p.name === "Blockquote") bq = p;
          }
          const range: [number, number] = bq ? [bq.from, bq.to] : [from, to];
          if (isCursorInRange(state, range)) return;
          const end = state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
          widgets.push(invisibleDecoration.range(from, end));
          return;
        }
        // Only hide when cursor is outside the containing host (so
        // `**bo|ld**` still shows asterisks).
        if (INLINE_HOST.has(name)) {
          if (isCursorInRange(state, [from, to])) return;
          let child = node.firstChild;
          while (child) {
            if (INLINE_MARK.has(child.name)) {
              widgets.push(invisibleDecoration.range(child.from, child.to));
            }
            child = child.nextSibling;
          }
        }
      },
    });
    return Decoration.set(widgets, true);
  });
}
