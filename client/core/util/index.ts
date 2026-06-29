// Generic framework-light utilities shared across every tier: the LCS line
// diff, small async / json helpers, the parse-tree walkers, uuid, url/path
// helpers, network-error constants, and a couple of Preact DOM hooks. The
// bottom of the import graph - depends only on npm libs.

export { lcsDiff } from "./lcs.ts";
export type { LcsDiffOp } from "./lcs.ts";
export { safeRun } from "./async.ts";
export { safeJsonParse } from "./json.ts";
export {
  addParentPointers,
  findNodeMatching,
  findNodeOfType,
  findParentMatching,
  nodeAtPos,
  renderToText,
  traverseTree,
} from "./tree.ts";
export type { ParseTree } from "./tree.ts";
export { newUuid } from "./uuid.ts";
export { isLocalURL } from "./resolve.ts";
export {
  assetsPrefix,
  basename,
  encodePathSegments,
  getPathExtension,
  isMarkdownPath,
  pdfSidecarPath,
  pdfStem,
} from "./path_url.ts";
export type { Path } from "./path_url.ts";
export { useMenuPosition } from "./menu_position.ts";
export { useDismissOnOutside } from "./dom_hooks.ts";
export {
  errMessage,
  isNetworkError,
  notAuthenticatedError,
  notFoundError,
  offlineError,
  pingTimeout,
} from "./constants.ts";
export {
  CALLOUT_CLOSE_RE,
  CALLOUT_OPEN_RE,
  findCalloutBounds,
  parseCalloutOpener,
  resolveTemplate,
} from "./callout.ts";
export type { CalloutBounds, CalloutTemplate } from "./callout.ts";
