// The File entity: the on-the-wire FileMeta / PageMeta identity + metadata
// types, the frontmatter parser/editor (id / title / tags / refs /
// backrefs), and the PDF sidecar data model (the annotations json shape +
// pure parse/serialize). No imports beyond npm - all pure data shaping;
// the I/O that reads/writes these lives in core/transport + the features.

export type { FileKind, FileMeta, PageMeta } from "./page.ts";
// Shape spec response headers (server.md) into a FileMeta - pure mapping of
// an already-fetched Headers object, no I/O of its own.
export { headersToFileMeta } from "./headers.ts";
export {
  addToFrontmatterList,
  extractFrontmatter,
  removeFromFrontmatterList,
  setFrontmatterList,
  stripFrontmatter,
} from "./frontmatter.ts";
export type { Frontmatter } from "./frontmatter.ts";
export {
  emptySidecar,
  HIGHLIGHT_COLORS,
  nextAutoAnchorName,
  parseSidecar,
  serializeSidecar,
  SIDECAR_ASSET,
} from "./pdf_sidecar.ts";
export type {
  Anchor,
  Color,
  Comment,
  Highlight,
  PdfMetadata,
  PdfNotes,
  PdfSidecar,
} from "./pdf_sidecar.ts";
