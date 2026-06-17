// UICtx: the app shell surface (the MainUI state container and the
// panel-route updates for Content / Setting).

import type { MainUI } from "../../components/editor_ui.tsx";

export interface UICtx {
  ui: MainUI;
  setUiOption(key: string, value: unknown): void;
  /** Update the URL bar to `/.content/<view>` / `/.setting` without
   *  going through the page-resolution path (content.md / setting.md
   *  prescribe URLs for these panels). */
  navigateRoute(
    route: { kind: "content"; view: "path" | "tag" | "graph" } | {
      kind: "setting";
    },
  ): void;
}
