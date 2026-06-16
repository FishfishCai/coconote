// Version history tools (history.md): list/preview, restore, pin, and
// delete a single version. All keyed by the page id resolvePageId derives.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "../api";
import { json, PATH_DESC, resolvePageId, text } from "./helpers";

export function registerHistoryTools(server: McpServer): void {
  server.registerTool(
    "page_history",
    {
      description:
        "List a page's version history ([{ts, save_type}]), or with ts return that snapshot's " +
        "text for preview. Works for .md pages and for .pdf pages via their sidecar.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().optional().describe("Snapshot timestamp (ms epoch) to preview"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      if (ts !== undefined) return text(await api.historySnapshot(id, ts));
      return json({ page_id: id, versions: await api.historyList(id) });
    },
  );

  server.registerTool(
    "restore_version",
    {
      description: "Restore a page to a history snapshot. Writes it back and appends a new edit row.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().describe("Snapshot timestamp (ms epoch), from page_history"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      await api.historyRestore(id, ts);
      return text(`Restored ${path} (page ${id}) to snapshot ${ts}.`);
    },
  );

  server.registerTool(
    "pin_version",
    {
      description:
        "Pin the latest version of a page: appends a pin row that retention pruning never " +
        "removes (it can still be deleted explicitly with delete_version).",
      inputSchema: { path: z.string().describe(PATH_DESC) },
    },
    async ({ path }) => {
      const id = await resolvePageId(path);
      await api.historyPin(id);
      return text(`Pinned the latest version of ${path} (page ${id}).`);
    },
  );

  server.registerTool(
    "delete_version",
    {
      description: "Delete a single version row from a page's history.",
      inputSchema: {
        path: z.string().describe(PATH_DESC),
        ts: z.number().int().describe("Snapshot timestamp (ms epoch), from page_history"),
      },
    },
    async ({ path, ts }) => {
      const id = await resolvePageId(path);
      await api.historyDeleteVersion(id, ts);
      return text(`Deleted version ${ts} of ${path} (page ${id}).`);
    },
  );
}
