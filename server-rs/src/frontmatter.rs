// Markdown frontmatter scanning + id injection. file.md fields: id
// (auto-generated 16-char lowercase Crockford base32, 16 x 5 bits = 80
// bits), coconote (boolean, only `true` admits), title (display name),
// tag (YAML array), prereq (prerequisite-file links).

use serde::Deserialize;

/// 16 KB caps any realistic frontmatter block.
pub const FRONTMATTER_READ_LIMIT: usize = 16 * 1024;

/// Read up to `limit` bytes from the head of `abs_path`. `take +
/// read_to_end` so a short OS read can't silently truncate below the limit.
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
    // Skip a leading UTF-8 BOM (Notepad etc.) so such files still get
    // their `coconote:` admitted. Offsets are shifted by `bom_len` so
    // callers can slice the ORIGINAL doc unchanged.
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

/// `accepted` is true only for `coconote: true` (file.md). Other fields
/// (notably `id`) are extracted regardless so callers like the history
/// orphan sweep see ids of excluded pages too.
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

/// Parse frontmatter at the head of `doc` (first FRONTMATTER_READ_LIMIT
/// bytes): visibility decision + extracted fields.
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

/// 16-character base32 id (80 bits, file.md). Crypto RNG not required:
/// only within-vault uniqueness matters.
pub fn new_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| ID_ALPHABET[rng.gen_range(0..32)] as char)
        .collect()
}

/// Insert `line` (no EOL) right after the opening `---`, matching the
/// doc's EOL convention so CRLF files don't grow mixed line endings.
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

/// YAML-safe scalar: quoted/escaped exactly when YAML needs it (`: `,
/// leading `#`, bool/number look-alikes, ...). Plain names unchanged.
fn yaml_quote(s: &str) -> String {
    serde_yaml::to_string(s)
        .map(|y| y.trim_end_matches('\n').to_string())
        .unwrap_or_else(|_| format!("{s:?}"))
}

/// Idempotent: None when the frontmatter already has an `id:` or
/// `coconote:` isn't truthy, else the doc with `id: <new>` inserted after
/// the opening `---`. Does NOT auto-create a frontmatter block: file.md
/// requires `coconote: true` for admission, and injecting silently would
/// admit unrelated READMEs.
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

/// Regenerate `id:` to a fresh value, returning new bytes + id. Used when
/// a supplied id collides elsewhere in the vault (file.md: "on write,
/// regenerated if it would collide with another id in the vault"). Only a
/// top-level (column-0) `id:` line is rewritten, nested keys and the rest
/// of the block (including EOLs) stay untouched.
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
            // Replace only this line's content, keep its EOL bytes.
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

/// Current frontmatter `id:`, if any.
pub fn read_id(doc_bytes: &[u8]) -> Option<String> {
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    parsed.id.filter(|s| !s.is_empty())
}

/// Inject `title: <default>` when missing, admitted (`coconote: true`),
/// and a frontmatter block exists. file.md: title "Initialized to the
/// filename when the file is created." YAML-quoted when needed: a name
/// with `: ` or `#` would otherwise corrupt the whole block.
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

// file.md: only lowercase `coconote: true` admits, any other value
// (false, missing, a string, ...) excludes. YAML coerces `True`/`TRUE`
// to bool too, so decide on the raw scalar text of the top-level
// `coconote:` line, not the coerced value.
fn coconote_is_true(yaml_body: &[u8]) -> bool {
    let Ok(s) = std::str::from_utf8(yaml_body) else {
        return false;
    };
    for line in s.lines() {
        // Column-0 key only: nested `coconote:` doesn't admit.
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
    fn id_alphabet_excludes_i_l_o_u() {
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
        // file.md: ONLY lowercase `true` admits, YAML would coerce these.
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
