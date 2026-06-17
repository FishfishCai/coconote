// Read a vault file's bytes for export, routing `@<label>/` paths to the
// matching remote space. Shared by the page exports and the site export.

import { notFoundError } from "coconote/constants";
import type { ClientContext as Client } from "../../core/context.ts";
import { getRemoteSpaceByLabel, parseRemotePath } from "../remote_index.ts";

/** Read a vault file's bytes, routing `@<label>/` paths to the matching
 *  remote space. Returns null when the file can't be fetched. */
export async function readVaultFile(
  client: Client,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const remote = parseRemotePath(path);
    if (remote) {
      const r = getRemoteSpaceByLabel(remote.label);
      if (!r) return null;
      return (await r.sp.readFile(remote.rest)).data;
    }
    return (await client.space.spacePrimitives.readFile(path)).data;
  } catch (e) {
    if (e !== notFoundError) console.warn(`Export: read ${path} failed`, e);
    return null;
  }
}
