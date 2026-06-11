// Single home for the localStorage user-prefs blob (UI options + custom
// shortcuts). Centralizes the key so a typo can't silently desync the
// readers in boot / shortcuts from the writer in client.

import { safeJsonParse } from "./json.ts";

export const USER_PREFS_KEY = "coconote.userPrefs";

/** Parsed prefs object, or {} when missing / malformed. */
export function readUserPrefs(): Record<string, unknown> {
  const raw = localStorage.getItem(USER_PREFS_KEY);
  return (raw && safeJsonParse<Record<string, unknown>>(raw)) || {};
}

export function writeUserPrefs(prefs: unknown): void {
  localStorage.setItem(USER_PREFS_KEY, JSON.stringify(prefs));
}
