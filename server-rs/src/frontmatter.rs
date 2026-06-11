// Markdown frontmatter scanning + id injection. file.md defines five
// frontmatter fields:
//
//   id        — auto-generated, 16-char lowercase Crockford base32
//   coconote  — boolean; only `true` admits a file
//   title     — display name distinct from filename
//   tag       — YAML array of tags
//   prereq    — prerequisite-file links
//
// Id alphabet: `0123456789abcdefghjkmnpqrstvwxyz` (file.md),
// the easily-confused `i / l / o / u` removed. 16 chars × 5 bits = 80 bits.

use serde::Deserialize;

/// 16 KB caps any realistic frontmatter block.
pub const FRONTMATTER_READ_LIMIT: usize = 16 * 1024;

/// Heading / wikilink scans look at the first 64 KB of a body.
pub const BODY_SCAN_LIMIT: usize = 64 * 1024;

/// Read up to `limit` bytes from the head of `abs_path`. Uses
/// `take + read_to_end` so a short read from the OS can't silently
/// truncate the buffer below the limit.
pub fn read_head(abs_path: &std::path::Path, limit: usize) -> Vec<u8> {
    let Ok(f) = std::fs::File::open(abs_path) else {
        return Vec::new();
    };
    use std::io::Read;
    let mut buf = Vec::new();
    let _ = f.take(limit as u64).read_to_end(&mut buf);
    buf
}

pub struct Frontmatter<'a> {
    pub yaml_body: &'a [u8],
    /// Offset in the original doc where the yaml body starts (right
    /// after the opening `---\n`).
    pub yaml_start: usize,
    /// Offset where the yaml body ends (start of closing `---`).
    pub yaml_end: usize,
}

/// Returns Some(...) when `doc` begins with a closed `---`/`---` block.
/// The closing fence may sit at EOF with no trailing newline.
pub fn find_frontmatter(doc: &[u8]) -> Option<Frontmatter<'_>> {
    // Skip a leading UTF-8 BOM so editors that prepend one (Notepad,
    // some Windows tools) still get their `coconote:` admitted.
    // Offsets are shifted by `bom_len` so callers can slice the
    // ORIGINAL doc unchanged.
    let bom = b"\xef\xbb\xbf";
    let bom_len = if doc.starts_with(bom) { bom.len() } else { 0 };
    let doc = &doc[bom_len..];
    let fence = b"---";
    if !doc.starts_with(fence) {
        return None;
    }
    let after = &doc[fence.len()..];
    if after.is_empty() {
        return None;
    }
    let rest_start = match after[0] {
        b'\n' => fence.len() + 1,
        b'\r' if after.len() > 1 && after[1] == b'\n' => fence.len() + 2,
        _ => return None,
    };
    let rest = &doc[rest_start..];
    let mut scan = 0usize;
    while scan < rest.len() {
        let nl = rest[scan..].iter().position(|&b| b == b'\n');
        let line_end = scan + nl.unwrap_or(rest.len() - scan);
        let mut line = &rest[scan..line_end];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        if line == fence {
            return Some(Frontmatter {
                yaml_body: &rest[..scan],
                yaml_start: bom_len + rest_start,
                yaml_end: bom_len + rest_start + scan,
            });
        }
        let Some(_) = nl else {
            // Last line, unterminated, and it wasn't the fence.
            return None;
        };
        scan = line_end + 1;
    }
    None
}

/// Scanned frontmatter fields. `accepted` is true only when
/// `coconote: true` is present and truthy (file.md); the other fields
/// (notably `id`) are extracted regardless so callers like the history
/// orphan sweep can see ids of excluded pages too.
#[derive(Debug, Default, Clone)]
pub struct ScanResult {
    pub accepted: bool,
    pub tag: Vec<String>,
    pub title: String,
    pub prereq: Vec<String>,
    pub id: String,
}

