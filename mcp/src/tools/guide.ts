// The get_syntax reference tool: serves the full Coconote convention guides
// (markdown dialect, wikilink syntax, file layout, PDF sidecars).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import markdownFull from "../../guide/markdown.full.md";
import wikilinkFull from "../../guide/wikilink.full.md";
import fileFull from "../../guide/file.full.md";
import pdfFull from "../../guide/pdf.full.md";
import { text } from "./helpers";

const GUIDES: Record<string, string> = {
  markdown: markdownFull,
  wikilink: wikilinkFull,
  file: fileFull,
  pdf: pdfFull,
};

export function registerGuideTools(server: McpServer): void {
  server.registerTool(
    "get_syntax",
    {
      description:
        "Full reference for Coconote conventions: markdown dialect, [[wikilink]] syntax, on-disk " +
        "file layout, or PDF sidecars. Read before writing non-trivial content.",
      inputSchema: { topic: z.enum(["markdown", "wikilink", "file", "pdf"]) },
    },
    async ({ topic }) => text(GUIDES[topic]),
  );
}
