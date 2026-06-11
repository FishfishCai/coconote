// Env-driven config. Everything is read lazily so importing the bundle
// never throws when COCONOTE_URL / COCONOTE_TOKEN are unset.

const DEFAULT_URL = "http://localhost:40704";

export function baseUrl(): string {
  const raw = process.env.COCONOTE_URL || DEFAULT_URL;
  return raw.replace(/\/+$/, "");
}

/** Empty string when unset. Loopback servers accept that. */
export function token(): string {
  return process.env.COCONOTE_TOKEN || "";
}

/** http -> ws, https -> wss. */
export function wsBaseUrl(): string {
  return baseUrl().replace(/^http/, "ws");
}
