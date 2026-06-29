// Public surface of the links capability: wiki-link ref parsing
// (title / #heading / :callout / %pdf-name), title<->id resolution mirroring
// the server resolver, the one-hop `refs` jumpability gate, and the
// callout/header offset + display helpers a `[[..]]` jump needs. Consumers
// (md-editor / codemirror, graph, hover, navigation) import only from here;
// everything under links/ is internal. Imports only go DOWN (core + npm).
//
// NOTE: the pure FILE/PATH helpers (getPathExtension / isMarkdownPath / Path)
// live in core/util - they are a path concern, not a links concern, so the
// markdown render path can share them without a links edge.

export {
  encodeRef,
  findCalloutTarget,
  getOffsetFromHeader,
  getOffsetFromRef,
  parseToRef,
  resolveCalloutDisplay,
  sliceByRef,
} from "./ref.ts";
export type { Ref } from "./ref.ts";
export { isInRefs } from "./refs_gate.ts";
export {
  isPdfId,
  pageById,
  resolveTitle,
  titleForId,
} from "./wiki_link_resolver.ts";
export type { TitleResolution } from "./wiki_link_resolver.ts";
export { buildWikiLinkTitle } from "./wiki_link_title.ts";
