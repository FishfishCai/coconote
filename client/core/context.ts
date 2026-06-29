// ClientContext is the aggregate of the per-domain surfaces in ./ctx/*.
// Client implements it. Consumers should import the narrowest interface
// they actually use (e.g. EditorCtx, NavigationCtx) directly from ./ctx;
// this file composes them into the aggregate and re-exports for any
// consumer that genuinely needs the whole surface.

import type { EditorCtx } from "./ctx/editor.ts";
import type { UICtx } from "./ctx/ui.ts";
import type { SpaceCtx } from "./ctx/space.ts";
import type { NavigationCtx } from "./ctx/navigation.ts";
import type { LifecycleCtx } from "./ctx/lifecycle.ts";
import type { ConfigCtx } from "./ctx/config.ts";

export type {
  AttachedCollabHandle,
  CollabUiStatus,
  EditorCtx,
  WidgetMeta,
} from "./ctx/editor.ts";
export type { UICtx } from "./ctx/ui.ts";
export type { SpaceCtx } from "./ctx/space.ts";
export type { NavigationCtx } from "./ctx/navigation.ts";
export type { LifecycleCtx } from "./ctx/lifecycle.ts";
export type { ConfigCtx } from "./ctx/config.ts";

export interface ClientContext
  extends EditorCtx, UICtx, SpaceCtx, NavigationCtx, LifecycleCtx, ConfigCtx {}
