// Editor-mode dot, sitting just left of the collab dot: green = render,
// orange = source, blue = read, grey = the active view is not a
// markdown editor (Content browser / Setting / PDF viewer). Unlike the
// collab dot this needs no polling: Cmd+M cycling goes through
// setUiOption -> MainUI.setUiOptionState, so uiOptions.editorMode is
// already reactive state.

import type { EditorMode } from "../types/ui.ts";

type Props = {
  mode: EditorMode;
  /** False while an overlay view (or no page) hides the editor. */
  isMarkdownEditor: boolean;
};

export function ModeDot({ mode, isMarkdownEditor }: Props) {
  const kind = isMarkdownEditor ? mode : "none";
  const title = isMarkdownEditor ? `Mode: ${mode}` : "Not a markdown editor";
  return (
    <span
      className={`coconote-mode-dot coconote-mode-dot-${kind}`}
      title={title}
      aria-label={title}
    />
  );
}
