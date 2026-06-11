import { wikiLinkRegex } from "../markdown/parser/constants.ts";

export type LinkType = "wikilink" | "markdownlink";
export type ContentAlign = "left" | "center" | "right";
export type Transclusion = {
  url: string;
  alias: string;
  dimension?: ContentDimensions;
  align?: ContentAlign;
  linktype: LinkType;
};
export type ContentDimensions = {
  width?: number;
  height?: number;
};

const ALIGN_KEYWORDS = new Set<ContentAlign>(["left", "center", "right"]);
const DIM_RE = /^(\d+)?(?:x(\d+)?)?$/;

// Segments may appear in any order; first non-special segment becomes alias.
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
    linktype: "wikilink",
  };
}

export type AnchorSpec = { kind: "heading" | "anchor"; name: string };
export type AnchorRange = {
  path: string;
  start?: AnchorSpec;
  end?: AnchorSpec;
};

// Splits into bare path + up to two anchor specs so `[[page]]`, `[[page#h]]`,
// `[[page@a]]`, `[[page#h1#h2]]`, `[[page#h@a]]` flow through one resolver.
// Anchor sigil is `@` to match the `[[link]]` ref syntax.
export function parseAnchorRange(url: string): AnchorRange {
  const firstSig = url.search(/[#@]/);
  if (firstSig < 0) return { path: url };
  const path = url.slice(0, firstSig);
  const tail = url.slice(firstSig);
  const specs: AnchorSpec[] = [];
  const re = /([#@])([^#@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    specs.push({
      kind: m[1] === "#" ? "heading" : "anchor",
      name: m[2].trim(),
    });
    if (specs.length === 2) break;
  }
  return { path, start: specs[0], end: specs[1] };
}

export function joinAnchorRange(
  path: string,
  start?: AnchorSpec,
  end?: AnchorSpec,
): string {
  const fmt = (s: AnchorSpec) =>
    `${s.kind === "heading" ? "#" : "@"}${s.name}`;
  return path + (start ? fmt(start) : "") + (end ? fmt(end) : "");
}
