// Sync feature: 3-way merge push/pull against a remote space. The only
// public entry is SyncModal (the push/pull dialog mounted by editor_ui);
// the merge core, per-peer base lookup, and remote-space adapter are
// internal.
export { SyncModal } from "./modal.tsx";
