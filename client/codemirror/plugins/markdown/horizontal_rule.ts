import type { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, WidgetType } from "@codemirror/view";
import { decoratorStateField, isCursorInRange } from "../../util/util.ts";

// Render `---` HR as a CSS line; expand to raw source when the
// caret lands on it for editing.
export function horizontalRulePlugin() {
  return decoratorStateField((state) => {
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter({ name, from, to }) {
        if (name !== "HorizontalRule") return;
        const line = state.doc.lineAt(from);
        if (isCursorInRange(state, [line.from, line.to])) return;
        widgets.push(
          Decoration.line({ class: "coconote-line-hr" }).range(line.from),
        );
        widgets.push(
          Decoration.replace({ widget: new EmptyWidget() })
            .range(line.from, line.to),
        );
      },
    });
    return Decoration.set(widgets, true);
  });
}

class EmptyWidget extends WidgetType {
  toDOM(): HTMLElement {
    return document.createElement("span");
  }
  override eq(other: WidgetType): boolean {
    return other instanceof EmptyWidget;
  }
}
