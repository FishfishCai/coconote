// Public surface of the markdown capability: the extended-markdown parser
// (text -> parse tree), the static HTML renderer (tree -> html), and the
// image-transclusion parse/resolve. Consumers (md-editor / codemirror,
// export, hover-preview, sync) import only from here; everything under
// markdown/ is internal. Imports only go DOWN (core + npm).

export { buildExtendedMarkdownLanguage, parseMarkdown } from "./parser/parser.ts";
export { ANCHOR_NAME_RE, pWikiLinkRegex, wikiLinkRegex } from "./parser/constants.ts";
export {
  CodeInfoTag,
  Highlight,
  HorizontalRuleTag,
  WikiLinkPartTag,
} from "./parser/customtags.ts";
export { renderMarkdownToHtml } from "./render/markdown_render.ts";
export type { MarkdownRenderOptions } from "./render/markdown_render.ts";
export { htmlEscapeAttr, renderHtml } from "./render/html_render.ts";
export type { Tag } from "./render/html_render.ts";
export { createMediaElement } from "./render/inline.ts";
export { parseDimensionFromAlias, parseTransclusion } from "./transclusion.ts";
export type {
  ContentAlign,
  ContentDimensions,
  Transclusion,
} from "./transclusion.ts";
export { bodyImpliedAssets, isMediaTransclusion } from "./transclusion_resolver.ts";
