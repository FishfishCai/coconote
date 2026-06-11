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
    // Underscore-prefix hides by basename only (file.md): `notes/_draft.md`
    // is hidden, a normal file under a `_`-prefixed folder is not.
    const slash = fileMeta.name.lastIndexOf("/");
    const base = slash >= 0 ? fileMeta.name.slice(slash + 1) : fileMeta.name;
    if (base.startsWith("_")) return false;
    // .md and .pdf (opened in the PdfViewer) are first-class vault
    // pages. Other types (images, json, ...) are reached via wikilink
    // transclusion and stay out of the Content browser.
    return fileMeta.name.endsWith(".md") || fileMeta.name.endsWith(".pdf");
  }

  async fetchPageList(): Promise<PageMeta[]> {
    return (await this.spacePrimitives.fetchFileList())
      .filter(this.isListedPage)
      .map((m) => fileMetaToPageMeta(m));
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
  // Remote: caller provides the @<label>-prefixed name. Local: .md
  // files get their extension stripped (the client's page-name form),
  // other types (.pdf) keep it so the navigator can dispatch them.
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
