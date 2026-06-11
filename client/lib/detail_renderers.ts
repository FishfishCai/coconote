// Registry: ref.details.type → preview/autocomplete handler. Handlers
// return Promise<string | null> — HTML for the hover preview, or null
// to fall through to default rendering.

import type { Ref } from "./ref.ts";

export type DetailKind = NonNullable<Ref["details"]>["type"];

export type HoverPreviewCtx = {
  /** Resolved path (after allKnownFiles lookup) of the link target. */
  resolvedPath: string;
};

/** Returns rendered HTML, or null to fall through to default flow. */
export type HoverHandler = (
  ref: Ref,
  ctx: HoverPreviewCtx,
) => Promise<string | null>;

const hoverHandlers = new Map<DetailKind, HoverHandler>();

export function registerHoverHandler(kind: DetailKind, fn: HoverHandler) {
  hoverHandlers.set(kind, fn);
}

export function getHoverHandler(kind: DetailKind): HoverHandler | undefined {
  return hoverHandlers.get(kind);
}
