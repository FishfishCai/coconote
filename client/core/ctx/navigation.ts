// NavigationCtx: the page-navigation surface (open locations + navigate).

import type { NavTarget, OpenLocations } from "../../shell/navigator.ts";

export interface NavigationCtx {
  openLocations: OpenLocations;
  /** The id parsed from the boot URL, when it directly addressed one
   *  (a `/<id>` deep link), else undefined. */
  onLoadId(): string | undefined;
  navigate(
    target: NavTarget | null,
    replaceState?: boolean,
  ): Promise<void> | void;
  openUrl(url: string): void;
}
