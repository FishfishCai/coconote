// The Export and Download actions (content.md Right-click menu,
// setting.md Shortcut for Export): md pages export as self-contained
// HTML, PDFs export with highlights baked in, Download saves the raw
// bytes untouched. Every byte is assembled client-side from the existing
// GET endpoints and saved via saveBlobAs - nothing is ever written into
// the vault, and the same path works for local and remote files. The
// browser save boundary, vault read, and the HTML export pipeline live in
// ./export/*; the pure assembly is in export_core.ts (shared with MCP).

import type { SpaceCtx as Client } from "../core/ctx/space.ts";
import { bakeHighlights } from "./export_core.ts";
import { basename, pdfSidecarPath } from "./path_url.ts";
import mime from "mime";
import { saveBlobAs } from "./export/blob.ts";
import { readVaultFile } from "./export/vault.ts";

export { saveBlobAs } from "./export/blob.ts";
export { readVaultFile } from "./export/vault.ts";
export { exportHtml } from "./export/html.ts";

/** Download a copy of `pdfName` with its sidecar highlights drawn into
 *  the pages (semi-transparent rects, baked in). */
export async function exportPdfOfPdf(
  client: Client,
  pdfName: string,
): Promise<void> {
  const [pdfData, sidecarData] = await Promise.all([
    readVaultFile(client, pdfName),
    readVaultFile(client, pdfSidecarPath(pdfName)),
  ]);
  if (!pdfData) throw new Error(`read ${pdfName} failed`);
  const bytes = await bakeHighlights(
    pdfData,
    sidecarData ? new TextDecoder().decode(sidecarData) : null,
  );
  await saveBlobAs(
    basename(pdfName),
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
  );
}

/** The Download action (content.md Right-click menu): save the file's
 *  raw bytes as-is, the md source or the original pdf, no rendering or
 *  highlight baking. readVaultFile routes remote rows too. */
export async function downloadRaw(client: Client, path: string): Promise<void> {
  const data = await readVaultFile(client, path);
  if (!data) throw new Error(`read ${path} failed`);
  const type = mime.getType(path) ?? "application/octet-stream";
  await saveBlobAs(basename(path), new Blob([data as BlobPart], { type }));
}
