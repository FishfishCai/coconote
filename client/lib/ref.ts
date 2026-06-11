import {
  findNodeMatching,
  findNodeOfType,
  type ParseTree,
  renderToText,
} from "coconote/lib/tree";
import { ANCHOR_NAME_RE } from "../markdown/parser/constants.ts";
import {
  CALLOUT_OPEN_RE,
  findCalloutBounds,
  resolveTemplate,
} from "./callout.ts";
import { encodePathSegments } from "./path_url.ts";

// Empty path = index page (navigation) / current page (wikilinks).
export type Path = `${string}.${string}` | "";

/** Brand a bare string as a `Path`. Adds `.md` when the basename has
 *  no extension; passes paths with an extension through unchanged. */
export function toPath(s: string): Path {
  if (s === "") return s;
  return (/\.[a-z0-9]+$/i.test(s) ? s : s + ".md") as Path;
}

export type Ref = {
  path: Path;
  details?:
    | { type: "header"; header: string }
    | { type: "anchor"; name: string }
    // Callout target: digit string = Nth numbered callout, else label name.
    | { type: "callout"; target: string }
    // PDF anchor: only valid when path ends with .pdf. The named region
    // resolves through the sidecar notes file ([[paper.pdf%fig3]]).
    | { type: "pdfAnchor"; anchor: string };
};

export function getPathExtension(path: Path): string {
  return path !== "" ? path.split(".").pop()!.toLowerCase() : "md";
}

export function getNameFromPath(path: Path): string {
  return encodeRef({ path });
}

export function isMarkdownPath(path: Path): boolean {
  return getPathExtension(path) === "md";
}

function normalizePath(path: string): Path {
  // Single ".md-appending" rule for the whole module — toPath owns it.
  if (path.startsWith("/")) path = path.slice(1);
  return toPath(path);
}

// Sigils: `#` header, `@` anchor (markdown), `:` callout, `%` PDF anchor.
// `@` instead of `$` avoids math `$..$` collision; `%` is new — chosen
// for PDF because Markdown / wikilinks don't use it anywhere else.
const refRegex = new RegExp(
  `^(?<path>(?!.*\\.[a-zA-Z0-9]+\\.md$)(?!\\/?\\.)(?!.*(?:\\/|^)\\.{1,2}(?:\\/|$)|.*\\/{2})(?!.*(?:\\]\\]|\\[\\[))[^@#|<>:%]*)(#\\s*(?<header>.*)|@(?<anchor>${ANCHOR_NAME_RE.source})|:\\s*(?<callout>\\d+|[^\\s:#@|\\\\][^:#@|\\\\]*?)|%(?<pdfAnchor>${ANCHOR_NAME_RE.source}))?\\s*$`,
);

export function findNamedAnchor(
  text: string,
  name: string,
  from = 0,
): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Boundary must cover the FULL anchor-name charset (ANCHOR_NAME_RE
  // allows / : -), or `[[@fig]]` would land on `@fig-1`.
  const re = new RegExp(`@${escaped}(?![A-Za-z0-9_/:-])`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

// Numbering must agree with the rendered view (codemirror callout
// plugin): openers inside fenced code don't count, and an UNCLOSED
// callout (no `:::` closer before the next opener / EOF) is skipped
// entirely — otherwise `[[:3]]` jumps and "Theorem 5" displays drift
// from what the user sees.
function* iterCallouts(text: string): Iterable<{
  index: number;
  keyword: string;
  label: string | undefined;
  tpl: ReturnType<typeof resolveTemplate>;
  counter: number;
}> {
  const lines = text.split("\n");
  const offsets: number[] = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off;
    off += lines[i].length + 1;
  }
  const getLine = (n: number) =>
    n >= 1 && n <= lines.length
      ? {
        text: lines[n - 1],
        from: offsets[n - 1],
        to: offsets[n - 1] + lines[n - 1].length,
      }
      : null;
  let counter = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = CALLOUT_OPEN_RE.exec(line);
    if (!m) continue;
    if (!findCalloutBounds(getLine, i + 1)) continue; // unclosed — skip
    const keyword = m[2].toLowerCase();
    const tpl = resolveTemplate(keyword);
    if (tpl?.numbered) counter++;
    yield { index: offsets[i], keyword, label: m[3], tpl, counter };
  }
}

export function findCalloutTarget(text: string, target: string): number {
  const isNumeric = /^\d+$/.test(target);
  const wantN = isNumeric ? parseInt(target, 10) : -1;
  for (const c of iterCallouts(text)) {
    if (isNumeric) {
      if (c.tpl?.numbered && c.counter === wantN) return c.index;
    } else if (c.label === target) {
      return c.index;
    }
  }
  return -1;
}

// Mirrors the rendered callout prefix shape:
//   numbered + labelled → "Definition 1 (defLimit)."
//   numbered only       → "Theorem 5."
//   labelled only       → "Note (myTag)"
export function resolveCalloutDisplay(
  text: string,
  target: string,
): string | null {
  const isNumeric = /^\d+$/.test(target);
  const wantN = isNumeric ? parseInt(target, 10) : -1;
  for (const c of iterCallouts(text)) {
    const matched = isNumeric
      ? (c.tpl?.numbered && c.counter === wantN)
      : c.label === target;
    if (!matched) continue;
    const title = c.tpl?.title ?? c.keyword;
    const base = c.tpl?.numbered ? `${title} ${c.counter}` : title;
    if (c.label) return `${base} (${c.label})${c.tpl?.numbered ? "." : ""}`;
    return c.tpl?.numbered ? `${base}.` : base;
  }
  return null;
}

