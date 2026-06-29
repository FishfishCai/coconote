// Public surface of the md-editor feature: the CodeMirror editing engine
// (state assembly, mode reconfigure, the construct plugins, snippets) plus
// the collab editor-attach glue. The shell composition root and content
// manager drive the editor through these; everything else under
// md-editor/ is internal. Builds DOWN on capabilities/{markdown,links,
// collab} + core - never imports another feature.

export {
  createEditorState,
  externalUpdate,
  rebuildEditorState,
  reconfigureLanguage,
} from "./editor_state.ts";
export { reconfigureMode } from "./registry.ts";
export { diffAndPrepareChanges } from "./util/cm_util.ts";
// Editor glue that wires a collab room (capabilities/collab) into the view.
export { attachCollab, detachCollab } from "./attach_to_editor.ts";
