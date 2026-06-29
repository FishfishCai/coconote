// Markdown frontmatter (design.md "frontmatter"). A markdown file carries
// five fields wrapped in two `---` fences: id (16-char [a-z0-9] identity),
// title (display name, default = filename without extension), tags (category
// list), refs (ids this file links to), backrefs (ids that link to this
// file). A PDF carries the same fields minus refs, in its companion json
// (see meta.rs), not here.
//
// frontmatter is remote read-only: a remote write keeps the on-disk
// frontmatter and accepts only the body (merge_remote_frontmatter). The
// client maintains refs / backrefs in place and writes them back via a full
// PUT, so the server needs no field-mutation primitives beyond stamping a
// default block (id + title) onto a file that lacks one.

use crate::util::{gen_id, is_valid_id};
use serde::Deserialize;

/// 16 KB caps any realistic frontmatter block.
pub const FRONTMATTER_READ_LIMIT: usize = 16 * 1024;

/// Read up to `limit` bytes from the head of `abs_path`.
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
    /// Offset in the original doc where the yaml body starts (right after
    /// the opening `---\n`).
    pub yaml_start: usize,
    /// Offset where the yaml body ends (start of the closing `---`).
    pub yaml_end: usize,
}

/// Returns Some(...) when `doc` begins with a closed `---`/`---` block. The
/// closing fence may sit at EOF with no trailing newline.
pub fn find_frontmatter(doc: &[u8]) -> Option<Frontmatter<'_>> {
    // Skip a leading UTF-8 BOM (Notepad etc.). Offsets are shifted by
    // `bom_len` so callers can slice the ORIGINAL doc unchanged.
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
            return None;
        };
        scan = line_end + 1;
    }
    None
}

#[derive(Debug, Default, Clone)]
pub struct ScanResult {
    /// 16-char [a-z0-9] identity, empty when absent or malformed.
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    /// ids this file links to (the jump whitelist).
    pub refs: Vec<String>,
    /// ids that link to this file.
    pub backrefs: Vec<String>,
}

#[derive(Deserialize)]
struct Fields {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    // `tags` is the only category field. The rewrite writes `tags`; there is
    // no legacy singular `tag` on disk to migrate.
    #[serde(default)]
    tags: Option<serde_yaml::Value>,
    #[serde(default)]
    refs: Option<serde_yaml::Value>,
    #[serde(default)]
    backrefs: Option<serde_yaml::Value>,
}

