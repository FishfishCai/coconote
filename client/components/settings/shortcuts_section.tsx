// setting.md Shortcut: rebindable navigation/mode/panel actions. The
// keydown handler re-reads per event so rebinds apply immediately. A
// conflict (duplicate combo or unparseable input) highlights red AND
// blocks persistence until the user rebinds the offending pair.

import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientContext as Client } from "../../core/context.ts";
import {
  DEFAULT_SHORTCUTS,
  groupBindingsByCombo,
  getAllShortcuts,
  normalizeCombo,
  SHORTCUT_LABELS,
  SHORTCUT_NAMES,
  type ShortcutName,
} from "../../lib/shortcuts.ts";

function comboFromKeyboardEvent(ev: KeyboardEvent): string | null {
  const k = ev.key;
  if (k === "Meta" || k === "Shift" || k === "Control" || k === "Alt") {
    return null;
  }
  const parts: string[] = [];
  if (ev.metaKey || ev.ctrlKey) parts.push("Mod");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.altKey) parts.push("Alt");
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}

export function ShortcutsSection({ client }: { client: Client }) {
  const [bindings, setBindings] = useState<Record<ShortcutName, string>>(
    () => getAllShortcuts(),
  );
  const [recording, setRecording] = useState<ShortcutName | null>(null);

  // Persist only when the binding set is well-formed AND conflict-free:
  // two actions sharing a combo would silently override one of them,
  // so block until the user fixes the clash.
  useEffect(() => {
    const normalized: Record<ShortcutName, string> = { ...bindings };
    for (const n of SHORTCUT_NAMES) {
      const norm = normalizeCombo(normalized[n]);
      if (!norm) return; // malformed -> don't persist
      normalized[n] = norm;
    }
    const grouped = groupBindingsByCombo(normalized);
    for (const list of grouped.values()) {
      if (list.length > 1) return; // duplicate combo -> don't persist
    }
    // Persist through setUiOption (the ONE userPrefs writer) so a later
    // settings change can't clobber the rebinds with a stale copy.
    client.setUiOption("shortcuts", normalized);
  }, [bindings]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Escape cancels recording instead of binding the Escape key.
      if (ev.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = comboFromKeyboardEvent(ev);
      if (!combo) return;
      setBindings((prev) => ({ ...prev, [recording]: combo }));
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const conflicts = useMemo(
    () => groupBindingsByCombo(bindings),
    [bindings],
  );
  const conflicting = new Set<ShortcutName>();
  for (const list of conflicts.values()) {
    if (list.length > 1) for (const n of list) conflicting.add(n);
  }
  const malformed = SHORTCUT_NAMES.filter((n) => !normalizeCombo(bindings[n]));

  const onResetOne = (name: ShortcutName) => {
    setBindings((prev) => ({ ...prev, [name]: DEFAULT_SHORTCUTS[name] }));
  };

  return (
    <section>
      <h2>Shortcuts</h2>
      <p className="coconote-settings-hint">
        Click a binding to record a new key combination. `Mod` = Cmd on
        macOS, Ctrl elsewhere. Markdown-editing keys (Tab / Enter /
        Backspace) and system shortcuts use the defaults and cannot be
        rebound.
      </p>
      <div className="coconote-shortcuts-list">
        {SHORTCUT_NAMES.map((name) => {
          const isRecording = recording === name;
          const hasConflict = conflicting.has(name);
          const isBad = malformed.includes(name);
          return (
            <div key={name} className="coconote-shortcut-row">
              <label>{SHORTCUT_LABELS[name]}</label>
              <button
                type="button"
                className={"coconote-shortcut-combo" +
                  (isRecording ? " recording" : "") +
                  (hasConflict || isBad ? " clash" : "")}
                onClick={() => setRecording(isRecording ? null : name)}
                title={hasConflict
                  ? "Duplicate binding — rebind the other action to clear it"
                  : ""}
              >
                {isRecording ? "Press keys…" : bindings[name]}
              </button>
              <button
                type="button"
                className="coconote-shortcut-reset"
                onClick={() => onResetOne(name)}
                title="Reset to default"
              >
                ↺
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