#[derive(Deserialize)]
struct Fields {
    #[serde(default)]
    tag: Option<serde_yaml::Value>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    prereq: Option<serde_yaml::Value>,
    #[serde(default)]
    id: Option<String>,
}

/// Parses the frontmatter at the head of `doc` (first
/// FRONTMATTER_READ_LIMIT bytes) and returns the visibility decision +
/// extracted fields.
pub fn scan_frontmatter(doc: &[u8]) -> ScanResult {
    let head = &doc[..doc.len().min(FRONTMATTER_READ_LIMIT)];
    let Some(fm) = find_frontmatter(head) else {
        return ScanResult::default();
    };
    let Ok(parsed) = serde_yaml::from_slice::<Fields>(fm.yaml_body) else {
        return ScanResult::default();
    };
    ScanResult {
        accepted: coconote_is_true(fm.yaml_body),
        tag: parsed.tag.as_ref().map(parse_strings).unwrap_or_default(),
        title: parsed.title.unwrap_or_default(),
        prereq: parsed.prereq.as_ref().map(parse_strings).unwrap_or_default(),
        id: parsed.id.unwrap_or_default(),
    }
}

/// Index of the first body line after a leading `---` frontmatter block
/// (0 when there is none). Shared by the heading / wikilink scanners.
fn frontmatter_end_line(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim()) == Some("---") {
        if let Some(close) = lines.iter().skip(1).position(|l| l.trim() == "---") {
            return (close + 2).min(lines.len());
        }
    }
    0
}

/// Pulls H1-H4 heading texts out of the first 64 KB of `doc`. Skips
/// frontmatter and code-fence ranges so `# in code` isn't reported.
/// Used by GET /.file so filter expressions can match against
/// "headings inside files" per content.md.
pub fn scan_headings(doc: &[u8]) -> Vec<String> {
    let head = &doc[..doc.len().min(BODY_SCAN_LIMIT)];
    let body = match std::str::from_utf8(head) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let lines: Vec<&str> = body.lines().collect();
    let start = frontmatter_end_line(&lines);

    let mut in_fence = false;
    let mut out = Vec::new();
    for line in &lines[start..] {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut chars = trimmed.chars();
        let mut hashes = 0;
        while chars.next() == Some('#') {
            hashes += 1;
            if hashes > 4 {
                break;
            }
        }
        // markdown.md: only H1-H4 are part of the spec. Reject
        // ##### / ###### here too — the editor render path already
        // drops them.
        if hashes < 1 || hashes > 4 {
            continue;
        }
        let rest = trimmed[hashes..].trim_start();
        // Need at least one space between #'s and text per ATX rules.
        if !trimmed[hashes..].starts_with(' ') {
            continue;
        }
        let text = rest.trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(text);
    }
    out
}

