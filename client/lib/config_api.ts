// Thin wrappers for the GET /.config and PATCH /.config endpoints. The
// settings UI reaches for these from multiple sections (Pages, Remote
// Vaults, Snippets) so they live one level up instead of being
// duplicated per file.

import { authedFetch } from "./authed_fetch.ts";

export type CoconoteConfig = {
  root?: Record<string, string>;
  url?: string[];
  snippets?: string;
  /** Directory holding `coconote.yaml`. setting.md Config file. */
  configDir?: string;
};

export async function getConfig(): Promise<CoconoteConfig> {
  const res = await authedFetch("/.config");
  if (!res.ok) throw new Error(`GET /.config -> ${res.status}`);
  return res.json();
}

export async function patchConfig(body: unknown): Promise<void> {
  const res = await authedFetch("/.config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `PATCH /.config -> ${res.status}`);
  }
}
