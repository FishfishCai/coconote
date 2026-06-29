// Push a local file to a remote instance (design.md Push).
//
// Addressing is by id: the same id is the same file across instances (the
// pairing key). Synced CONTENT is the file by id (md body / pdf bytes). An
// md file's body-implied assets (the images its `![[...]]` embeds
// reference) are mirrored alongside, addressed by `?id=<owner>&asset=`.
// Merge base = the latest local push/pull row's content for THIS peer
// (design.md Merge), stamped on the local rows via ?peer=.
//
// Outcomes:
//   "noop"          - bytes already identical (still records a push row)
//   "clean"         - remote unchanged since base, write goes through
//   "autoMerged"    - both sides moved, diff3 merged without conflict
//   "conflict"      - UI pops MergeView, commits via `commitMerged`
//   "remoteMissing" - target unreachable / source missing

import {
  assetUrl,
  authedFetch,
  fileUrl,
  type HttpSpacePrimitives,
} from "../../core/transport";
import { notFoundError } from "../../core/util";
import { makeRemoteSpace } from "./remote_space.ts";
import { headersToFileMeta } from "../../core/file/index.ts";
import { fetchPeerMergeBase } from "./peer_base.ts";
import { bodyImpliedAssets } from "../../capabilities/markdown/index.ts";
import { applyOutcome, merge3Strategy } from "./core.ts";

export type PushOutcome =
  | { kind: "noop" }
  | { kind: "clean" }
  | { kind: "autoMerged" }
  | {
    kind: "conflict";
    baseText: string;
    localText: string;
    remoteText: string;
    remoteLabel: string;
    /** Writes the merged result remote-first, mirrors it locally, and
     *  records the push rows (design.md MergeView submit). */
    commitMerged: (merged: Uint8Array) => Promise<void>;
  }
  | { kind: "remoteMissing" };

/** Push target: a URL from the config `url` list, with an optional token. */
export type PushTarget = { url: string; token?: string };

async function readLocal(
  id: string,
): Promise<{ bytes: Uint8Array; hash: string; isPdf: boolean } | null> {
  const resp = await authedFetch(fileUrl(id));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`read ${id}: HTTP ${resp.status}`);
  const meta = headersToFileMeta(id, resp.headers);
  return {
    bytes: new Uint8Array(await resp.arrayBuffer()),
    hash: meta?.contentHash ?? "",
    isPdf: /pdf/i.test(meta?.contentType ?? resp.headers.get("Content-Type") ?? ""),
  };
}

async function readLocalAsset(id: string, asset: string): Promise<Uint8Array | null> {
  const resp = await authedFetch(assetUrl(id, asset));
  if (!resp.ok) return null;
  return new Uint8Array(await resp.arrayBuffer());
}

// Mirror the synced bytes back to the local file with save_type=push and
// ?peer= so the per-peer merge base advances (design.md Merge).
async function recordLocalPushRow(
  id: string,
  bytes: Uint8Array,
  peer: string,
): Promise<void> {
  const r = await authedFetch(
    `${fileUrl(id)}&save_type=push&peer=${encodeURIComponent(peer)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    },
  );
  if (!r.ok) throw new Error(`local push row failed: HTTP ${r.status}`);
}

/** Copy every body-implied asset of the local md file to the same owner id
 *  on the remote (design.md: a file's set = md body + the images it
 *  embeds). A missing referenced asset is skipped. */
async function pushAssets(
  id: string,
  mdText: string,
  sp: HttpSpacePrimitives,
): Promise<void> {
  for (const name of bodyImpliedAssets(mdText)) {
    const bytes = await readLocalAsset(id, name);
    if (!bytes) continue;
    await sp.writeFile({ id, asset: name }, bytes);
  }
}

export async function pushLocalToRemote(
  id: string,
  target: PushTarget,
): Promise<PushOutcome> {
  const local = await readLocal(id);
  if (!local) return { kind: "remoteMissing" };
  const isPdf = local.isPdf;
  const localText = new TextDecoder().decode(local.bytes);

  const sp = makeRemoteSpace(target.url, target.token);
  const remoteLabel = target.url;

  const mirrorAssets = () => pushAssets(id, localText, sp);
  const write = async (bytes: Uint8Array, _merged: boolean) => {
    await sp.writeFile({ id }, bytes, { saveType: "push", peer: target.url });
    await recordLocalPushRow(id, bytes, target.url);
  };
  const recordOnly = (bytes: Uint8Array) =>
    recordLocalPushRow(id, bytes, target.url);

  let remoteData: Uint8Array;
  let remoteHash: string;
  try {
    const r = await sp.readFile({ id });
    remoteData = r.data;
    remoteHash = r.meta.contentHash ?? "";
  } catch (e: unknown) {
    // Only a genuine 404 means "no remote file yet" -> direct upload.
    if (e !== notFoundError) throw e;
    if (!isPdf) await mirrorAssets();
    await write(local.bytes, false);
    return { kind: "clean" };
  }

  const remoteText = new TextDecoder().decode(remoteData);
  const baseText = await fetchPeerMergeBase(id, target.url);

  const decision = merge3Strategy(
    localText,
    local.hash,
    remoteText,
    remoteHash,
    baseText,
  );

  const applied = await applyOutcome(decision, {
    mirrorAssets,
    write,
    recordOnly,
    sourceBytes: local.bytes,
    isPdf,
  });

  if (applied.kind === "conflict") {
    return {
      kind: "conflict",
      baseText: applied.baseText,
      localText: applied.sourceText,
      remoteText: applied.targetText,
      remoteLabel,
      commitMerged: async (merged: Uint8Array) => {
        if (!isPdf) await mirrorAssets();
        await write(merged, true);
      },
    };
  }
  if (applied.kind === "noop") return { kind: "noop" };
  return { kind: applied.kind };
}
