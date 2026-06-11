// "Include in Coconote" actions for content.md right-click on
// non-admitted files. Md path -> flip `coconote: true` in frontmatter
// (or create one if missing). Pdf path -> write a sidecar with
// coconote:true in `metadata` (file.md + pdf.md sidecar shape).

import { authedFetch } from "./authed_fetch.ts";
import { fileUrl } from "../spaces/constants.ts";
import { setFrontmatterKey } from "./frontmatter_edit.ts";
import { newPageId } from "./id.ts";
import { pdfStem } from "./path_url.ts";
import { saveSidecar, sidecarPath, type PdfSidecar } from "../pdf/notes_client.ts";

export async function includeMarkdown(path: string): Promise<void> {
  const r = await authedFetch(fileUrl(path));
  const body = r.ok
    ? setFrontmatterKey(await r.text(), "coconote", "true")
    : "---\ncoconote: true\n---\n";
  const put = await authedFetch(fileUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
}

async function includePdf(pdfPath: string): Promise<void> {
  const sc = sidecarPath(pdfPath);
  // Existing sidecar -> flip the flag in place, preserving id/title/tags.
  // Only treat 404 as "no sidecar" - network errors surface to the caller
  // so a transient outage doesn't silently overwrite an existing sidecar.
  const r = await authedFetch(fileUrl(sc));
  if (r.ok) {
    const cur = (await r.json()) as PdfSidecar;
    cur.metadata.coconote = true;
    await saveSidecar(pdfPath, cur);
    return;
  }
  if (r.status !== 404) {
    throw new Error(`include pdf ${pdfPath}: GET ${r.status}`);
  }
  // Fresh sidecar: must carry a non-empty id, otherwise the server
  // skips history rows for the PDF (fs.rs record_history L220).
  // Title defaults to the basename (file.md sidecar contract).
  const stem = pdfStem(pdfPath);
  const fallback: PdfSidecar = {
    metadata: {
      id: newPageId(),
      coconote: true,
      title: stem,
      tag: [],
    },
    highlights: [],
    anchors: [],
    comments: [],
  };
  await saveSidecar(pdfPath, fallback);
}

/** Paths of every supported file the ?all=1 listing marks excluded
 *  (coconote:false). Feeds the content browser's grey-row set and the
 *  folder-menu bulk include. */
export async function fetchExcludedPaths(): Promise<string[]> {
  const r = await authedFetch("/.file?all=1");
  if (!r.ok) throw new Error(`list all: HTTP ${r.status}`);
  const list = (await r.json()) as Array<{
    type: string;
    path: string;
    coconote?: boolean;
  }>;
  return list
    .filter((e) => e.type === "file" && e.coconote === false)
    .map((e) => e.path);
}

export async function includePath(path: string): Promise<void> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) {
    await includeMarkdown(path);
    return;
  }
  if (lower.endsWith(".pdf")) {
    await includePdf(path);
    return;
  }
  throw new Error(`Unsupported file type: ${path}`);
}
