// Title -> id resolution. A `[[title]]` (or `[[tag/title]]`) names a file
// by its display title; the link's identity is the resolved id. This
// mirrors the server's resolver.rs `resolve_title` so the client's
// synchronous render-time resolution agrees with GET /.resolve:
//   - split a `tag/title` query on the first `/`,
//   - match `title` exactly (case-sensitive),
//   - when a tag prefix is present, require it among the file's tags,
//   - 1 match -> hit, 0 -> missing, >1 -> ambiguous.
// Kept free of Client/DOM imports so it stays testable.

import type { PageMeta } from "coconote/type/page";

export type TitleResolution =
  | { state: "hit"; id: string }
  | { state: "ambiguous"; candidates: PageMeta[] }
  | { state: "missing" };

export function resolveTitle(
  name: string,
  pages: readonly PageMeta[],
): TitleResolution {
  const trimmed = name.trim();
  const slash = trimmed.indexOf("/");
  const tag = slash >= 0 ? trimmed.slice(0, slash) : undefined;
  const title = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const hits = pages.filter((p) =>
    (p.title ?? "") === title &&
    (tag === undefined || (p.tags ?? []).includes(tag))
  );
  if (hits.length === 1) return { state: "hit", id: hits[0].id };
  if (hits.length === 0) return { state: "missing" };
  // Stable order so an ambiguous candidate list is deterministic.
  return {
    state: "ambiguous",
    candidates: hits.slice().sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

export function pageById(
  id: string | undefined,
  pages: readonly PageMeta[],
): PageMeta | undefined {
  return id ? pages.find((p) => p.id === id) : undefined;
}

/** Current display title of a target id (SPEC: a chip shows the target's
 *  title, following renames). Undefined when the id is unknown. */
export function titleForId(
  id: string | undefined,
  pages: readonly PageMeta[],
): string | undefined {
  return pageById(id, pages)?.title;
}

/** True when the id names a PDF (the navigator opens the reader). */
export function isPdfId(
  id: string | undefined,
  pages: readonly PageMeta[],
): boolean {
  return pageById(id, pages)?.kind === "pdf";
}
