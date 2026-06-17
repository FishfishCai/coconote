import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { ConfigCtx as Client } from "../../../core/ctx/config.ts";
import { isCodeOrCommentNode } from "../../util/util.ts";

// LaTeX Suite-compatible snippet format. options flags:
//   m = math (any), M = block math `$$..$$` only, t = text (outside math),
//   A = auto-expand (no Tab), r = regex trigger, w = word boundary required.
export type SnippetRaw = {
  trigger: string;
  replacement: string;
  options?: string;
  description?: string;
};

export type SnippetFile =
  | SnippetRaw[]
  | {
    variables?: Record<string, string>;
    snippets?: SnippetRaw[];
  };

type CompiledSnippet = {
  literal?: string;
  regex?: RegExp;
  replacement: string;
  auto: boolean;
  mathInline: boolean;
  mathBlock: boolean;
  textOnly: boolean;
  wordBoundary: boolean;
};

let compiledSnippets: CompiledSnippet[] = [];
let snippetsLoaded = false;

function substituteVariables(
  src: string,
  vars: Record<string, string>,
): string {
  return src.replace(/\$\{([A-Z_][A-Z_0-9]*)\}/g, (m, name) => {
    return vars[name] ?? m;
  });
}

function compileSnippets(file: SnippetFile): CompiledSnippet[] {
  const list = Array.isArray(file) ? file : (file.snippets ?? []);
  const vars = (!Array.isArray(file) && file.variables) || {};
  const out: CompiledSnippet[] = [];
  for (const s of list) {
    if (!s || typeof s.trigger !== "string" ||
        typeof s.replacement !== "string") continue;
    const opts = s.options ?? "";
    const isRegex = opts.includes("r");
    const isAuto = opts.includes("A");
    const mInline = opts.includes("m");
    const mBlock = opts.includes("M");
    const textOnly = opts.includes("t");
    const wordBoundary = opts.includes("w");

    const compiled: CompiledSnippet = {
      replacement: s.replacement,
      auto: isAuto,
      mathInline: mInline,
      mathBlock: mBlock,
      textOnly: textOnly,
      wordBoundary: wordBoundary,
    };

    if (isRegex) {
      const pattern = substituteVariables(s.trigger, vars);
      try {
        // Anchor to end-of-input - tested against chars just before cursor.
        const anchored = pattern.endsWith("$") ? pattern : pattern + "$";
        compiled.regex = new RegExp(anchored);
      } catch (e) {
        console.warn("snippets: bad regex", s.trigger, e);
        continue;
      }
    } else {
      compiled.literal = s.trigger;
    }
    out.push(compiled);
  }
  // Longest literal first so e.g. `===` wins over `=`.
  out.sort((a, b) => (b.literal?.length ?? 0) - (a.literal?.length ?? 0));
  return out;
}

function loadSnippets(client: Client): CompiledSnippet[] {
  if (snippetsLoaded) return compiledSnippets;

  const text = client.config.get<string | null>(["ui", "snippets"], null);
  if (!text || !text.trim()) {
    compiledSnippets = [];
    snippetsLoaded = true;
    return compiledSnippets;
  }
  try {
    const parsed = JSON.parse(text) as SnippetFile;
    compiledSnippets = compileSnippets(parsed);
  } catch (e) {
    console.warn("snippets: parse error", e);
    compiledSnippets = [];
  }
  snippetsLoaded = true;
  return compiledSnippets;
}

export function invalidateSnippetsCache() {
  compiledSnippets = [];
  snippetsLoaded = false;
}

// "code" is its own context (not "none"): NO snippet (not even
// t-flagged or auto-expanding ones) may fire inside a code region.
type MathContext = "none" | "inline" | "block" | "code";

/** Doc prefix [0, upto) with code/comment regions blanked to spaces
 *  (same length, so offsets stay aligned). A literal `$` inside code
 *  must not flip the math parity for everything after it. */
function maskCodeRegions(state: EditorState, upto: number): string {
  const raw = state.doc.sliceString(0, upto);
  const spans: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    from: 0,
    to: upto,
    enter: (node) => {
      if (!isCodeOrCommentNode(node.name)) return;
      if (node.from < upto) {
        spans.push({ from: node.from, to: Math.min(node.to, upto) });
      }
      return false; // inner CodeText etc. are covered by this span
    },
  });
  if (spans.length === 0) return raw;
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    const from = Math.max(s.from, cursor);
    const to = Math.max(s.to, from);
    out += raw.slice(cursor, from) + " ".repeat(to - from);
    cursor = to;
  }
  return out + raw.slice(cursor);
}

