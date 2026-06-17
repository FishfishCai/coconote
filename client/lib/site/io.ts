// The small IO interface buildSiteFiles runs over (content.md Export Site),
// kept DOM-free and context-free so the client wrapper (lib/site_export.ts)
// and a future MCP tool can share the assembly.

import type { PageMeta } from "coconote/type/page";

export type SiteIo = {
  /** The live page listing - the same PageMeta array the app resolves
   *  wikilinks against (client: ui.viewState.allPages, mcp: derived
   *  from one /.file listing like mcp/src/export.ts loadPageContext). */
  listPages(): readonly PageMeta[] | Promise<readonly PageMeta[]>;
  /** Vault file bytes by fs path, null when unfetchable (the page is
   *  then skipped, the export keeps going). */
  readFile(path: string): Promise<Uint8Array | null>;
  /** A built client asset by `/.client`-relative path ("site.css",
   *  "fonts/x.woff2"), null when the server doesn't have it. */
  fetchAsset(path: string): Promise<string | Uint8Array | null>;
  /** Mirrors the client's shortWikiLinks config (mcp keeps the default). */
  shortWikiLinks?: boolean;
};

export type SiteProgress = (done: number, total: number) => void;

export type SiteFiles = {
  /** Zip entry path -> content. Strings are UTF-8 text files. */
  files: Map<string, string | Uint8Array>;
  /** Vault paths of pages whose bytes could not be fetched. */
  skipped: string[];
};
