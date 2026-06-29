import type { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { NavigationCtx } from "../../../../core/ctx/navigation.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
type Client = EditorCtx & NavigationCtx & SpaceCtx & UICtx;
import {
  decoratorStateField,
  invisibleDecoration,
  isCodeOrCommentNode,
  isCursorInRange,
  widgetRenderMode,
} from "../../util/util.ts";
import { MediaWidget } from "./media_widget.ts";
import { LoadingWidget } from "./loading_widget.ts";
import { createMediaElement } from "../../../../capabilities/markdown/index.ts";
import { parseTransclusion } from "../../../../capabilities/markdown/index.ts";
import { isMediaTransclusion } from "../../../../capabilities/markdown/index.ts";
import { scanMath } from "./tex.ts";

// Page transclusion (`![[Page]]`) is intentionally unsupported - hover on
// `[[Page]]` is the preview path, non-media `![[...]]` renders as raw text.
export function inlineContentPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    const renderMode = widgetRenderMode(client);
    // Collected so the math scanner skips `$` inside code/comments.
    const skipRanges: Array<[number, number]> = [];

    syntaxTree(state).iterate({
      enter: ({ type, from, to }) => {
        if (isCodeOrCommentNode(type.name)) {
          skipRanges.push([from, to]);
          return;
        }
        if (type.name !== "Image") return;

        const text = state.sliceDoc(from, to);
        const transclusion = parseTransclusion(text);
        if (!transclusion) return;
        if (!isMediaTransclusion(transclusion.url)) return;
        if (isCursorInRange(state, [from, to])) return;

        widgets.push(invisibleDecoration.range(from, to));

        if (renderMode === "loading") {
          widgets.push(
            Decoration.widget({
              widget: new LoadingWidget(),
              block: true,
            }).range(from),
          );
          return;
        }

        widgets.push(
          Decoration.widget({
            widget: new MediaWidget({
              client,
              cacheKey: `widget:${client.currentId()}:${text}`,
              sourceText: text,
              containerClass: "coconote-inline-content",
              callback: async () => {
                // Local image embeds load from THIS file's assets dir
                // (/.file?id=<owner>&asset=<filename>).
                const element = createMediaElement(
                  transclusion,
                  client.currentId(),
                );
                return element ? { html: element } : null;
              },
            }),
            block: true,
          }).range(from),
        );
      },
    });

    scanMath(state, widgets, client, skipRanges);
    return Decoration.set(widgets, true);
  });
}
