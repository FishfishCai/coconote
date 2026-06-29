// Public surface of the collab capability: the CRDT / Yjs realtime room
// client (sync, awareness, reconnect). Pure connection - no editor
// dependency. Consumers (md-editor, pdf, sync, shell) import only from
// here; everything else under collab/ is internal. The editor attach
// glue (attachCollab/detachCollab) lives in features/md-editor, which
// imports connectCollab from here (down-only).

export { connectCollab } from "./collab_extension.ts";
export type { CollabHandle, CollabStatus } from "./collab_extension.ts";
