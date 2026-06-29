import { Tag } from "@lezer/highlight";

// Custom highlight tags consumed by parser.ts (styleTags) + style.ts
// (HighlightStyle mapping). Add a new Tag only when both the emitting
// node and the CSS class binding land in the same change.
export const WikiLinkPartTag = Tag.define();
export const CodeInfoTag = Tag.define();
export const Highlight = Tag.define();
export const HorizontalRuleTag = Tag.define();
