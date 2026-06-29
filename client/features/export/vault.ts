// Read a file's bytes for export, addressed by loopback OS path (the
// desktop export path; remote export is a next-phase concern).

import { notFoundError } from "coconote/constants";
import type { SpaceCtx as Client } from "../../core/ctx/space.ts";

/** Read a file's bytes by loopback path. Returns null when the file can't
 *  be fetched. */
export async function readVaultFile(
  client: Client,
  path: string,
): Promise<Uint8Array | null> {
  try {
    return (await client.space.spacePrimitives.readFile({ path })).data;
  } catch (e) {
    if (e !== notFoundError) console.warn(`Export: read ${path} failed`, e);
    return null;
  }
}
