// Tiny YAML frontmatter editor for client-side ops that flip a single
// key (today: `coconote: true / false`). Deliberately string-level — we
// don't want to round-trip through a YAML parser that would strip
// the user's comments / indentation / key ordering.

import { escapeRegex } from "./util.ts";

const FENCE = "---";

/** Returns the text with `key: value` set in the frontmatter block.
 *  - Existing frontmatter, key present → replace the value on its line.
 *  - Existing frontmatter, key missing → append `key: value` before close.
 *  - No frontmatter → prepend a fresh block.
 */
export function setFrontmatterKey(
  doc: string,
  key: string,
  value: string,
): string {
  const fm = findFrontmatter(doc);
  if (!fm) {
    // Keep a leading BOM at the very start; the fresh block goes after it.
    const bom = doc.charCodeAt(0) === 0xfeff ? doc[0] : "";
    const body = bom ? doc.slice(1) : doc;
    return `${bom}${FENCE}\n${key}: ${value}\n${FENCE}\n\n${body}`;
  }
  // Reconstruct from explicit spans (CRLF-safe): opening fence line +
  // rewritten YAML + the closing fence and everything after it.
  const openLine = doc.slice(0, fm.yamlStart);
  const yamlBody = doc.slice(fm.yamlStart, fm.yamlEnd);
  const closeAndBody = doc.slice(fm.yamlEnd);
  // `:[^\r\n]*` so a CRLF value's trailing `\r` isn't captured.
  const keyRe = new RegExp(`(^|\\n)${escapeRegex(key)}\\s*:[^\\r\\n]*`);
  let newYaml: string;
  if (keyRe.test(yamlBody)) {
    newYaml = yamlBody.replace(keyRe, (_m, lead) => `${lead}${key}: ${value}`);
  } else {
    const sep = yamlBody === "" || yamlBody.endsWith("\n") ? "" : fm.eol;
    newYaml = `${yamlBody}${sep}${key}: ${value}${fm.eol}`;
  }
  return `${openLine}${newYaml}${closeAndBody}`;
}

type Fm = {
  /** Index where the YAML body starts (after the opening fence line). */
  yamlStart: number;
  /** Index where the YAML body ends (start of the closing fence line). */
  yamlEnd: number;
  /** Line terminator the fences use ("\n" or "\r\n"). */
  eol: string;
};

function findFrontmatter(doc: string): Fm | null {
  // Skip a leading BOM (some editors prepend one) — markdown/
  // frontmatter.ts's extractor does the same, and disagreeing here
  // would stack a second frontmatter block onto BOM'd files.
  const bom = doc.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!doc.startsWith(FENCE, bom)) return null;
  const eolMatch = /^(\r?\n)/.exec(doc.slice(bom + FENCE.length));
  if (!eolMatch) return null;
  const eol = eolMatch[1];
  const yamlStart = bom + FENCE.length + eol.length;
  let scan = yamlStart;
  while (scan <= doc.length) {
    const nl = doc.indexOf("\n", scan);
    const lineEnd = nl < 0 ? doc.length : nl;
    if (doc.slice(scan, lineEnd).replace(/\r$/, "") === FENCE) {
      return { yamlStart, yamlEnd: scan, eol };
    }
    if (nl < 0) break;
    scan = nl + 1;
  }
  return null;
}


