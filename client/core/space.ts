import type {
  FileMeta,
  PageMeta,
  PageOrigin,
} from "coconote/type/page";
import type { HttpSpacePrimitives } from "../spaces/http_space_primitives.ts";
import {
  getRemoteSpaceByLabel,
  parseRemotePath,
} from "../lib/remote_index.ts";

// `.md` pages only.
export class Space {
  constructor(readonly spacePrimitives: HttpSpacePrimitives) {}

  async readPage(name: string): Promise<{ text: string; meta: PageMeta }> {
    const remote = parseRemotePath(name);
    if (remote) {
      const r = getRemoteSpaceByLabel(remote.label);
      if (!r) throw new Error(`Remote vault '${remote.label}' not configured`);
      const pd = await r.sp.readFile(`${remote.rest}.md`);
      return {
        text: new TextDecoder().decode(pd.data),
        meta: fileMetaToPageMeta(pd.meta, name, remoteOrigin(r.vault)),
      };
    }
    const pageData = await this.spacePrimitives.readFile(`${name}.md`);
    return {
      text: new TextDecoder().decode(pageData.data),
      meta: fileMetaToPageMeta(pageData.meta),
    };
  }

  async writePage(
    name: string,
    text: string,
    ifUnmodifiedSince?: number,
  ): Promise<PageMeta> {
    if (parseRemotePath(name)) {
      throw new Error(
        "Remote pages can't be saved via auto-save. Use the Push action instead.",
      );
    }
    const meta = await this.spacePrimitives.writeFile(
      `${name}.md`,
      new TextEncoder().encode(text),
      ifUnmodifiedSince,
    );
    return fileMetaToPageMeta(meta);
  }

  isListedPage(fileMeta: FileMeta): boolean {
    // Underscore-prefix hides the basename, not the whole path —
    // `notes/_draft.md` and `_draft.md` are both hidden, but a normal
    // file under a folder whose name starts with `_` is not. Spec
    // file.md keeps the rule basename-only.
    const slash = fileMeta.name.lastIndexOf("/");
    const base = slash >= 0 ? fileMeta.name.slice(slash + 1) : fileMeta.name;
    if (base.startsWith("_")) return false;
    // .md is the primary content type; .pdf opens in the dedicated
    // PdfViewer and is also a first-class vault page. Other types
    // (images, json, etc.) are accessed via wikilink transclusion and
    // stay out of the Content browser.
    return fileMeta.name.endsWith(".md") || fileMeta.name.endsWith(".pdf");
  }

  async fetchPageList(): Promise<PageMeta[]> {
    return (await this.deduplicatedFileList())
      .filter(this.isListedPage)
      .map((m) => fileMetaToPageMeta(m));
  }

  async deduplicatedFileList(): Promise<FileMeta[]> {
    const files = await this.spacePrimitives.fetchFileList();
    const seen = new Map<string, FileMeta>();
    for (const f of files) {
      const existing = seen.get(f.name);
      if (!existing || existing.lastModified < f.lastModified) {
        seen.set(f.name, f);
      }
    }
    return [...seen.values()];
  }
}

function remoteOrigin(v: { id: string; label: string; url: string }): PageOrigin {
  return { kind: "remote", vaultId: v.id, label: v.label, url: v.url };
}

function fileMetaToPageMeta(
  fileMeta: FileMeta,
  nameOverride?: string,
  origin?: PageOrigin,
): PageMeta {
  // For remote: caller provides the @<label>-prefixed name.
  // For local: .md files have their extension stripped (conventional
  // page-name form used everywhere else in the client); other types
  // (.pdf) keep their extension so the navigator can dispatch them.
  let name: string;
  if (nameOverride !== undefined) {
    name = nameOverride;
  } else if (fileMeta.name.endsWith(".md")) {
    name = fileMeta.name.slice(0, -3);
  } else {
    name = fileMeta.name;
  }
  const o: PageOrigin = origin ?? { kind: "local" };
  return {
    ref: name,
    tag: "page",
    name,
    created: new Date(fileMeta.created).toISOString(),
    lastModified: new Date(fileMeta.lastModified).toISOString(),
    perm: o.kind === "remote" ? "ro" : fileMeta.perm,
    tags: fileMeta.tags,
    title: fileMeta.title,
    origin: o,
    prereq: fileMeta.prereq,
    headings: fileMeta.headings,
    wikilinks: fileMeta.wikilinks,
    id: fileMeta.id,
    contentHash: fileMeta.contentHash,
  } as PageMeta;
}
