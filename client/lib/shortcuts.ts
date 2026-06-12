// Canonical "Mod+Shift+H" combos (Mod = Cmd on macOS, Ctrl elsewhere).
// Defaults merged with localStorage prefs at lookup time, so Settings
// edits take effect without reloading. setting.md Shortcut.

import { readUserPrefs, userPrefsVersion } from "./user_prefs.ts";

export const SHORTCUT_NAMES = [
  "modeSwitch",
  "historyOpen",
  "pinVersion",
  "pdfMetadataPanel",
  "exportPdf",
  "exportHtml",
  "backPrev",
  "forwardNext",
  "backToContent",
  "openSettings",
] as const;
export type ShortcutName = (typeof SHORTCUT_NAMES)[number];

export const SHORTCUT_LABELS: Record<ShortcutName, string> = {
  modeSwitch: "Cycle render / source / read",
  historyOpen: "Open version history panel",
  pinVersion: "Pin current version",
  pdfMetadataPanel: "Open PDF metadata panel",
  exportPdf: "Export PDF",
  exportHtml: "Export HTML",
  backPrev: "Back to previous page",
  forwardNext: "Forward to next page",
  backToContent: "Open Content",
  openSettings: "Open Setting",
};

export const DEFAULT_SHORTCUTS: Record<ShortcutName, string> = {
  modeSwitch: "Mod+M",
  historyOpen: "Mod+Shift+H",
  pinVersion: "Mod+Shift+P",
  pdfMetadataPanel: "Mod+Shift+M",
  exportPdf: "Mod+Shift+E",
  exportHtml: "Mod+Shift+X",
  backToContent: "Mod+Shift+C",
  backPrev: "Mod+Shift+B",
  forwardNext: "Mod+Shift+F",
  openSettings: "Mod+Shift+S",
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
  const s = readUserPrefs().shortcuts;
  return s && typeof s === "object"
    ? s as Partial<Record<ShortcutName, string>>
    : {};
}

// matchShortcut runs per keydown (one lookup per action), and readUserPrefs
// is localStorage + JSON.parse: cache the parsed Combo table and
// rebuild only when writeUserPrefs bumped the version.
let comboCache: Record<ShortcutName, Combo> | null = null;
let comboCacheVersion = -1;

/** Parsed Combo for `name`: the user binding when it parses, else the
 *  default (DEFAULT_SHORTCUTS literals always parse). */
function resolvedCombo(name: ShortcutName): Combo {
  if (!comboCache || comboCacheVersion !== userPrefsVersion) {
    const user = readUserShortcuts();
    comboCache = {} as Record<ShortcutName, Combo>;
    comboCacheVersion = userPrefsVersion;
    for (const n of SHORTCUT_NAMES) {
      const userCombo = user[n];
      comboCache[n] = (userCombo ? parseCombo(userCombo) : null) ??
        parseCombo(DEFAULT_SHORTCUTS[n])!;
    }
  }
  return comboCache[name];
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
 *  Mod is the PLATFORM modifier (Cmd on macOS, Ctrl elsewhere). The
 *  other one must be up so Ctrl+Shift+P doesn't pin on macOS. */
export function matchShortcut(ev: KeyboardEvent, name: ShortcutName): boolean {
  const combo = resolvedCombo(name);
  const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;
  const otherMod = IS_MAC ? ev.ctrlKey : ev.metaKey;
  if (combo.mod !== mod || otherMod) return false;
  if (combo.shift !== ev.shiftKey) return false;
  if (combo.alt !== ev.altKey) return false;
  return ev.key.toLowerCase() === combo.key;
}

/** Groups bindings by normalised combo string. Entries with more than
 *  one name share a key combo, callers (Settings) filter accordingly. */
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
