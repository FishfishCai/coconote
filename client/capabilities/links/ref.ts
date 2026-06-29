import {
  findNodeMatching,
  findNodeOfType,
  type ParseTree,
  renderToText,
} from "coconote/lib/tree";
import {
  CALLOUT_OPEN_RE,
  findCalloutBounds,
  resolveTemplate,
} from "../../core/util";
import { encodePathSegments } from "../../core/util";

// The FILE/PATH concerns that used to live here (Path / getPathExtension /
// isMarkdownPath) moved to core/util/path_url: they are a path concern, not
// a links concern, so the markdown render path and core can share them
// without an edge into this capability.

// A wiki-link target parsed from `[[...]]` body text. `title` is the
// display-name part written before any position sigil: a `title`, or a
// `tag/title` for disambiguation, or "" to mean the current page.
// Position markers are `#heading`, `:callout`, `%pdf-name` (the spec set;
// the old `@named-anchor` sigil is gone).
export type Ref = {
  title: string;
  details?:
    | { type: "header"; header: string }
    // Callout target: digit string = Nth numbered callout, else label name.
    | { type: "callout"; target: string }
    // PDF named highlight, resolved by the PDF viewer ([[paper%fig3]]).
    | { type: "pdfAnchor"; anchor: string };
};

// The earliest position sigil (`#`, `:`, `%`) splits the name from the
// marker. `/` stays in the name (it is the tag/title separator).
const SIGIL_RE = /[#:%]/;

export function parseToRef(stringRef: string): Ref | null {
  // A `]]` or newline can never appear in a real wiki-link body (the
  // wikilink regex stops at `]]`); treat it as malformed.
  if (stringRef.includes("]]") || stringRef.includes("\n")) return null;
  const m = SIGIL_RE.exec(stringRef);
  if (!m) return { title: stringRef.trim() };
  const title = stringRef.slice(0, m.index).trim();
  const sigil = stringRef[m.index];
  const rest = stringRef.slice(m.index + 1).trim();
  const ref: Ref = { title };
  if (sigil === "#") {
    ref.details = { type: "header", header: rest };
  } else if (sigil === ":") {
    ref.details = { type: "callout", target: rest };
  } else if (sigil === "%") {
    ref.details = { type: "pdfAnchor", anchor: rest };
  }
  return ref;
}

export function encodeRef(ref: Ref): string {
  let out = ref.title;
  if (ref.details?.type === "header") {
    out += `#${ref.details.header}`;
  } else if (ref.details?.type === "callout") {
    out += `:${ref.details.target}`;
  } else if (ref.details?.type === "pdfAnchor") {
    out += `%${ref.details.anchor}`;
  }
  return out;
}

// Numbering must agree with the rendered view (codemirror callout
// plugin): openers inside fenced code don't count, and an UNCLOSED
// callout (no `:::` closer before the next opener / EOF) is skipped
// entirely - otherwise `[[:3]]` jumps and "Theorem 5" displays drift
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
    if (!findCalloutBounds(getLine, i + 1)) continue; // unclosed - skip
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
//   numbered + labelled -> "Definition 1 (defLimit)."
//   numbered only       -> "Theorem 5."
//   labelled only       -> "Note (myTag)"
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
    case "callout": {
      const pos = findCalloutTarget(
        text ?? renderToText(parseTree),
        ref.details.target,
      );
      return pos < 0 ? -1 : pos;
    }
    case "pdfAnchor": {
      // PDF anchors live outside the markdown tree - resolved by the
      // PDF viewer via the sidecar. Not addressable inside text.
      return -1;
    }
  }
}

export function getOffsetFromHeader(
  parseTree: ParseTree,
  header: string,
): number {
  const node = findNodeMatching(parseTree, (subTree) => {
    // markdown.md: headings (and the `#heading` link marker) are H1-H4
    // only. H5/H6 render literally and are not anchor targets.
    if (!subTree.type || !/^ATXHeading[1-4]$/.test(subTree.type)) {
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

// Like encodeURIComponent but preserves `/`. Delegates to path_url so
// the two historic copies can't drift.
export function encodePageURI(page: string): string {
  return encodePathSegments(page);
}

// Slices the substring `details` selects:
//   header  -> heading line to next same/higher heading (or EOF)
//   callout -> body between `:::` opener / closer (fence stripped)
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
        // H1-H4 only (markdown.md). `##### x` is not a heading.
        const hm = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
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
      // leak as raw `:::` text - body only.
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
      // PDF content lives in a separate viewer - no slice into markdown.
      return null;
    }
  }
}
