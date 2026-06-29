// The wikilink title resolver for the HTML render path (hover preview /
// table widget / export). Kept apart from wiki_link_resolver.ts because it
// reaches into the UI page list (UICtx), which that file deliberately
// avoids to stay Client/DOM-free and unit-testable.

import type { UICtx } from "../../core/ctx/ui.ts";
import { resolveTitle, titleForId } from "./wiki_link_resolver.ts";

/** Build the wikilink title resolver: a `[[title]]` chip displays the
 *  target's current `title`. Resolves the link name against the page list;
 *  returns undefined for missing / ambiguous so the renderer keeps the raw
 *  text. */
export function buildWikiLinkTitle(
  ctx: UICtx,
): (name: string) => string | undefined {
  const allPages = ctx.ui.viewState.allPages;
  return (name: string) => {
    if (!name || name.startsWith("#")) return undefined;
    const r = resolveTitle(name, allPages);
    return r.state === "hit" ? titleForId(r.id, allPages) : undefined;
  };
}
