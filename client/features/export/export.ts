// The Export action (design.md Export shortcut): md pages export as
// self-contained HTML, PDFs export with highlights baked in. Every byte is
// assembled client-side from the existing GET endpoints and saved via
// saveBlobAs - nothing is ever written back, and the same path works for
// local and remote files. There is no separate raw download (design.md:
// pull is the download path). The browser save boundary, file read, and
// the HTML export pipeline live in ./export/*; the pure assembly is in
// export_core.ts (shared with MCP).

import type { SpaceCtx as Client } from "../../core/ctx/space.ts";
import { bakeHighlights } from "./core.ts";
import { basename, pdfSidecarPath } from "../../core/util";
import { saveBlobAs } from "./blob.ts";
import { readVaultFile } from "./vault.ts";

export { saveBlobAs } from "./blob.ts";
export { readVaultFile } from "./vault.ts";
export { exportHtml } from "./html.ts";

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
