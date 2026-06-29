import { wikiLinkRegex } from "./parser/constants.ts";

export type ContentAlign = "left" | "center" | "right";
export type Transclusion = {
  url: string;
  alias: string;
  dimension?: ContentDimensions;
  align?: ContentAlign;
};
export type ContentDimensions = {
  width?: number;
  height?: number;
};

const ALIGN_KEYWORDS = new Set<ContentAlign>(["left", "center", "right"]);
const DIM_RE = /^(\d+)?(?:x(\d+)?)?$/;

// Segments may appear in any order - first non-special segment becomes alias.
export function parseDimensionFromAlias(text: string): {
  alias: string;
  dimension?: ContentDimensions;
  align?: ContentAlign;
} {
  let alias = "";
  let dim: ContentDimensions | undefined;
  let align: ContentAlign | undefined;
  for (const raw of text.split("|")) {
    const p = raw.trim();
    if (!p) continue;
    if (ALIGN_KEYWORDS.has(p as ContentAlign)) {
      align = p as ContentAlign;
      continue;
    }
    if (/\d/.test(p) && DIM_RE.test(p)) {
      const [w, h] = p.split("x");
      dim = {};
      if (w) dim.width = parseInt(w, 10);
      if (h) dim.height = parseInt(h, 10);
      continue;
    }
    if (!alias) alias = p;
  }
  return { alias, dimension: dim, align };
}

export function parseTransclusion(text: string): Transclusion | null {
  wikiLinkRegex.lastIndex = 0;
  const match = wikiLinkRegex.exec(text);
  if (!match || !match.groups) return null;

  let { stringRef: url, alias } = match.groups;
  let dimension: ContentDimensions | undefined;
  let align: ContentAlign | undefined;
  if (alias) {
    ({ alias, dimension, align } = parseDimensionFromAlias(alias));
  } else {
    alias = "";
  }

  return {
    url,
    alias,
    dimension,
    align,
  };
}
