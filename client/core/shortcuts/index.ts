// Shortcuts: the rebindable-action registry (names / labels / defaults +
// combo parse / match / group, design.md Shortcut section) plus the fixed
// reserved zoom combos. Shared contract: the shell dispatcher matches and
// routes, the settings editor lists / rebinds / validates. Imports only
// core/config (down); no editor or feature edge.

export {
  DEFAULT_SHORTCUTS,
  getAllShortcuts,
  groupBindingsByCombo,
  matchShortcut,
  normalizeCombo,
  SHORTCUT_LABELS,
  SHORTCUT_NAMES,
} from "./registry.ts";
export type { ShortcutName } from "./registry.ts";
export { isReservedZoomCombo, zoomDirection } from "./zoom.ts";
