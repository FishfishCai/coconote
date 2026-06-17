// NavService: page navigation - owns the session open-locations map and the
// initial-load ref, and drives the navigator (history push/pop + loadPage).

import type { Ref } from "coconote/lib/ref";
import {
  navigate as navigateFn,
  navigateSpecialRoute,
  openUrl as openUrlFn,
  type OpenLocations,
  parseRefFromURI,
  type SpecialRoute,
} from "../navigator.ts";
import type { NavigationCtx } from "../ctx/navigation.ts";
import type { Client } from "../client.ts";

export class NavService implements NavigationCtx {
  /** Session-only cursor/scroll per page - drives back/forward restore. */
  openLocations: OpenLocations = new Map();
  onLoadRef: Ref | null = parseRefFromURI();

  constructor(private client: Client) {}

  navigate(ref: Ref | null, replaceState = false) {
    return navigateFn(this.client, ref, replaceState);
  }

  navigateRoute(route: SpecialRoute) {
    navigateSpecialRoute(this.client, route);
  }

  openUrl(url: string) {
    return openUrlFn(url);
  }
}
