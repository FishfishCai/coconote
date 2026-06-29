// Config + prefs: thin wrappers over GET / PATCH /.config (urls, recent,
// pin, watch) and the localStorage user-prefs blob.

export {
  addUrl,
  addWatch,
  getConfig,
  patchConfig,
  removeUrl,
  removeWatch,
} from "./config_api.ts";
export type {
  CoconoteConfig,
  ConfigEntry,
  ConfigPatch,
  ConfigUrl,
} from "./config_api.ts";
export {
  readUserPrefs,
  USER_PREFS_KEY,
  userPrefsVersion,
  writeUserPrefs,
} from "./user_prefs.ts";
