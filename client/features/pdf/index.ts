// PDF feature: the reader pane with collaborative annotations (highlights,
// named anchors, comments, metadata) in a per-pdf sidecar json. Public to
// editor_ui (the panes + the sidecar model/session fns it diffs/restores
// against history), the wiki-link autocomplete + hover preview (loadSidecar,
// to resolve %anchor labels), and the export feature (Color/Highlight, to
// bake highlights into a download). The render pipeline, dialogs, hooks, and
// overlay helpers stay internal.

export { PdfViewer } from "./viewer.tsx";
export { PdfMetadataPanel } from "./metadata_panel.tsx";
export type { Color, Highlight } from "../../core/file";
export { emptySidecar, parseSidecar, serializeSidecar } from "../../core/file";
export {
  activeSidecarState,
  loadSidecar,
  updateSidecarSession,
} from "./sidecar/session.ts";
