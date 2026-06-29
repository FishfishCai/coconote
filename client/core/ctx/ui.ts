// UICtx: the app shell surface - the MainUI state container exposed to
// non-UI modules.

import type { MainUI } from "../../shell/editor_ui.tsx";

export interface UICtx {
  ui: MainUI;
  setUiOption(key: string, value: unknown): void;
}
