// Not a full YAML parser - only pulls `id` / `title` / `tags` / `refs` /
// `backrefs`.
export type Frontmatter = {
  /** 16-char [a-z0-9] file id (server-minted). */
  id?: string;
  title?: string;
  /** Category tags. */
  tags?: string[];
  /** Ids this file references (link whitelist / jump gate). */
  refs?: string[];
  /** Ids that reference this file. */
  backrefs?: string[];
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
    id: parseScalar(body, "id"),
    title: parseScalar(body, "title"),
    tags: parseList(body, "tags"),
    refs: parseList(body, "refs"),
    backrefs: parseList(body, "backrefs"),
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

/** Quote a YAML scalar only when it would otherwise be ambiguous (empty,
 *  leading/trailing space, or a char that breaks an inline flow list). */
function yamlListItem(s: string): string {
  if (s === "" || s !== s.trim() || /[[\]{}:,"#]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** Drop every line that belongs to frontmatter field `key` from the
 *  frontmatter `body`: the `key:` line plus any following block-list
 *  `- item` lines. Leaves all other fields untouched. */
function dropField(body: string, key: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  const headRe = new RegExp(`^${key}[ \\t]*:`);
  for (let i = 0; i < lines.length; i++) {
    if (headRe.test(lines[i])) {
      // Skip this header and any indented block-list items under it.
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) j++;
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Set frontmatter list field `key` to `items`, rewriting it as a single
 *  inline array line. Creates the frontmatter block (and the field) when
 *  absent. An empty `items` removes the field. Used by the in-buffer
 *  refs/backrefs maintenance (spec file.md: refs/backrefs are kept in
 *  place as links are inserted/deleted). */
export function setFrontmatterList(
  text: string,
  key: string,
  items: string[],
): string {
  const skip = bomLen(text);
  const prefix = text.slice(0, skip);
  const rest = text.slice(skip);
  const line = items.length
    ? `${key}: [${items.map(yamlListItem).join(", ")}]`
    : null;

  const m = FM_RE.exec(rest);
  if (!m) {
    // No frontmatter block. Nothing to remove; nothing to add when empty.
    if (!line) return text;
    return `${prefix}---\n${line}\n---\n${rest}`;
  }

  const block = m[1];
  const cleaned = dropField(block, key).replace(/\n+$/, "");
  const fields = line ? (cleaned ? `${cleaned}\n${line}` : line) : cleaned;
  const after = rest.slice(m[0].length);
  // Drop the whole frontmatter block when it would be left empty.
  if (!fields.trim()) return `${prefix}${after}`;
  return `${prefix}---\n${fields}\n---\n${after}`;
}

/** Add `item` to frontmatter list `key` (idempotent). */
export function addToFrontmatterList(
  text: string,
  key: "refs" | "backrefs",
  item: string,
): string {
  const cur = extractFrontmatter(text)[key] ?? [];
  if (cur.includes(item)) return text;
  return setFrontmatterList(text, key, [...cur, item]);
}

/** Remove `item` from frontmatter list `key` (no-op when absent). */
export function removeFromFrontmatterList(
  text: string,
  key: "refs" | "backrefs",
  item: string,
): string {
  const cur = extractFrontmatter(text)[key] ?? [];
  if (!cur.includes(item)) return text;
  return setFrontmatterList(text, key, cur.filter((x) => x !== item));
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
