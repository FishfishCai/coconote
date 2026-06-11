// Merge-base lookup for push / pull. Per history.md Merge ("the merge
// base is the content of the local latest push/pull row"): the newest
// local row with save_type push or pull. Queries local history only -
// no remote round-trip.

import { authedFetch } from "./authed_fetch.ts";

export type SaveType = "create" | "edit" | "push" | "pull" | "pin";
export type HistoryRow = { ts: number; save_type: SaveType };

/** Latest push or pull row for `id` - null when no sync has happened yet. */
export async function fetchLocalMergeBase(
  id: string,
): Promise<{ ts: number; content: string } | null> {
  const r = await authedFetch(`/.history/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  const rows: HistoryRow[] = await r.json();
  const sync = rows.find((row) => row.save_type === "push" || row.save_type === "pull");
  if (!sync) return null;
  const c = await authedFetch(
    `/.history/${encodeURIComponent(id)}?ts=${sync.ts}`,
  );
  if (!c.ok) return null;
  return { ts: sync.ts, content: await c.text() };
}
