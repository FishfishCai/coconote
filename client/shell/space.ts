import type { FileKind, FileMeta, PageMeta } from "coconote/type/page";
import type { HttpSpacePrimitives } from "../core/transport";
import { isMarkdownPath } from "../core/util";

/** Derive the viewer kind from the content type, or the path hint when the
 *  content type is unhelpful. */
export function kindFromMeta(contentType: string, path?: string): FileKind {
  if (/pdf/i.test(contentType)) return "pdf";
  if (path && !isMarkdownPath(path)) {
    return path.toLowerCase().endsWith(".pdf") ? "pdf" : "md";
  }
  return "md";
}

// File access by id. `.md` pages flow through readPage / writePage; the
// owning id is the X-Id header the server stamps on every response.
export class Space {
  constructor(readonly spacePrimitives: HttpSpacePrimitives) {}

  async readPage(
    id: string,
    pathHint?: string,
  ): Promise<{ text: string; meta: PageMeta }> {
    const pageData = await this.spacePrimitives.readFile({ id });
    return {
      text: new TextDecoder().decode(pageData.data),
      meta: fileMetaToPageMeta(pageData.meta, id, pathHint),
    };
  }

  async writePage(
    id: string,
    text: string,
    ifUnmodifiedSince?: number,
    pathHint?: string,
  ): Promise<PageMeta> {
    const meta = await this.spacePrimitives.writeFile(
      { id },
      new TextEncoder().encode(text),
      { ifUnmodifiedSince },
    );
    return fileMetaToPageMeta(meta, id, pathHint);
  }
}

export function fileMetaToPageMeta(
  fileMeta: FileMeta,
  fallbackId: string,
  pathHint?: string,
): PageMeta {
  return {
    id: fileMeta.id ?? fallbackId,
    path: pathHint,
    kind: kindFromMeta(fileMeta.contentType, pathHint),
    created: new Date(fileMeta.created).toISOString(),
    lastModified: new Date(fileMeta.lastModified).toISOString(),
    perm: fileMeta.perm,
    contentHash: fileMeta.contentHash,
  };
}
