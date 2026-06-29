// Pull a remote file into the same local file by id (design.md Pull).
// Mirror of sync_push: addressing by id (same id = same file), same merge
// strategy via sync_core.ts, per-peer merge base. The remote body's
// implied assets are mirrored remote -> local for markdown files.

import {
  assetUrl,
  authedFetch,
  fileUrl,
  type HttpSpacePrimitives,
} from "../../core/transport";
import { makeRemoteSpace } from "./remote_space.ts";
import { fetchPeerMergeBase } from "./peer_base.ts";
import { headersToFileMeta } from "../../core/file/index.ts";
import { bodyImpliedAssets } from "../../capabilities/markdown/index.ts";
import { applyOutcome, merge3Strategy } from "./core.ts";

export type PullTarget = { url: string; token?: string };

export type PullOutcome =
  | { kind: "noop" }
  | { kind: "clean" }
  | { kind: "autoMerged" }
  | {
    kind: "conflict";
    baseText: string;
    localText: string;
    remoteText: string;
    remoteLabel: string;
    /** Writes the merged result local-first, mirrors it to the remote,
     *  and records the pull rows (design.md MergeView submit). */
    commitMerged: (merged: Uint8Array) => Promise<void>;
  }
  | { kind: "remoteMissing" };

/** True when the id resolves to a local file. */
async function localOccupied(id: string): Promise<boolean> {
  const r = await authedFetch(fileUrl(id), { method: "HEAD" });
  return r.ok;
}

async function writeLocalPullRow(
  id: string,
  bytes: Uint8Array,
  peer: string,
): Promise<void> {
  const r = await authedFetch(
    `${fileUrl(id)}&save_type=pull&peer=${encodeURIComponent(peer)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    },
  );
  if (!r.ok) throw new Error(`local pull row failed: HTTP ${r.status}`);
}

async function writeLocalAsset(
  id: string,
  asset: string,
  bytes: Uint8Array,
): Promise<void> {
  const r = await authedFetch(assetUrl(id, asset), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  if (!r.ok) throw new Error(`local asset write failed: HTTP ${r.status}`);
}

/** Copy every body-implied asset of the remote md file to the same owner
 *  id locally (design.md). A missing referenced asset is skipped. */
async function pullAssets(
  sp: HttpSpacePrimitives,
  id: string,
  remoteText: string,
): Promise<void> {
  for (const name of bodyImpliedAssets(remoteText)) {
    let data: Uint8Array;
    try {
      ({ data } = await sp.readFile({ id, asset: name }));
    } catch {
      continue;
    }
    await writeLocalAsset(id, name, data);
  }
}

export async function pullRemoteToLocal(
  id: string,
  target: PullTarget,
): Promise<PullOutcome> {
  const sp = makeRemoteSpace(target.url, target.token);
  const remoteLabel = target.url;

  let remoteBytes: Uint8Array;
  let remoteHash: string;
  let isPdf: boolean;
  try {
    const res = await sp.readFile({ id });
    remoteBytes = res.data;
    remoteHash = res.meta.contentHash ?? "";
    isPdf = /pdf/i.test(res.meta.contentType);
  } catch {
    return { kind: "remoteMissing" };
  }
  const remoteText = new TextDecoder().decode(remoteBytes);

  const mirrorAssets = () => pullAssets(sp, id, remoteText);
  const write = async (bytes: Uint8Array, merged: boolean) => {
    await writeLocalPullRow(id, bytes, target.url);
    if (merged) {
      await sp.writeFile({ id }, bytes, { saveType: "pull", peer: target.url });
    }
  };
  const recordOnly = (bytes: Uint8Array) =>
    writeLocalPullRow(id, bytes, target.url);

  // Direct download (design.md Pull): no local file for this id yet.
  if (!(await localOccupied(id))) {
    if (!isPdf) await mirrorAssets();
    await writeLocalPullRow(id, remoteBytes, target.url);
    return { kind: "clean" };
  }

  const localResp = await authedFetch(fileUrl(id));
  if (!localResp.ok) {
    throw new Error(`local read failed: HTTP ${localResp.status}`);
  }
  const localBytes = new Uint8Array(await localResp.arrayBuffer());
  const localHash = headersToFileMeta(id, localResp.headers)?.contentHash ?? "";
  const localText = new TextDecoder().decode(localBytes);
  const baseText = await fetchPeerMergeBase(id, target.url);

  // For pull, the target we write INTO is local, the source is remote.
  const decision = merge3Strategy(
    remoteText,
    remoteHash,
    localText,
    localHash,
    baseText,
  );

  const applied = await applyOutcome(decision, {
    mirrorAssets,
    write,
    sourceBytes: remoteBytes,
    recordOnly,
    isPdf,
  });

  if (applied.kind === "conflict") {
    return {
      kind: "conflict",
      baseText: applied.baseText,
      localText: applied.targetText,
      remoteText: applied.sourceText,
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
