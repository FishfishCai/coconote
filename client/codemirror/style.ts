import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import * as ct from "../markdown/parser/customtags.ts";

export default function highlightStyles() {
  return HighlightStyle.define([
    /* Headings (all 4 spec levels) are styled per-line via the
       `coconote-line-h1..h4` classes in registry.ts, not here. */
    /* `t.link` / `t.url`: no source styling. WikiLinks are the only
       navigable form, raw URLs stay plain so they don't "look clickable". */
    { tag: t.meta, class: "coconote-meta" },
    { tag: t.quote, class: "coconote-quote" },
    { tag: t.monospace, class: "coconote-code" },
    /* Source-mode WikiLink text uses a distinct class so the chip's
       `.coconote-wiki-link` color/clickability don't leak into raw source. */
    { tag: ct.WikiLinkPartTag, class: "coconote-wiki-link-source" },
    { tag: ct.CodeInfoTag, class: "coconote-code-info" },
    { tag: ct.CommentTag, class: "coconote-comment" },
    { tag: ct.Highlight, class: "coconote-highlight" },
    { tag: t.emphasis, class: "coconote-emphasis" },
    { tag: t.strong, class: "coconote-strong" },
    { tag: t.atom, class: "coconote-atom" },
    { tag: t.bool, class: "coconote-bool" },
    { tag: t.inserted, class: "coconote-inserted" },
    { tag: t.deleted, class: "coconote-deleted" },
    { tag: t.literal, class: "coconote-literal" },
    { tag: t.keyword, class: "coconote-keyword" },
    { tag: t.list, class: "coconote-list" },
    { tag: t.operator, class: "coconote-operator" },
    { tag: t.string, class: "coconote-string" },
    { tag: t.number, class: "coconote-number" },
    { tag: [t.regexp, t.escape, t.special(t.string)], class: "coconote-string2" },
    { tag: t.variableName, class: "coconote-variableName" },
    { tag: t.typeName, class: "coconote-typeName" },
    { tag: t.strikethrough, class: "coconote-strikethrough" },
    { tag: t.comment, class: "coconote-comment" },
    { tag: t.invalid, class: "coconote-invalid" },
    { tag: t.processingInstruction, class: "coconote-meta" },
    { tag: t.punctuation, class: "coconote-punctuation" },
    { tag: ct.HorizontalRuleTag, class: "coconote-hr" },
    { tag: ct.NamedAnchorTag, class: "coconote-named-anchor" },
    { tag: ct.NamedAnchorMarkTag, class: "coconote-named-anchor-mark" },
    { tag: ct.NakedURLTag, class: "coconote-naked-url" },
  ]);
}
