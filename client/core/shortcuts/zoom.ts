// Fixed (non-rebindable) Cmd/Ctrl zoom combos, shared by the keyboard
// dispatcher (shell, which routes them to the active reader) and the
// shortcut recorder (settings, which rejects them so a rebind can't shadow
// zoom). Matched by event.code for layout reliability (Equal also carries
// Shift+Equal i.e. '+'). 1 = in, -1 = out, 0 = reset.
const ZOOM_KEYS: Record<string, 1 | -1 | 0> = {
  Equal: 1,
  NumpadAdd: 1,
  Minus: -1,
  NumpadSubtract: -1,
  Digit0: 0,
  Numpad0: 0,
};

/** True when `ev` is one of the fixed Cmd/Ctrl zoom combos (in / out /
 *  reset). Reserved: the shortcuts recorder rejects them so a rebind can't
 *  shadow zoom into a silently dead binding. */
export function isReservedZoomCombo(ev: KeyboardEvent): boolean {
  return (ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.code in ZOOM_KEYS;
}

/** The zoom direction for a reserved zoom combo (1 in / -1 out / 0 reset),
 *  or null when `ev` is not a zoom combo. */
export function zoomDirection(ev: KeyboardEvent): 1 | -1 | 0 | null {
  return isReservedZoomCombo(ev) ? ZOOM_KEYS[ev.code] : null;
}