/// Parse the frontmatter fields from the head of `doc`.
pub fn scan_frontmatter(doc: &[u8]) -> ScanResult {
    let head = &doc[..doc.len().min(FRONTMATTER_READ_LIMIT)];
    let Some(fm) = find_frontmatter(head) else {
        return ScanResult::default();
    };
    let Ok(parsed) = serde_yaml::from_slice::<Fields>(fm.yaml_body) else {
        return ScanResult::default();
    };
    let id = parsed
        .id
        .filter(|s| is_valid_id(s))
        .unwrap_or_default();
    let tags = parsed
        .tags
        .as_ref()
        .map(parse_strings)
        .unwrap_or_default();
    ScanResult {
        id,
        title: parsed.title.unwrap_or_default(),
        tags,
        refs: parsed.refs.as_ref().map(parse_strings).unwrap_or_default(),
        backrefs: parsed.backrefs.as_ref().map(parse_strings).unwrap_or_default(),
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

/// YAML-safe scalar: quoted/escaped only when YAML needs it.
fn yaml_quote(s: &str) -> String {
    serde_yaml::to_string(s)
        .map(|y| y.trim_end_matches('\n').to_string())
        .unwrap_or_else(|_| format!("{s:?}"))
}

/// Insert `line` (no EOL) right after the opening `---`, matching the doc's
/// EOL convention so CRLF files don't grow mixed endings.
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

/// Ensure the doc carries a frontmatter block with an `id` and a `title`
/// (design.md: a markdown file is stamped a default frontmatter on first
/// save, and an id is minted on first sight when absent or malformed). A
/// file that has a block keeps it but gains the missing fields. `id` is the
/// desired id: pass a caller-chosen one (a freshly minted id from the disk
/// layer, or a client-supplied one on create); the existing id wins when the
/// block already has a valid one. Returns None when nothing changed.
pub fn ensure_default_frontmatter(
    doc_bytes: &[u8],
    default_title: &str,
    id: &str,
) -> Option<Vec<u8>> {
    match find_frontmatter(doc_bytes) {
        Some(_) => {
            let mut cur = doc_bytes.to_vec();
            let mut changed = false;
            if let Some(next) = ensure_id(&cur, id) {
                cur = next;
                changed = true;
            }
            if let Some(next) = ensure_title(&cur, default_title) {
                cur = next;
                changed = true;
            }
            changed.then_some(cur)
        }
        None => {
            let mut block = String::from("---\n");
            block.push_str(&format!("id: {id}\n"));
            if !default_title.is_empty() {
                block.push_str(&format!("title: {}\n", yaml_quote(default_title)));
            }
            block.push_str("---\n");
            let mut out = Vec::with_capacity(doc_bytes.len() + block.len());
            out.extend_from_slice(block.as_bytes());
            out.extend_from_slice(doc_bytes);
            Some(out)
        }
    }
}

/// Inject `id: <id>` when the existing block lacks a valid one. None when a
/// valid id is already present or there is no block.
pub fn ensure_id(doc_bytes: &[u8], id: &str) -> Option<Vec<u8>> {
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    if parsed.id.as_deref().is_some_and(is_valid_id) {
        return None;
    }
    Some(insert_after_open_fence(doc_bytes, &format!("id: {id}")))
}

/// Inject `title: <default>` when the existing block lacks it. None when a
/// non-empty title is already present or there is no block.
pub fn ensure_title(doc_bytes: &[u8], default_title: &str) -> Option<Vec<u8>> {
    if default_title.is_empty() {
        return None;
    }
    let fm = find_frontmatter(doc_bytes)?;
    let parsed: Fields = serde_yaml::from_slice(fm.yaml_body).ok()?;
    if parsed.title.as_deref().is_some_and(|s| !s.is_empty()) {
        return None;
    }
    let line = format!("title: {}", yaml_quote(default_title));
    Some(insert_after_open_fence(doc_bytes, &line))
}

/// The doc's existing valid id, or a freshly minted one. Does not mutate the
/// doc: pair with `ensure_default_frontmatter` to persist the chosen id.
pub fn id_or_mint(doc_bytes: &[u8]) -> String {
    let scan = scan_frontmatter(doc_bytes);
    if is_valid_id(&scan.id) {
        scan.id
    } else {
        gen_id()
    }
}

/// Splice the on-disk frontmatter onto `incoming` body (design.md:
/// frontmatter is remote read-only). The returned bytes keep `disk`'s
/// frontmatter block verbatim and take `incoming`'s body. When `incoming`
/// has no frontmatter, the whole of `incoming` is its body. When `disk` has
/// none, `incoming` is returned unchanged (nothing to preserve).
pub fn merge_remote_frontmatter(disk: &[u8], incoming: &[u8]) -> Vec<u8> {
    let Some(disk_fm) = find_frontmatter(disk) else {
        return incoming.to_vec();
    };
    // disk frontmatter block = bytes up to and including the closing fence
    // and its EOL.
    let disk_block_end = block_end(disk, &disk_fm);
    let incoming_body_start = match find_frontmatter(incoming) {
        Some(in_fm) => block_end(incoming, &in_fm),
        None => 0,
    };
    let mut out = Vec::with_capacity(disk_block_end + incoming.len());
    out.extend_from_slice(&disk[..disk_block_end]);
    out.extend_from_slice(&incoming[incoming_body_start..]);
    out
}

/// Byte offset just past the closing `---` fence line (including its EOL if
/// present).
fn block_end(doc: &[u8], fm: &Frontmatter<'_>) -> usize {
    // yaml_end is the start of the closing fence. Skip `---` then its EOL.
    let mut i = fm.yaml_end + 3; // past "---"
    if i < doc.len() && doc[i] == b'\r' {
        i += 1;
    }
    if i < doc.len() && doc[i] == b'\n' {
        i += 1;
    }
    i.min(doc.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::is_valid_id;

    #[test]
    fn find_basic() {
        let doc = b"---\ntitle: x\n---\nbody";
        let fm = find_frontmatter(doc).unwrap();
        assert_eq!(fm.yaml_body, b"title: x\n");
    }

    #[test]
    fn scan_reads_all_fields() {
        let doc = b"---\nid: abcd1234efgh5678\ntitle: My Note\ntags: [a, b]\nrefs: [x1]\nbackrefs: [y1]\n---\nbody";
        let r = scan_frontmatter(doc);
        assert_eq!(r.id, "abcd1234efgh5678");
        assert_eq!(r.title, "My Note");
        assert_eq!(r.tags, vec!["a", "b"]);
        assert_eq!(r.refs, vec!["x1"]);
        assert_eq!(r.backrefs, vec!["y1"]);
    }

    #[test]
    fn scan_ignores_singular_tag_key() {
        // Only `tags` is read; a singular `tag` is not a recognized field and
        // is ignored (no legacy on-disk format to migrate).
        let doc = b"---\ntitle: t\ntag: [old]\n---\nbody";
        let r = scan_frontmatter(doc);
        assert!(r.tags.is_empty(), "singular `tag` is not parsed as tags");
    }

    #[test]
    fn scan_drops_malformed_id() {
        let doc = b"---\nid: NOT-A-VALID-ID\ntitle: t\n---\nbody";
        assert_eq!(scan_frontmatter(doc).id, "", "malformed id is treated as absent");
    }

    #[test]
    fn default_frontmatter_prepended_when_missing() {
        let out = ensure_default_frontmatter(b"just body", "note", "abcd1234efgh5678").unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.starts_with("---\nid: abcd1234efgh5678\ntitle: note\n---\n"), "{s}");
        assert!(s.ends_with("just body"));
    }

    #[test]
    fn ensure_fills_missing_id_and_title_in_existing_block() {
        let out =
            ensure_default_frontmatter(b"---\ntags: [a]\n---\nbody", "fallback", "abcd1234efgh5678")
                .unwrap();
        let r = scan_frontmatter(&out);
        assert_eq!(r.id, "abcd1234efgh5678");
        assert_eq!(r.title, "fallback");
        assert_eq!(r.tags, vec!["a"]);
    }

    #[test]
    fn ensure_keeps_existing_id() {
        // A block that already has a valid id is not given the desired one.
        let out = ensure_default_frontmatter(
            b"---\nid: keepkeepkeep1234\ntitle: t\n---\nbody",
            "t",
            "abcd1234efgh5678",
        );
        assert!(out.is_none(), "valid id + title present -> no change");
        let r = scan_frontmatter(b"---\nid: keepkeepkeep1234\ntitle: t\n---\nbody");
        assert_eq!(r.id, "keepkeepkeep1234");
    }

    #[test]
    fn id_or_mint_keeps_or_generates() {
        assert_eq!(
            id_or_mint(b"---\nid: keepkeepkeep1234\n---\nb"),
            "keepkeepkeep1234"
        );
        let minted = id_or_mint(b"---\ntitle: no id\n---\nb");
        assert!(is_valid_id(&minted), "minted a fresh id: {minted}");
    }

    #[test]
    fn merge_remote_keeps_disk_frontmatter_takes_incoming_body() {
        let disk = b"---\nid: abcd1234efgh5678\ntitle: real\nrefs: [a1]\n---\noriginal body\n";
        let incoming = b"---\nid: zzzz9999zzzz9999\ntitle: HACKED\nrefs: [evil]\n---\nnew body\n";
        let merged = merge_remote_frontmatter(disk, incoming);
        let r = scan_frontmatter(&merged);
        assert_eq!(r.title, "real", "remote cannot change title");
        assert_eq!(r.id, "abcd1234efgh5678", "remote cannot change id");
        assert_eq!(r.refs, vec!["a1"], "remote cannot change refs");
        let s = std::str::from_utf8(&merged).unwrap();
        assert!(s.ends_with("new body\n"), "body taken from incoming: {s:?}");
    }

    #[test]
    fn merge_remote_incoming_without_frontmatter() {
        let disk = b"---\ntitle: real\n---\nold\n";
        let merged = merge_remote_frontmatter(disk, b"raw new body");
        let s = std::str::from_utf8(&merged).unwrap();
        assert_eq!(s, "---\ntitle: real\n---\nraw new body");
    }

    #[test]
    fn merge_remote_disk_without_frontmatter_passes_incoming() {
        let merged = merge_remote_frontmatter(b"no fm", b"---\ntitle: x\n---\nb");
        assert_eq!(merged, b"---\ntitle: x\n---\nb");
    }
}
