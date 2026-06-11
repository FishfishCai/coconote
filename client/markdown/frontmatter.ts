// Not a full YAML parser - only pulls `title` / `tag` / `prereq` /
// `id` / `remote`.
export type Frontmatter = {
  title?: string;
  tag?: string[];
  prereq?: string[];
  /** Server-injected stable page identity. */
  id?: string;
  /** Label of the remote vault this file is bound to. Set on Download,
   * absent means a purely local file. */
  remote?: string;
};

// Single regex serves both `extract` (group 1 = yaml body) and
// `strip` (group 0 = full block including trailing newline).
// CRLF-tolerant to match the Rust server's find_frontmatter.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** UTF-8 BOM. Some editors prepend one - skip it transparently so the
 *  fence still anchors at offset 0 from the caller's perspective. */
const BOM = "﻿";

function bomLen(text: string): number {
  return text.startsWith(BOM) ? BOM.length : 0;
}

export function stripFrontmatter(text: string): {
  body: string;
  offset: number;
} {
  const skip = bomLen(text);
  const m = FM_RE.exec(text.slice(skip));
  if (!m) return { body: text, offset: 0 };
  return { body: text.slice(skip + m[0].length), offset: skip + m[0].length };
}

export function extractFrontmatter(text: string): Frontmatter {
  const skip = bomLen(text);
  const m = FM_RE.exec(text.slice(skip));
  if (!m) return {};
  const body = m[1];
  return {
    title: parseScalar(body, "title"),
    tag: parseList(body, "tag"),
    prereq: parseList(body, "prereq"),
    id: parseScalar(body, "id"),
    remote: parseScalar(body, "remote"),
  };
}

function stripQuotes(s: string): string {
  s = s.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(body: string, key: string): string | undefined {
  // Horizontal whitespace only around `:` so an empty value (`title:`)
  // doesn't let `\s*` swallow the next line's `key: value`.
  const re = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, "m");
  const m = re.exec(body);
  if (!m) return undefined;
  return cleanScalar(m[1]);
}

// Strip a YAML trailing `# comment` (only outside quotes) and surrounding
// quotes. Without this, `id: abc # auto-generated` corrupts the id.
function cleanScalar(raw: string): string | undefined {
  let s = raw.trim();
  if (s.startsWith("#")) return undefined; // whole value is a comment
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    const end = s.indexOf(q, 1);
    return (end > 0 ? s.slice(1, end) : s.slice(1)) || undefined;
  }
  const comment = / +#.*$/.exec(s);
  if (comment) s = s.slice(0, comment.index);
  return s.trim() || undefined;
}

function parseList(body: string, key: string): string[] | undefined {
  const inline = new RegExp(`^${key}\\s*:\\s*\\[([^\\]]*)\\]`, "m").exec(body);
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  const blockHeader = new RegExp(`^${key}\\s*:\\s*$`, "m").exec(body);
  if (blockHeader) {
    const after = body.slice(blockHeader.index + blockHeader[0].length + 1);
    const items: string[] = [];
    for (const line of after.split("\n")) {
      const m = /^\s*-\s+(.+)$/.exec(line);
      if (!m) break;
      const v = stripQuotes(m[1]);
      if (v) items.push(v);
    }
    return items.length ? items : undefined;
  }
  // A plain scalar (`tag: research`) counts as a one-element list,
  // matching the server's parse_strings so client/server agree.
  const scalar = parseScalar(body, key);
  return scalar !== undefined ? [scalar] : undefined;
}
