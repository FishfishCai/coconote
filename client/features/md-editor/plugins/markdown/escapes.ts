import { type EditorState, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
} from "../../util/util.ts";

export function cleanEscapePlugin() {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];

    syntaxTree(state).iterate({
      enter({ type, from, to }) {
        if (type.name === "Escape" && !isCursorInRange(state, [from, to])) {
          widgets.push(invisibleDecoration.range(from, from + 1));
        }
      },
    });
    return Decoration.set(widgets, true);
  });
}
