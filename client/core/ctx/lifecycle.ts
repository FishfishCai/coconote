// LifecycleCtx: optional editor/page lifecycle hooks.

import type { ClickEvent } from "coconote/type/client";

export interface LifecycleCtx {
  onEditorInit?: () => void;
  onPageClick?: (event: ClickEvent) => void;
  onPageSaved?: () => void;
}
