import type { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { decoratorStateField, isCursorInRange } from "../../util/util.ts";

const BULLET_RE = /^[-+*]/;
const ORDERED_RE = /^(\d+)[.)]/;

export function listBulletPlugin() {
  return decoratorStateField((state) => {
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter({ name, from, to, node }) {
        if (name !== "ListMark") return;
        if (isCursorInRange(state, [from, to])) {
          widgets.push(
            Decoration.mark({ class: "coconote-li-cursor" }).range(from, to),
          );
          return;
        }
        const mark = state.sliceDoc(from, to);
        if (BULLET_RE.test(mark)) {
          widgets.push(
            Decoration.replace({ widget: new BulletWidget(mark, to) })
              .range(from, to),
          );
          return;
        }
        const om = ORDERED_RE.exec(mark);
        if (om) {
          const n = parseInt(om[1], 10);
          const depth = orderedDepth(node);
          // Replace only the digits — keep trailing `.`/`)` so source
          // width is preserved.
          const display = formatOrderedMarker(n, depth);
          widgets.push(
            Decoration.replace({ widget: new OrderedWidget(display, to) })
              .range(from, from + om[1].length),
          );
          return;
        }
        widgets.push(
          Decoration.mark({ class: "coconote-li-cursor" }).range(from, to),
        );
      },
    });
    return Decoration.set(widgets, true);
  });
}

function orderedDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === "BulletList" || p.name === "OrderedList") depth++;
  }
  return depth;
}

const ROMAN: Array<[number, string]> = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
  [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
  [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];
function toRoman(n: number): string {
  if (n <= 0) return String(n);
  let out = "";
  for (const [v, s] of ROMAN) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}
function toAlpha(n: number, upper: boolean): string {
  // Wraps past 26 (z → aa) for safety.
  if (n <= 0) return String(n);
  let s = "";
  let x = n;
  while (x > 0) {
    const d = (x - 1) % 26;
    s = String.fromCharCode((upper ? 65 : 97) + d) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Matches LaTeX `enumerate` defaults: arabic / lower-α / roman / upper-α.
// markdown.md: the counter CYCLES (`1. a. i. A.`), so depth 5 wraps
// back to arabic instead of saturating at uppercase alpha.
function formatOrderedMarker(n: number, depth: number): string {
  switch (((depth - 1) % 4) + 1) {
    case 1: return String(n);
    case 2: return toAlpha(n, false);
    case 3: return toRoman(n);
    default: return toAlpha(n, true);
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly mark: string, readonly caretPos: number) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return other instanceof BulletWidget && other.mark === this.mark &&
      other.caretPos === this.caretPos;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.textContent = this.mark;
    span.className = "cm-list-bullet";
    span.style.cursor = "text";
    span.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      view.dispatch({ selection: { anchor: this.caretPos } });
      view.focus();
    });
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// Replaces the source digits with a span holding the depth-styled
// counter text (1 / a / i / A); the trailing `.`/`)` stays as real
// document text. The span doubles as the click hit-target — mousedown
// re-seats the caret at the marker.
class OrderedWidget extends WidgetType {
  constructor(readonly display: string, readonly caretPos: number) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return other instanceof OrderedWidget && other.display === this.display &&
      other.caretPos === this.caretPos;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "coconote-list-ordered";
    span.textContent = this.display;
    span.style.cursor = "text";
    span.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      view.dispatch({ selection: { anchor: this.caretPos } });
      view.focus();
    });
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}
