// Merge-base lookup for push / pull. Per design.md Merge: the merge base
// is the content of the latest local push/pull row for THAT peer. The
// server exposes it directly via GET /.history?id=&peer=<url> (empty body
// when never synced with that peer). History is addressed by id.

import { authedFetch, historyUrl } from "../../core/transport";

export type SaveType = "create" | "edit" | "push" | "pull" | "keep";
export type HistoryRow = { ts: number; save_type: SaveType; peer?: string };

/** The 3-way merge base for `id` against `peerUrl`: the content of the
 *  latest push/pull row stamped with that peer. Empty string when no sync
 *  has happened with the peer yet. */
export async function fetchPeerMergeBase(
  id: string,
  peerUrl: string,
): Promise<string> {
  const r = await authedFetch(
    historyUrl(id, `&peer=${encodeURIComponent(peerUrl)}`),
  );
  if (!r.ok) return "";
  return await r.text();
}
