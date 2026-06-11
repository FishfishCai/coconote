// Forked from https://codeberg.org/retronav/ixora
// Original author: Pranav Karawale
// License: Apache License 2.0.
import {
  type EditorState,
  Facet,
  StateField,
  type Transaction,
} from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { ClientContext as Client } from "../../core/context.ts";

type LinkOptions = {
  text: string;
  /** Original (unencoded) link target, read by hover preview. */
  stringRef?: string;
  cssClass: string;
  from: number;
  callback: (e: MouseEvent) => void;
};

export class LinkWidget extends WidgetType {
  constructor(readonly options: LinkOptions) {
    super();
  }

  toDOM(): HTMLElement {
    // No href: avoids Chrome's URL preview tooltip, click handler drives nav.
    const anchor = document.createElement("a");
    anchor.className = this.options.cssClass;
    anchor.textContent = this.options.text;
    anchor.setAttribute("role", "link");
    anchor.tabIndex = 0;
    if (this.options.stringRef) {
      anchor.dataset.sbStringref = this.options.stringRef;
    }

    anchor.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        this.options.callback(e);
      } catch (e) {
        console.error("Error handling wiki link click", e);
      }
    });

    let touchCount = 0;
    anchor.addEventListener("touchmove", () => {
      touchCount++;
    });
    anchor.addEventListener("touchend", (e) => {
      if (touchCount === 0) {
        e.preventDefault();
        e.stopPropagation();
        this.options.callback(new MouseEvent("click", e));
      }
      touchCount = 0;
    });
    return anchor;
  }

  override eq(other: WidgetType): boolean {
    // Every render-affecting option must participate: cssClass flips
    // when a missing target gets created (text unchanged), and without
    // it the widget would stay red until the link text itself changes.
    // `callback` is deliberately excluded - it's a fresh closure per
    // decoration pass, so comparing it would defeat eq entirely.
    return (
      other instanceof LinkWidget &&
      this.options.from === other.options.from &&
      this.options.text === other.options.text &&
      this.options.stringRef === other.options.stringRef &&
      this.options.cssClass === other.options.cssClass
    );
  }
}

export interface DecoratorFieldOptions {
  /**
   * Set true ONLY when decorations don't depend on cursor position.
   * Plugins that gate on `isCursorInRange` MUST leave this false - they
   * need re-eval to fold the active line back to source.
   */
  ignoreSelectionOnly?: boolean;
}

export function decoratorStateField(
  stateToDecoratorMapper: (state: EditorState) => DecorationSet,
  options: DecoratorFieldOptions = {},
) {
  const ignoreSelectionOnly = options.ignoreSelectionOnly === true;
  return StateField.define<DecorationSet>({
    create(state: EditorState) {
      return stateToDecoratorMapper(state);
    },

    update(value: DecorationSet, tr: Transaction) {
      // Map through changes mid-IME to avoid candidate flicker.
      if (tr.isUserEvent("input.type.compose")) {
        if (tr.docChanged) {
          return value.map(tr.changes);
        }
        return value;
      }

      if (!tr.docChanged && !tr.selection && tr.effects.length === 0) {
        return value;
      }
      if (
        ignoreSelectionOnly && !tr.docChanged && tr.effects.length === 0
      ) {
        return value;
      }
      return stateToDecoratorMapper(tr.state);
    },

    provide: (f) => EditorView.decorations.from(f),
  });
}

function checkRangeOverlap(
  range1: [number, number],
  range2: [number, number],
) {
  return range1[0] <= range2[1] && range2[0] <= range1[1];
}

/** True while the editor is in `read` mode. Provided by
 *  editModeExtensionsFor (through the edit-mode compartment, so mode
 *  switches reconfigure it) and read straight off the EditorState -
 *  read mode keeps every widget permanently folded. */
export const readModeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

export function isCursorInRange(state: EditorState, range: [number, number]) {
  // Read mode keeps widgets folded permanently.
  if (state.facet(readModeFacet)) return false;
  return state.selection.ranges.some((selection) =>
    checkRangeOverlap(range, [selection.from, selection.to]),
  );
}

export const invisibleDecoration = Decoration.replace({});

/** Lezer-markdown node names whose text content is literal (code or
 *  HTML comment): the math scanner / autocomplete / image scanner
 *  must NOT look inside these. Use against `node.type.name`. */
export function isCodeOrCommentNode(name: string): boolean {
  return (
    name === "FencedCode" ||
    name === "CodeBlock" ||
    name === "InlineCode" ||
    name === "CodeText" ||
    name === "Comment"
  );
}

type WidgetRenderMode = "ready" | "loading";

export function widgetRenderMode(client: Client): WidgetRenderMode {
  return client.systemReady ? "ready" : "loading";
}
