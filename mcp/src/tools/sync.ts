// Cross-vault sync tools (history.md Push / Pull): push a local page to a
// remote server, or pull a remote page into a local root. Thin wrappers over
// sync/push and sync/pull, which return the structured merge outcome.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pushPage } from "../sync/push";
import { pullPage } from "../sync/pull";
import { json, PATH_DESC } from "./helpers";

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    "push_page",
    {
      description:
        "Push a local page to another Coconote server (history.md Push). Same-id remote pages " +
        "fast-forward or merge (base = the last push/pull row). Returns a structured outcome: " +
        "on pathCollision re-call with overwrite: true, on conflict merge the returned " +
        "baseText/localText/remoteText yourself and re-call with merged_content.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        target_url: z.string().describe("Base URL of the target server, e.g. http://host:40704"),
        target_root: z.string().describe("Root name on the target where a NEW file lands"),
        target_token: z.string().optional().describe("Target server auth token (required off-loopback)"),
        overwrite: z.boolean().optional().describe("Confirm overwriting a pathCollision occupant"),
        merged_content: z.string().optional().describe("Resolved full text after a conflict outcome"),
      },
    },
    async ({ path, target_url, target_root, target_token, overwrite, merged_content }) =>
      json(
        await pushPage({
          path,
          targetUrl: target_url,
          targetRoot: target_root,
          targetToken: target_token,
          overwrite,
          mergedContent: merged_content,
        }),
      ),
  );

  server.registerTool(
    "pull_page",
    {
      description:
        "Pull a page from another Coconote server into a local root (history.md Pull, the " +
        "mirror of push_page). Same-id local pages fast-forward or merge. Returns a structured " +
        "outcome: on pathCollision re-call with overwrite: true, on conflict merge the returned " +
        "texts yourself and re-call with merged_content.",
      inputSchema: {
        remote_url: z.string().describe("Base URL of the remote server, e.g. http://host:40704"),
        remote_path: z.string().describe("Path on the remote, root-prefixed, e.g. work/notes/foo.md"),
        target_root: z.string().describe("Local root name where a NEW file lands"),
        remote_token: z.string().optional().describe("Remote server auth token (required off-loopback)"),
        overwrite: z.boolean().optional().describe("Confirm overwriting a pathCollision occupant"),
        merged_content: z.string().optional().describe("Resolved full text after a conflict outcome"),
      },
    },
    async ({ remote_url, remote_path, target_root, remote_token, overwrite, merged_content }) =>
      json(
        await pullPage({
          remoteUrl: remote_url,
          remotePath: remote_path,
          targetRoot: target_root,
          remoteToken: remote_token,
          overwrite,
          mergedContent: merged_content,
        }),
      ),
  );
}
