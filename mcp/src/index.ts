// coconote MCP stdio server entry point. Config is read lazily, so this
// module loads fine with COCONOTE_URL / COCONOTE_TOKEN unset. A startup
// probe then fails fast (exit 1, message on stderr) when the configured
// server is unreachable or rejects the token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localVault } from "./api";
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

// stdout carries only the JSON-RPC stream. Bundled deps (pdfjs prints
// its warnings through console.log) must not corrupt it, so route the
// stdout console methods to stderr before serving.
console.log = console.error;
console.info = console.error;

// Fail fast on a bad URL or token before serving: /.health checks
// reachability and identity (it is unauthenticated on the server), the
// vault listing then exercises auth.
try {
  await localVault.health();
  await localVault.listEntries();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`coconote-mcp: startup probe failed: ${msg}\n`);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