function detectMathContext(state: EditorState, pos: number): MathContext {
  // Cursor inside a code region -> snippets are disabled entirely.
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    n;
    n = n.parent
  ) {
    if (isCodeOrCommentNode(n.type.name)) return "code";
  }
  // Parity scan over MASKED text: code regions earlier in the doc are
  // blanked first. (Scanning text instead of checking tree ancestors
  // also catches the unclosed `$...` the user is mid-typing, which has
  // no Math node yet.)
  const head = maskCodeRegions(state, pos);
  const blockOpens = (head.match(/\$\$/g) ?? []).length;
  if (blockOpens % 2 === 1) return "block";
  const line = state.doc.lineAt(pos);
  const lineBefore = head.slice(line.from, pos);
  const stripped = lineBefore.replace(/\\\$/g, "").replace(/\$\$/g, "");
  const dollars = (stripped.match(/\$/g) ?? []).length;
  return dollars % 2 === 1 ? "inline" : "none";
}

function modeAllows(snippet: CompiledSnippet, ctx: MathContext): boolean {
  if (ctx === "code") return false; // nothing fires inside code
  if (snippet.mathBlock) return ctx === "block"; // M = display math only
  if (snippet.mathInline) return ctx === "inline" || ctx === "block";
  if (snippet.textOnly) return ctx === "none";
  return true;
}

type MatchResult = {
  matchStart: number;
  matchEnd: number;
  groups: string[];
};

function matchSnippet(
  snippet: CompiledSnippet,
  textBefore: string,
  absEnd: number,
): MatchResult | null {
  if (snippet.regex) {
    const m = snippet.regex.exec(textBefore);
    if (!m) return null;
    const matchStart = absEnd - m[0].length;
    return {
      matchStart,
      matchEnd: absEnd,
      groups: m.slice(1).map((g) => g ?? ""),
    };
  }
  if (snippet.literal && textBefore.endsWith(snippet.literal)) {
    // No implicit boundary here - per spec, a word boundary applies
    // ONLY when the snippet carries the `w` flag (checked in tryExpand).
    return {
      matchStart: absEnd - snippet.literal.length,
      matchEnd: absEnd,
      groups: [],
    };
  }
  return null;
}

// editor.md Snippet: "$1, $2, ..., $9 are sequential tab stops ... $0
// is the final caret. Once all $1-$9 have been visited, pressing Tab
// jumps to $0 and the snippet ends." Returns the expanded text plus
// the ordered list of caret offsets the snippet should visit ($1..$9
// in numeric order, then $0, EMPTY when the template has no markers).
function expandReplacement(
  template: string,
  groups: string[],
  visual: string,
): { text: string; stops: number[] } {
  let src = template;
  // `[[N]]` is 1-indexed in user-facing snippet syntax (spec):
  // `[[1]]` = first capture group. `groups` is already the
  // regex's m.slice(1), so subtract 1 to index into it.
  src = src.replace(/\[\[(\d+)\]\]/g, (_m, idx) => {
    const n = parseInt(idx, 10);
    return groups[n - 1] ?? "";
  });
  src = src.replace(/\$\{VISUAL\}/g, visual);

  // Single left-to-right tokenizer: escaped `$$N` emits literal `$N`,
  // `$N` records a stop at the CURRENT output length, everything else
  // copies through. Collapsing the escape in the same pass keeps every
  // later stop's offset honest (a post-hoc collapse would shift them).
  let out = "";
  const stopOffsets: Array<{ n: number; offset: number }> = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "$" && src[i + 1] === "$" && /\d/.test(src[i + 2] ?? "")) {
      out += "$" + src[i + 2];
      i += 2;
      continue;
    }
    if (c === "$" && /\d/.test(src[i + 1] ?? "")) {
      stopOffsets.push({ n: parseInt(src[i + 1], 10), offset: out.length });
      i += 1;
      continue;
    }
    out += c;
  }

  // Order: $1, $2, ... $9, then $0 (final caret, visited last).
  // Duplicates collapse to the first occurrence.
  const ordered: number[] = [];
  for (let n = 1; n <= 9; n++) {
    const it = stopOffsets.find((s) => s.n === n);
    if (it) ordered.push(it.offset);
  }
  const zero = stopOffsets.find((s) => s.n === 0);
  if (zero) ordered.push(zero.offset);

  return { text: out, stops: ordered };
}

// Active snippet tracker - survives across user edits so $1 -> $2 -> ... -> $0
// navigation works. Stops are stored as ABSOLUTE doc positions and
// remapped through every transaction so intermediate typing doesn't
// strand the cursor in the middle of a freshly-typed substring.
type ActiveSnippet = {
  /** Mapped span of the inserted snippet text. A user-driven selection
   *  landing outside it abandons the snippet. */
  from: number;
  to: number;
  /** Absolute caret positions still to visit, in order. */
  stops: number[];
  /** Next stop to visit (index into `stops`). */
  index: number;
};

const setActiveSnippet = StateEffect.define<ActiveSnippet | null>();

const activeSnippetField = StateField.define<ActiveSnippet | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setActiveSnippet)) return e.value;
    }
    if (!value) return null;
    // Remap span + remaining stops through the user's edits so the
    // caret lands at the right semantic position even after typing.
    const mapped = {
      ...value,
      from: tr.changes.mapPos(value.from, -1),
      to: tr.changes.mapPos(value.to, 1),
      stops: value.stops.map((p) => tr.changes.mapPos(p, 1)),
    };
    // Clicking / cursoring away from the snippet expires it - a later
    // Tab must not teleport the caret back to a stale stop. (Typing,
    // deletes etc. are "input.*"/"delete.*", not "select".)
    if (tr.selection && tr.isUserEvent("select")) {
      const head = tr.newSelection.main.head;
      if (head < mapped.from || head > mapped.to) return null;
    }
    return mapped;
  },
});

