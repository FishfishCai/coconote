// Canonical "Mod+Shift+H" combos (Mod = Cmd on macOS, Ctrl elsewhere).
// Defaults merged with localStorage prefs at lookup time, so Settings
// edits take effect without reloading. setting.md §Shortcut.

export const SHORTCUT_NAMES = [
  "modeSwitch",
  "historyOpen",
  "pinVersion",
  "pdfMetadataPanel",
  "backToContent",
  "backPrev",
] as const;
export type ShortcutName = (typeof SHORTCUT_NAMES)[number];

export const SHORTCUT_LABELS: Record<ShortcutName, string> = {
  modeSwitch: "Cycle render / source / read",
  historyOpen: "Open version history panel",
  pinVersion: "Pin current version",
  pdfMetadataPanel: "Open PDF metadata panel",
  backToContent: "Back to Content page",
  backPrev: "Back to previous page",
};

export const DEFAULT_SHORTCUTS: Record<ShortcutName, string> = {
  modeSwitch: "Mod+M",
  historyOpen: "Mod+Shift+H",
  pinVersion: "Mod+Shift+P",
  pdfMetadataPanel: "Mod+Shift+M",
  backToContent: "Mod+Shift+C",
  backPrev: "Mod+Shift+B",
};

type Combo = {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
};

function parseCombo(s: string): Combo | null {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const c: Combo = { mod: false, shift: false, alt: false, key: "" };
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "ctrl") c.mod = true;
    else if (lower === "shift") c.shift = true;
    else if (lower === "alt" || lower === "option") c.alt = true;
    else {
      if (c.key) return null;
      c.key = lower;
    }
  }
  if (!c.key) return null;
  return c;
}

/** Returns canonical form like "Mod+Shift+H" or null if unparseable. */
export function normalizeCombo(s: string): string | null {
  const c = parseCombo(s);
  if (!c) return null;
  return formatCombo(c);
}

function formatCombo(c: Combo): string {
  const parts: string[] = [];
  if (c.mod) parts.push("Mod");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return parts.join("+");
}

function readUserShortcuts(): Partial<Record<ShortcutName, string>> {
  try {
    const raw = localStorage.getItem("coconote.userPrefs");
    if (!raw) return {};
    const prefs = JSON.parse(raw);
    const s = prefs?.shortcuts;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function getShortcut(name: ShortcutName): string {
  const user = readUserShortcuts();
  const combo = user[name] ?? DEFAULT_SHORTCUTS[name];
  return normalizeCombo(combo) ?? DEFAULT_SHORTCUTS[name];
}

export function getAllShortcuts(): Record<ShortcutName, string> {
  const out = { ...DEFAULT_SHORTCUTS };
  const user = readUserShortcuts();
  for (const n of SHORTCUT_NAMES) {
    const v = user[n];
    if (v) {
      const norm = normalizeCombo(v);
      if (norm) out[n] = norm;
    }
  }
  return out;
}

const IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** Returns true when the keyboard event matches the named shortcut.
 *  Mod is the PLATFORM modifier (Cmd on macOS, Ctrl elsewhere); the
 *  other one must be up so Ctrl+Shift+P doesn't pin on macOS. */
export function matchShortcut(ev: KeyboardEvent, name: ShortcutName): boolean {
  const combo = parseCombo(getShortcut(name));
  if (!combo) return false;
  const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;
  const otherMod = IS_MAC ? ev.ctrlKey : ev.metaKey;
  if (combo.mod !== mod || otherMod) return false;
  if (combo.shift !== ev.shiftKey) return false;
  if (combo.alt !== ev.altKey) return false;
  return ev.key.toLowerCase() === combo.key;
}

/** Groups bindings by normalised combo string. Entries with more than
 *  one name share a key combo; callers (Settings) filter accordingly. */
export function groupBindingsByCombo(
  bindings: Record<ShortcutName, string>,
): Map<string, ShortcutName[]> {
  const m = new Map<string, ShortcutName[]>();
  for (const name of SHORTCUT_NAMES) {
    const norm = normalizeCombo(bindings[name]);
    if (!norm) continue;
    const list = m.get(norm) ?? [];
    list.push(name);
    m.set(norm, list);
  }
  return m;
}
