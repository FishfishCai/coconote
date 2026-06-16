// Tool registration entry point. registerTools wires every domain's tools
// onto the MCP server; the handlers stay thin over api.ts / collab.ts, with
// semantics ported from client/lib (page_ops, include, frontmatter_edit,
// refactor_links, sync_push, sync_pull).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGuideTools } from "./guide";
import { registerHistoryTools } from "./history";
import { registerMediaTools } from "./media";
import { registerPageTools } from "./pages";
import { registerSyncTools } from "./sync";

export function registerTools(server: McpServer): void {
  registerPageTools(server);
  registerMediaTools(server);
  registerHistoryTools(server);
  registerSyncTools(server);
  registerGuideTools(server);
}