/// Pulls `[[wikilink]]` targets out of the first 64 KB of `doc`. The
/// raw spec string inside the brackets is returned verbatim (resolution
/// happens client-side via `resolveWikiLink`). Used by GET /.file so
/// the Graph view can build edges without re-reading every body
/// (content.md §Graph view — "driven by both the `prereq:` field in
/// frontmatter and wikilinks").
pub fn scan_wikilinks(doc: &[u8]) -> Vec<String> {
    let head = &doc[..doc.len().min(BODY_SCAN_LIMIT)];
    let body = match std::str::from_utf8(head) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    // Skip the frontmatter block so a `prereq: [foo]` line doesn't also
    // surface as a wikilink. Same skip logic as scan_headings.
    let lines: Vec<&str> = body.lines().collect();
    let start = frontmatter_end_line(&lines);

    // Skip fenced code blocks — `[[foo]]` inside code is markup, not a
    // link.
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut in_fence = false;
    for line in &lines[start..] {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Scan `[[ ... ]]`, including image embeds `![[ ... ]]` (which
        // are second-class links per file.md — assets, not page graph
        // edges, so we exclude images explicitly).
        let bytes = line.as_bytes();
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                // Reject the image-embed prefix `![[...]]` — images live
                // in `.<name>.assets/` and are not part of the page DAG.
                if i > 0 && bytes[i - 1] == b'!' {
                    i += 2;
                    continue;
                }
                let start_idx = i + 2;
                // Find matching `]]`.
                let mut j = start_idx;
                while j + 1 < bytes.len() && !(bytes[j] == b']' && bytes[j + 1] == b']') {
                    j += 1;
                }
                if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                    let inner = &line[start_idx..j];
                    // Drop the display alias `|...`.
                    let bare = inner.split('|').next().unwrap_or(inner).trim();
                    // Reject external URLs BEFORE stripping position
                    // markers — otherwise `https://...` gets cut at the
                    // first `:` and the leftover `https` looks like a
                    // page locator.
                    if bare.starts_with("http://") || bare.starts_with("https://") {
                        i = j + 2;
                        continue;
                    }
                    // Strip the position markers `#`, `@`, `:`, `%`
                    // (wikilink.md) so resolveWikiLink sees only
                    // the page locator.
                    let cut = bare
                        .find(|c: char| c == '#' || c == '@' || c == ':' || c == '%')
                        .unwrap_or(bare.len());
                    let target = bare[..cut].trim();
                    // Skip empties (e.g. `[[#heading]]` — current page
                    // self-ref; no edge to draw).
                    if !target.is_empty() && seen.insert(target.to_string()) {
                        out.push(target.to_string());
                    }
                    i = j + 2;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}

fn parse_strings(v: &serde_yaml::Value) -> Vec<String> {
    match v {
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        serde_yaml::Value::String(s) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Crockford base32 alphabet with `i l o u` removed (file.md).
const ID_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Generate a 16-character base32 id (80 bits — spec file.md).
/// Cryptographic RNG not required; we only need within-vault uniqueness.
pub fn new_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| ID_ALPHABET[rng.gen_range(0..32)] as char)
        .collect()
}

/// Insert `line` (without EOL) right after the opening `---` fence,
/// matching the document's EOL convention so CRLF files don't grow
/// mixed line endings.
fn insert_after_open_fence(doc_bytes: &[u8], line: &str) -> Vec<u8> {
    let after_open = doc_bytes
        .iter()
        .position(|&b| b == b'\n')
        .map(|p| p + 1)
        .unwrap_or(doc_bytes.len());
    let eol: &[u8] = if after_open >= 2 && doc_bytes[after_open - 2] == b'\r' {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut out = Vec::with_capacity(doc_bytes.len() + line.len() + eol.len());
    out.extend_from_slice(&doc_bytes[..after_open]);
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(eol);
    out.extend_from_slice(&doc_bytes[after_open..]);
    out
}

/// YAML-safe scalar text for `s`: quoted/escaped exactly when YAML
/// needs it (`: `, leading `#`, bool/number look-alikes, ...). Plain
/// names come back unchanged.
fn yaml_quote(s: &str) -> String {
    serde_yaml::to_string(s)
        .map(|y| y.trim_end_matches('\n').to_string())
        .unwrap_or_else(|_| format!("{s:?}"))
}

/// Idempotent: returns None when the doc already has frontmatter with an
/// `id:`, or when `coconote:` is not truthy. Otherwise returns the
/// rewritten doc with `id: <new>` inserted right after the opening `---`.
///
/// We do NOT auto-create a frontmatter block for files without one —
/// file.md says a markdown file must have `coconote: true` to be
/// admitted; injecting an id silently would admit unrelated READMEs.
pub fn ensure_id(doc_bytes: &[u8]) -> Option<(Vec<u8>, String)> {
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    if !coconote_is_true(fm.yaml_body) {
        return None;
    }
    if parsed.id.as_deref().is_some_and(|s| !s.is_empty()) {
        return None;
    }
    let new = new_id();
    let out = insert_after_open_fence(doc_bytes, &format!("id: {new}"));
    Some((out, new))
}

/// Regenerates the `id:` in `doc_bytes` to a fresh value, returning the
/// new bytes + new id. Used when a user-supplied id collides with an
/// existing one elsewhere in the vault (file.md: "on write,
/// regenerated if it would collide with another id in the vault").
/// Only a top-level (column-0) `id:` line is rewritten; nested keys and
/// the rest of the block (including its EOLs) are left untouched.
pub fn regen_id(doc_bytes: &[u8]) -> Option<(Vec<u8>, String)> {
    let fm = find_frontmatter(doc_bytes)?;
    let body = fm.yaml_body;
    let new_id_str = new_id();
    let mut line_start = 0usize;
    while line_start < body.len() {
        let line_end = body[line_start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|p| line_start + p)
            .unwrap_or(body.len());
        let line = &body[line_start..line_end];
        if line.starts_with(b"id:") {
            // Replace only this line's content; keep its EOL bytes.
            let content_end = if line.last() == Some(&b'\r') {
                line_end - 1
            } else {
                line_end
            };
            let mut out = Vec::with_capacity(doc_bytes.len() + 16);
            out.extend_from_slice(&doc_bytes[..fm.yaml_start + line_start]);
            out.extend_from_slice(format!("id: {new_id_str}").as_bytes());
            out.extend_from_slice(&doc_bytes[fm.yaml_start + content_end..]);
            return Some((out, new_id_str));
        }
        line_start = line_end + 1;
    }
    None
}

/// Reads the current id (frontmatter `id:`) from `doc_bytes`, if any.
pub fn read_id(doc_bytes: &[u8]) -> Option<String> {
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    parsed.id.filter(|s| !s.is_empty())
}

/// Injects `title: <default>` into the frontmatter if it's missing, the
/// doc is admitted (`coconote: true`), and the doc has a frontmatter
/// block. file.md: title "Initialized to the filename when the file
/// is created." The value is YAML-quoted when needed — a name with
/// `: ` or `#` would otherwise corrupt the whole block.
pub fn ensure_title(doc_bytes: &[u8], default_title: &str) -> Option<Vec<u8>> {
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    if !coconote_is_true(fm.yaml_body) {
        return None;
    }
    if parsed.title.as_deref().is_some_and(|s| !s.is_empty()) {
        return None;
    }
    let line = format!("title: {}", yaml_quote(default_title));
    Some(insert_after_open_fence(doc_bytes, &line))
}

// file.md: "Only `coconote: true` (lowercase) is treated as included
// in Coconote; any other value (false, missing, a string, …) is treated
// as excluded." YAML parsers coerce `True` / `TRUE` to a boolean too,
// so the decision is made on the raw scalar text of the top-level
// `coconote:` line, not the coerced value.
fn coconote_is_true(yaml_body: &[u8]) -> bool {
    let Ok(s) = std::str::from_utf8(yaml_body) else {
        return false;
    };
    for line in s.lines() {
        // Column-0 key only; nested `coconote:` under another mapping
        // doesn't admit.
        let Some(rest) = line.strip_prefix("coconote:") else {
            continue;
        };
        let mut v = rest.trim();
        // Strip a trailing YAML comment (needs preceding whitespace).
        if let Some(idx) = v.find('#') {
            if idx > 0 && v[..idx].ends_with(char::is_whitespace) {
                v = v[..idx].trim_end();
            }
        }
        return v == "true";
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_basic() {
        let doc = b"---\ncoconote: true\n---\nbody";
        let fm = find_frontmatter(doc).unwrap();
        assert_eq!(fm.yaml_body, b"coconote: true\n");
        // Body starts right after the closing fence line.
        let body_start = fm.yaml_end + "---\n".len();
        assert_eq!(body_start, doc.len() - "body".len());
    }

    #[test]
    fn find_fence_at_eof_without_newline() {
        let doc = b"---\ncoconote: true\n---";
        let fm = find_frontmatter(doc).unwrap();
        assert_eq!(fm.yaml_body, b"coconote: true\n");
    }

    #[test]
    fn id_alphabet_excludes_iloU() {
        let alphabet = std::str::from_utf8(ID_ALPHABET).unwrap();
        for forbidden in ['i', 'l', 'o', 'u'] {
            assert!(!alphabet.contains(forbidden), "alphabet must drop {forbidden}");
        }
    }

    #[test]
    fn id_is_16_chars() {
        for _ in 0..32 {
            assert_eq!(new_id().len(), 16);
        }
    }

    #[test]
    fn scan_admits_only_coconote_true() {
        let doc = b"---\ncoconote: true\ntag: [a, b]\ntitle: My Note\n---\nbody";
        let r = scan_frontmatter(doc);
        assert!(r.accepted);
        assert_eq!(r.tag, vec!["a", "b"]);
        assert_eq!(r.title, "My Note");
    }

    #[test]
    fn scan_rejects_when_coconote_false() {
        let r = scan_frontmatter(b"---\ncoconote: false\ntitle: hi\n---\nbody");
        assert!(!r.accepted);
        assert_eq!(r.title, "hi", "fields still extracted when excluded");
    }

    #[test]
    fn scan_rejects_when_field_absent() {
        assert!(!scan_frontmatter(b"---\ntitle: x\n---\nbody").accepted);
    }

    #[test]
    fn scan_rejects_uppercase_true() {
        // file.md: ONLY lowercase `true` admits; YAML would coerce these.
        assert!(!scan_frontmatter(b"---\ncoconote: True\n---\nbody").accepted);
        assert!(!scan_frontmatter(b"---\ncoconote: TRUE\n---\nbody").accepted);
    }

    #[test]
    fn scan_keeps_id_when_excluded() {
        let r = scan_frontmatter(b"---\ncoconote: false\nid: abc123\n---\nbody");
        assert!(!r.accepted);
        assert_eq!(r.id, "abc123");
    }

    #[test]
    fn ensure_id_skips_doc_without_coconote_flag() {
        let doc = b"---\ntitle: x\n---\nbody";
        assert!(ensure_id(doc).is_none());
    }

    #[test]
    fn ensure_id_skips_doc_with_existing_id() {
        let doc = b"---\ncoconote: true\nid: abc\n---\nbody";
        assert!(ensure_id(doc).is_none());
    }

    #[test]
    fn ensure_id_injects_when_admitted_and_missing() {
        let doc = b"---\ncoconote: true\n---\nbody";
        let (out, id) = ensure_id(doc).unwrap();
        assert_eq!(id.len(), 16);
        assert!(std::str::from_utf8(&out).unwrap().contains(&format!("id: {id}")));
    }

    #[test]
    fn ensure_id_keeps_crlf_eol() {
        let doc = b"---\r\ncoconote: true\r\n---\r\nbody";
        let (out, id) = ensure_id(doc).unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains(&format!("id: {id}\r\n")));
        assert!(!s.contains(&format!("id: {id}\n\r")), "no mixed EOLs");
    }

    #[test]
    fn ensure_title_quotes_when_needed() {
        let doc = b"---\ncoconote: true\n---\nbody";
        let out = ensure_title(doc, "a: b #c").unwrap();
        let r = scan_frontmatter(&out);
        assert!(r.accepted, "injected title must keep the block parseable");
        assert_eq!(r.title, "a: b #c");
    }

    #[test]
    fn regen_id_only_touches_top_level_id() {
        let doc = b"---\r\ncoconote: true\r\nid: old\r\nmeta:\r\n  id: nested\r\n---\r\nbody";
        let (out, new) = regen_id(doc).unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains(&format!("id: {new}\r\n")));
        assert!(s.contains("  id: nested\r\n"), "nested id untouched, EOLs kept");
        assert!(!s.contains("id: old"));
    }
}
