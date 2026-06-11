// "Include in Coconote" actions for content.md right-click on
// non-admitted files. Md path → flip `coconote: true` in frontmatter
// (or create one if missing). Pdf path → write a sidecar with
// coconote:true in `metadata` (file.md + pdf.md sidecar shape).

import { authedFetch } from "./authed_fetch.ts";
import { encodePathSegments } from "./path_url.ts";
import { setFrontmatterKey } from "./frontmatter_edit.ts";
import { newPageId } from "./id.ts";
import { saveSidecar, sidecarPath, type PdfSidecar } from "../pdf/notes_client.ts";

function enc(p: string): string {
  return encodePathSegments(p);
}

export async function includeMarkdown(path: string): Promise<void> {
  const r = await authedFetch(`/.file/${enc(path)}`);
  const body = r.ok
    ? setFrontmatterKey(await r.text(), "coconote", "true")
    : "---\ncoconote: true\n---\n";
  const put = await authedFetch(`/.file/${enc(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
}

export async function includePdf(pdfPath: string): Promise<void> {
  const sc = sidecarPath(pdfPath);
  // Existing sidecar → flip the flag in place, preserving id/title/tags.
  // Only treat 404 as "no sidecar"; network errors surface to the caller
  // so a transient outage doesn't silently overwrite an existing sidecar.
  const r = await authedFetch(`/.file/${enc(sc)}`);
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
  const slash = pdfPath.lastIndexOf("/");
  const base = slash >= 0 ? pdfPath.slice(slash + 1) : pdfPath;
  const stem = base.replace(/\.pdf$/i, "");
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
