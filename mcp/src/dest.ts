// Destination-path helper for the download_page tool: validate an
// absolute host path, create the parent directory, and write the bytes.
// Deliberately renderer-free (no client imports), so the bundle that
// reaches download_page stays lightweight.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

/** Write output to an absolute path on the MCP host, creating the parent
 *  directory when missing. Returns the byte size. */
export async function writeDest(dest: string, data: string | Uint8Array): Promise<number> {
  if (!isAbsolute(dest)) {
    throw new Error(
      `dest must be an absolute file path on the machine running the MCP server, got: ${dest}`,
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}
