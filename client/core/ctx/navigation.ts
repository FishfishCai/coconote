// NavigationCtx: the page-navigation surface (open locations + navigate).

import type { Ref } from "coconote/lib/ref";
import type { OpenLocations } from "../navigator.ts";

export interface NavigationCtx {
  openLocations: OpenLocations;
  readonly onLoadRef: Ref | null;
  navigate(
    ref: Ref | null,
    replaceState?: boolean,
  ): Promise<void> | void;
  openUrl(url: string): void;
}