export function parseToRef(stringRef: string): Ref | null {
  const match = stringRef.match(refRegex);
  if (!match || !match.groups) {
    return null;
  }

  const groups = match.groups;

  const ref: Ref = { path: normalizePath(groups.path) };

  if (groups.header !== undefined) {
    ref.details = { type: "header", header: groups.header };
  } else if (groups.anchor !== undefined) {
    ref.details = { type: "anchor", name: groups.anchor };
  } else if (groups.callout !== undefined) {
    ref.details = { type: "callout", target: groups.callout };
  } else if (groups.pdfAnchor !== undefined) {
    ref.details = { type: "pdfAnchor", anchor: groups.pdfAnchor };
  }

  return ref;
}

export function encodeRef(ref: Ref): string {
  let stringRef: string = ref.path;

  if (isMarkdownPath(ref.path)) {
    stringRef = stringRef.slice(0, -3);
  }

  if (ref.details?.type === "header") {
    stringRef += `#${ref.details.header}`;
  } else if (ref.details?.type === "anchor") {
    stringRef += `@${ref.details.name}`;
  } else if (ref.details?.type === "callout") {
    stringRef += `:${ref.details.target}`;
  } else if (ref.details?.type === "pdfAnchor") {
    stringRef += `%${ref.details.anchor}`;
  }

  return stringRef;
}

// Returns -1 when the ref can't be located.
export function getOffsetFromRef(
  parseTree: ParseTree,
  ref: Ref,
  text?: string,
): number {
  if (!ref.details) {
    return -1;
  }

  switch (ref.details.type) {
    case "header": {
      return getOffsetFromHeader(parseTree, ref.details.header);
    }
    case "anchor": {
      const pos = findNamedAnchor(
        text ?? renderToText(parseTree),
        ref.details.name,
      );
      return pos < 0 ? -1 : pos;
    }
    case "callout": {
      const pos = findCalloutTarget(
        text ?? renderToText(parseTree),
        ref.details.target,
      );
      return pos < 0 ? -1 : pos;
    }
    case "pdfAnchor": {
      // PDF anchors live outside the markdown tree — resolved by the
      // PDF viewer via sidecar notes. Not addressable inside text.
      return -1;
    }
  }
}

export function getOffsetFromHeader(
  parseTree: ParseTree,
  header: string,
): number {
  const node = findNodeMatching(parseTree, (subTree) => {
    if (!subTree.type || !subTree.type.startsWith("ATXHeading")) {
      return false;
    }

    const mark = findNodeOfType(subTree, "HeaderMark");
    if (!mark || mark.from === undefined || mark.to === undefined) {
      return false;
    }

    return (
      renderToText(subTree)
        .slice(mark.to - mark.from)
        .trimStart() === header.trim()
    );
  });

  if (!node) {
    return -1;
  }

  // Return the START of the heading line so caller's
  // scrollIntoView(pos, { y: 'start' }) puts the heading itself at the
  // viewport top. Returning node.to would land the cursor at the end
  // of the subtree and scroll the heading off-screen.
  return node.from ?? -1;
}

// Like encodeURIComponent but preserves `/`. Single implementation —
// delegates to path_url so the two historic copies can't drift.
export function encodePageURI(page: string): string {
  return encodePathSegments(page);
}

// Slices the substring `details` selects:
//   header  → heading line → next same/higher heading (or EOF)
//   anchor  → anchor line → EOF
//   callout → body between `:::` opener / closer (fence stripped)
// Returns null when target can't be located.
export function sliceByRef(
  text: string,
  details: NonNullable<Ref["details"]>,
): { text: string; offset: number } | null {
  switch (details.type) {
    case "header": {
      const target = details.header.trim();
      const lines = text.split("\n");
      let pos = 0;
      let startPos = -1;
      let startLevel = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hm = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (hm) {
          const level = hm[1].length;
          if (startPos < 0 && hm[2].trim() === target) {
            startPos = pos;
            startLevel = level;
          } else if (startPos >= 0 && level <= startLevel) {
            return { text: text.slice(startPos, pos), offset: startPos };
          }
        }
        pos += line.length + 1;
      }
      return startPos < 0
        ? null
        : { text: text.slice(startPos), offset: startPos };
    }
    case "anchor": {
      const pos = findNamedAnchor(text, details.name);
      if (pos < 0) return null;
      const lineStart = text.lastIndexOf("\n", pos) + 1;
      return { text: text.slice(lineStart), offset: lineStart };
    }
    case "callout": {
      const pos = findCalloutTarget(text, details.target);
      if (pos < 0) return null;
      const tail = text.slice(pos);
      const openMatch = /^(:{3,})/.exec(tail);
      if (!openMatch) return { text: tail, offset: pos };
      const fenceLen = openMatch[1].length;
      const lines = tail.split("\n");
      // Spec markdown.md: a closing fence may use MORE colons than the
      // opener. Match anything >= fenceLen instead of exactly fenceLen.
      const closeRe = new RegExp(`^:{${fenceLen},}\\s*$`);
      // Static md render has no callout case, so fence lines would
      // leak as raw `:::` text — body only.
      const bodyStart = lines[0].length + 1;
      for (let i = 1; i < lines.length; i++) {
        if (closeRe.test(lines[i])) {
          const body = lines.slice(1, i).join("\n");
          return { text: body, offset: pos + bodyStart };
        }
      }
      return { text: lines.slice(1).join("\n"), offset: pos + bodyStart };
    }
    case "pdfAnchor": {
      // PDF content lives in a separate viewer; no slice into markdown.
      return null;
    }
  }
}