function jumpToNextStop(view: EditorView): boolean {
  const snip = view.state.field(activeSnippetField, false);
  if (!snip) return false;
  if (snip.index >= snip.stops.length) {
    view.dispatch({ effects: setActiveSnippet.of(null) });
    return false;
  }
  const target = snip.stops[snip.index];
  const last = snip.index + 1 >= snip.stops.length;
  view.dispatch({
    selection: EditorSelection.cursor(target),
    effects: last
      ? setActiveSnippet.of(null)
      : setActiveSnippet.of({ ...snip, index: snip.index + 1 }),
    scrollIntoView: true,
  });
  return true;
}

function tryExpand(
  view: EditorView,
  snippets: CompiledSnippet[],
  triggeredByTab: boolean,
): boolean {
  const state = view.state;
  const sel = state.selection.main;
  const pos = sel.head;
  const visual = sel.empty ? "" : state.sliceDoc(sel.from, sel.to);

  const ctx = detectMathContext(state, sel.empty ? pos : sel.from);
  if (ctx === "code") return false; // no snippet fires inside code
  const lookback = 64;
  const lineStart = state.doc.lineAt(pos).from;
  const fromAbs = Math.max(lineStart, pos - lookback);
  const before = state.doc.sliceString(fromAbs, pos);

  for (const s of snippets) {
    if (!modeAllows(s, ctx)) continue;
    if (!triggeredByTab && !s.auto) continue;
    const m = matchSnippet(s, before, pos);
    if (!m) continue;
    // `w` flag (spec): fire only when preceded by "a space, line
    // start, or non-alphanumeric character". `_` is non-alphanumeric,
    // i.e. a boundary - so the class is letters + digits only.
    if (s.wordBoundary && m.matchStart > 0) {
      const prev = state.doc.sliceString(m.matchStart - 1, m.matchStart);
      if (/[A-Za-z0-9]/.test(prev)) continue;
    }
    const replaceFrom = sel.empty ? m.matchStart : sel.from;
    const replaceTo = sel.empty ? m.matchEnd : sel.to;
    const { text, stops } = expandReplacement(
      s.replacement,
      m.groups,
      visual,
    );
    // First stop is where the caret lands now (end of text when the
    // template has no markers); remaining stops feed sequential Tab
    // navigation via the activeSnippetField. Convert template-relative
    // offsets to ABSOLUTE doc positions so the field's transaction
    // remap can track them through typing.
    const firstOffset = stops[0] ?? text.length;
    // A single stop ($0-only and friends) stays ACTIVE even though the
    // caret already sits on it: spec wants the first Tab consumed
    // ("pressing Tab exits the snippet directly") rather than falling
    // through to indent. No markers at all => nothing to keep active.
    const restOffsets = stops.length === 1 ? stops : stops.slice(1);
    const remainingAbs = restOffsets.map((off) => replaceFrom + off);
    view.dispatch({
      changes: { from: replaceFrom, to: replaceTo, insert: text },
      selection: EditorSelection.cursor(replaceFrom + firstOffset),
      effects: remainingAbs.length > 0
        ? setActiveSnippet.of({
          from: replaceFrom,
          to: replaceFrom + text.length,
          stops: remainingAbs,
          index: 0,
        })
        : setActiveSnippet.of(null),
      userEvent: "input.snippet",
    });
    return true;
  }
  return false;
}

export function snippetsPlugin(client: Client) {
  // Re-read compiledSnippets on every event so invalidateSnippetsCache()
  // (called by Settings/SnippetsSection on edit) takes effect without
  // rebuilding the whole editor state. The cache itself remains a
  // single module-level array, so the hot path is still a single map
  // read after the first compile.
  const current = () => loadSnippets(client);

  return [
    activeSnippetField,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.view.composing) return;
      const wasType = update.transactions.some((t) =>
        t.isUserEvent("input.type")
      );
      if (!wasType) return;
      const snippets = current();
      if (snippets.length === 0) return;
      queueMicrotask(() => {
        if (update.view.composing) return;
        tryExpand(update.view, snippets, false);
      });
    }),
    // Tab order: active snippet's next stop > new snippet expansion >
    // default Tab. editor_state.ts has a Prec.high Tab handler that
    // unconditionally inserts 4 spaces (outside list) / indents
    // (inside list). The snippet expansion needs strictly higher
    // priority and falls through (false) when no trigger matches.
    Prec.highest(keymap.of([
      {
        key: "Tab",
        run: (view) => {
          if (jumpToNextStop(view)) return true;
          const snippets = current();
          if (snippets.length === 0) return false;
          return tryExpand(view, snippets, true);
        },
      },
    ])),
  ];
}
