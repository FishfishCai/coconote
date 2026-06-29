// Numbered keywords share one document-wide counter (LaTeX style).

export type CalloutTemplate = {
  title?: string;
  suffix?: string;
  cssClass?: string;
  numbered?: boolean;
  italic?: boolean;
};

const builtinTemplates: Record<string, CalloutTemplate> = {
  // Bold heading + upright body for every kind (no italic) - a clean,
  // uniform frameless look. proof keeps its QED suffix.
  definition: { title: "Definition", numbered: true, cssClass: "def" },
  proof: { title: "Proof.", suffix: " ∎", cssClass: "proof" },
  theorem: { title: "Theorem", numbered: true, cssClass: "thm" },
  proposition: { title: "Proposition", numbered: true, cssClass: "prop" },
  lemma: { title: "Lemma", numbered: true, cssClass: "lemma" },
  corollary: { title: "Corollary", numbered: true, cssClass: "cor" },
  example: { title: "Example", numbered: true, cssClass: "ex" },
  remark: { title: "Remark", cssClass: "remark" },
  note: { title: "Note", cssClass: "note" },
  warning: { title: "Warning", cssClass: "warn" },
  tip: { title: "Tip", cssClass: "tip" },
  info: { title: "Info", cssClass: "info" },
};

export function resolveTemplate(name: string): CalloutTemplate | null {
  return builtinTemplates[name.toLowerCase()] ?? null;
}

// Label-banned characters mirror the wikilink-tail char class.
export const CALLOUT_OPEN_RE =
  /^(:{3,})\s*([a-zA-Z]+)(?:\s*:\s*([^\s:#@|\\][^:#@|\\]*?))?\s*$/;
export const CALLOUT_CLOSE_RE = /^:{3,}\s*$/;

/** Parse a callout opener line. Returns the keyword + optional label and
 *  the in-line offset where the label's first char sits (or -1 when the
 *  opener has no label). Used by autocomplete + editor smart-select. */
export function parseCalloutOpener(
  line: string,
): { keyword: string; label: string | null; labelOffset: number } | null {
  const m = CALLOUT_OPEN_RE.exec(line);
  if (!m) return null;
  const keyword = m[2];
  const label = m[3] ?? null;
  const labelOffset = label != null ? line.indexOf(label, m[1].length) : -1;
  return { keyword, label, labelOffset };
}

/** Closing `:::` line of a well-formed callout. */
export type CalloutBounds = {
  /** 1-based line number of the closer. */
  closerLineNo: number;
  closerFrom: number;
  closerTo: number;
};

/** Scan the lines below `openerLineNo` (1-based) for the callout's
 *  closing `:::`. Returns null when the callout is unclosed - the
 *  document ends, or ANOTHER opener appears before any closer (callouts
 *  don't nest, the second opener starts a new callout). Consumers must
 *  skip unclosed callouts entirely: no decoration, no inner range, no
 *  counter bump for numbered templates.
 *  `getLine` maps a 1-based line number to `{text, from, to}` (absolute
 *  offsets of the line's start/end) or null past end-of-document. */
export function findCalloutBounds(
  getLine: (n: number) => { text: string; from: number; to: number } | null,
  openerLineNo: number,
): CalloutBounds | null {
  for (let n = openerLineNo + 1; ; n++) {
    const ln = getLine(n);
    if (!ln) return null; // ran off end of document - unclosed
    if (CALLOUT_CLOSE_RE.test(ln.text)) {
      return { closerLineNo: n, closerFrom: ln.from, closerTo: ln.to };
    }
    if (CALLOUT_OPEN_RE.test(ln.text)) return null; // unclosed
  }
}
