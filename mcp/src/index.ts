// coconote MCP stdio server entry point. Config is read lazily, so this
// module loads fine with COCONOTE_URL / COCONOTE_TOKEN unset.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools";
import markdownShort from "../guide/markdown.short.md";
import wikilinkShort from "../guide/wikilink.short.md";
import fileShort from "../guide/file.short.md";
import pdfShort from "../guide/pdf.short.md";

const PREAMBLE = `Coconote vault access.

- Vault paths are root-prefixed: main/notes/foo.md, not notes/foo.md or /notes/foo.md.
- Markdown files keep their .md extension in paths. PDFs pair with a hidden
  .<stem>.json sidecar next to them that holds metadata and annotations.
- Never invent, change, or drop the frontmatter id (or sidecar metadata.id).
  The server assigns ids and keys version history by them.
- Prefer edit_page (targeted replacements) over write_page (full rewrite).
- Exception: to edit a sidecar .json, read it, modify the JSON, and write_page
  the full result. Do not edit_page string-match JSON (formatting across
  writers is unstable).
- When an edit_page old_str fails to match, re-read the page with read_page
  and retry with the exact current text.
- get_syntax(topic) returns the full syntax references.`;

const server = new McpServer(
  { name: "coconote", version: "0.1.0" },
  {
    instructions: [PREAMBLE, markdownShort, wikilinkShort, fileShort, pdfShort].join("\n\n"),
  },
);

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
