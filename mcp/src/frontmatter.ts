// String-level frontmatter helpers ported from client/lib/
// frontmatter_edit.ts and the sidecar shape from client/pdf/
// notes_client.ts. Deliberately not a YAML round-trip: a parser would
// strip user comments, indentation, and key order.

import { randomFillSync } from "node:crypto";

const FENCE = "---";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Fm = { yamlStart: number; yamlEnd: number; eol: string };

function findFrontmatter(doc: string): Fm | null {
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

/** Set `key: value` in the frontmatter block, prepending a fresh block
 *  when the document has none. */
export function setFrontmatterKey(doc: string, key: string, value: string): string {
  const fm = findFrontmatter(doc);
  if (!fm) {
    const bom = doc.charCodeAt(0) === 0xfeff ? doc[0] : "";
    const body = bom ? doc.slice(1) : doc;
    return `${bom}${FENCE}\n${key}: ${value}\n${FENCE}\n\n${body}`;
  }
  const openLine = doc.slice(0, fm.yamlStart);
  const yamlBody = doc.slice(fm.yamlStart, fm.yamlEnd);
  const closeAndBody = doc.slice(fm.yamlEnd);
  // `:[^\r\n]*` so a CRLF value's trailing \r is not captured.
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

/** Frontmatter `id:` value, empty string when absent. */
export function frontmatterId(doc: string): string {
  const fm = findFrontmatter(doc);
  if (!fm) return "";
  const yaml = doc.slice(fm.yamlStart, fm.yamlEnd);
  const m = /(^|\n)id[ \t]*:[ \t]*([^\r\n#]*)/.exec(yaml);
  if (!m) return "";
  return m[2].trim().replace(/^["']|["']$/g, "");
}

/** True when the frontmatter already says `coconote: true`. */
export function hasCoconoteTrue(doc: string): boolean {
  const fm = findFrontmatter(doc);
  if (!fm) return false;
  const yaml = doc.slice(fm.yamlStart, fm.yamlEnd);
  return /^coconote[ \t]*:[ \t]*true[ \t]*(#.*)?$/m.test(yaml);
}

// --- page ids (client/lib/id.ts, mirrors server-rs frontmatter.rs) ---

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 16-char Crockford base32 page id, 80 bits of entropy. */
export function newPageId(): string {
  const bytes = new Uint8Array(10);
  randomFillSync(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const off = bit & 7;
    const hi = bytes[byte] << 8;
    const lo = byte + 1 < bytes.length ? bytes[byte + 1] : 0;
    const idx = ((hi | lo) >> (11 - off)) & 0x1f;
    out += ID_ALPHABET[idx];
  }
  return out;
}

// --- PDF sidecar (client/pdf/notes_client.ts shape) ---

export type Sidecar = {
  metadata: { id: string; coconote: boolean; title: string; tag: string[] };
  highlights: unknown[];
  anchors: unknown[];
  comments: unknown[];
};

/** Shape-harden a parsed sidecar. Hand-created sidecars may miss
 *  fields, that is sanctioned and not corruption. */
export function parseSidecar(jsonText: string): Sidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    raw = null;
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as {
    metadata?: Partial<Sidecar["metadata"]>;
    highlights?: unknown;
    anchors?: unknown;
    comments?: unknown;
  };
  return {
    metadata: {
      id: typeof o.metadata?.id === "string" ? o.metadata.id : "",
      coconote: o.metadata?.coconote === true,
      title: typeof o.metadata?.title === "string" ? o.metadata.title : "",
      tag: Array.isArray(o.metadata?.tag) ? o.metadata.tag : [],
    },
    highlights: Array.isArray(o.highlights) ? o.highlights : [],
    anchors: Array.isArray(o.anchors) ? o.anchors : [],
    comments: Array.isArray(o.comments) ? o.comments : [],
  };
}

/** Fresh include sidecar. Must carry a generated id: the server only
 *  heals missing ids on md, a PDF sidecar without one gets no history
 *  rows (mirrors client/lib/include.ts includePdf). */
export function freshIncludeSidecar(stem: string): Sidecar {
  return {
    metadata: { id: newPageId(), coconote: true, title: stem, tag: [] },
    highlights: [],
    anchors: [],
    comments: [],
  };
}

/** Empty sidecar used when excluding a PDF that has none on disk
 *  (mirrors notes_client.ts emptySidecar + removeFromIndex). */
export function emptySidecar(): Sidecar {
  return {
    metadata: { id: "", coconote: true, title: "", tag: [] },
    highlights: [],
    anchors: [],
    comments: [],
  };
}

export function sidecarJson(s: Sidecar): string {
  return JSON.stringify(s, null, 2);
}
