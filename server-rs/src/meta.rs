// File-type-aware identity + metadata (design.md "frontmatter" / "support
// file types" / "companion"). A markdown file keeps its id / title / tags /
// refs / backrefs in its `---` frontmatter; a PDF keeps id / title / tags /
// backrefs (no refs) in its companion json under `.<name>.assets/<stem>.json`.
// This module is the single place that knows which file type stores its
// identity where, so the resolver, boundary, and /.file handlers all read and
// stamp ids uniformly.

use crate::error::{Error, Result};
use crate::frontmatter::{
    ensure_default_frontmatter, read_head, scan_frontmatter, FRONTMATTER_READ_LIMIT,
};
use crate::util::{gen_id, is_valid_id, pdf_sidecar_for, write_atomic};
use std::path::Path;

/// One file's identity + link metadata, type-normalized.
#[derive(Debug, Clone, Default)]
pub struct FileMeta {
    /// 16-char [a-z0-9] id, empty when the file has none yet.
    pub id: String,
    /// Display name (default = filename without extension when absent).
    pub title: String,
    pub tags: Vec<String>,
    /// Outgoing link ids (markdown only; always empty for a PDF).
    pub refs: Vec<String>,
}

/// Whether `path` names a `.pdf` (case-insensitive). Byte-slices so a non-pdf
/// name whose `len - 4` lands mid-multibyte-char can't panic.
pub fn is_pdf(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 4 && b[b.len() - 4..].eq_ignore_ascii_case(b".pdf")
}

/// Whether `path` names a `.md` (case-insensitive). Byte-sliced (see is_pdf).
pub fn is_md(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3 && b[b.len() - 3..].eq_ignore_ascii_case(b".md")
}

/// Whether `path` is an id-bearing first-class file (markdown or PDF).
pub fn is_addressable(path: &str) -> bool {
    is_md(path) || is_pdf(path)
}

/// The file whose bytes the collab room and version history actually version
/// for an addressable file. A PDF's editable / collaborative / versioned
/// content is its companion sidecar json (identity + annotations), not the
/// immutable binary, so a pdf path maps to its sidecar; a markdown file is
/// itself. The pdf's history still keys off the pdf path (its `.history/`
/// lives in `.<stem>.assets/`), so callers pass the owner path to history and
/// this content path to disk IO.
pub fn content_path(path: &str) -> String {
    if is_pdf(path) {
        crate::util::pdf_sidecar_for(path)
    } else {
        path.to_string()
    }
}

/// Remote-write protection for a pdf's sidecar json, analogous to markdown
/// frontmatter protection (design.md: remote writes keep the on-disk
/// identity). A remote PUT of the sidecar may change only the annotation data
/// (highlights / comments / names); the identity fields under `metadata`
/// (id / title / tags / backrefs) are forced back to the on-disk values. A
/// missing or unparseable on-disk sidecar leaves `incoming` untouched (first
/// write, nothing to protect); non-json `incoming` is passed through.
pub fn merge_remote_sidecar(disk: &[u8], incoming: &[u8]) -> Vec<u8> {
    const IDENTITY: [&str; 4] = ["id", "title", "tags", "backrefs"];
    let Ok(mut merged) = serde_json::from_slice::<serde_json::Value>(incoming) else {
        return incoming.to_vec();
    };
    let Ok(disk_doc) = serde_json::from_slice::<serde_json::Value>(disk) else {
        return incoming.to_vec();
    };
    let disk_meta = disk_doc.get("metadata");
    if let Some(obj) = merged.as_object_mut() {
        let meta = obj
            .entry("metadata")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(meta_obj) = meta.as_object_mut() {
            for key in IDENTITY {
                match disk_meta.and_then(|m| m.get(key)) {
                    // Keep the on-disk identity value.
                    Some(v) => {
                        meta_obj.insert(key.to_string(), v.clone());
                    }
                    // Disk has no such identity field: drop whatever the
                    // remote tried to set so it cannot introduce one.
                    None => {
                        meta_obj.remove(key);
                    }
                }
            }
        }
    }
    serde_json::to_vec_pretty(&merged).unwrap_or_else(|_| incoming.to_vec())
}

/// Filename without its directory or extension (the default title).
fn stem(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(i) if i > 0 => base[..i].to_string(),
        _ => base.to_string(),
    }
}

/// Read `path`'s metadata, or None when the file does not exist / is not an
/// addressable type. A present-but-id-less file yields a FileMeta with an
/// empty `id` (the caller may then stamp one with [`ensure_id`]).
pub fn read_meta(path: &str) -> Option<FileMeta> {
    if !Path::new(path).exists() {
        return None;
    }
    if is_md(path) {
        let head = read_head(Path::new(path), FRONTMATTER_READ_LIMIT);
        let scan = scan_frontmatter(&head);
        let title = if scan.title.is_empty() { stem(path) } else { scan.title };
        Some(FileMeta {
            id: scan.id,
            title,
            tags: scan.tags,
            refs: scan.refs,
        })
    } else if is_pdf(path) {
        let m = read_pdf_metadata(path);
        let title = if m.title.is_empty() { stem(path) } else { m.title };
        Some(FileMeta {
            id: m.id,
            title,
            tags: m.tags,
            refs: Vec::new(),
        })
    } else {
        None
    }
}

/// `path`'s valid id, or None.
pub fn read_id(path: &str) -> Option<String> {
    read_meta(path).map(|m| m.id).filter(|s| is_valid_id(s))
}

/// Ensure `path` carries a valid id, returning it. A markdown file gets the
/// id stamped into its frontmatter (and a default title); a PDF gets it
/// written into its companion json. When a valid id already exists it is
/// returned untouched. `desired` (when a valid id) is used only if the file
/// has none yet (client-supplied id on create). Errors when `path` is missing
/// or not an addressable type.
pub fn ensure_id(path: &str, desired: Option<&str>) -> Result<String> {
    if !is_addressable(path) {
        return Err(Error::BadRequest("not a markdown or pdf file".into()));
    }
    if !Path::new(path).exists() {
        return Err(Error::NotFound);
    }
    let chosen = desired.filter(|s| is_valid_id(s));
    if is_md(path) {
        let bytes = std::fs::read(path).map_err(Error::Io)?;
        let existing = scan_frontmatter(&bytes).id;
        if is_valid_id(&existing) {
            return Ok(existing);
        }
        let id = chosen.map(str::to_string).unwrap_or_else(gen_id);
        if let Some(stamped) = ensure_default_frontmatter(&bytes, &stem(path), &id) {
            write_atomic(Path::new(path), &stamped)?;
        }
        Ok(id)
    } else {
        // PDF: identity lives in the companion json.
        let mut doc = read_pdf_json(path);
        let existing = doc
            .get("metadata")
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .filter(|s| is_valid_id(s))
            .map(str::to_string);
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = chosen.map(str::to_string).unwrap_or_else(gen_id);
        let meta = doc
            .as_object_mut()
            .and_then(|o| {
                o.entry("metadata")
                    .or_insert_with(|| serde_json::json!({}))
                    .as_object_mut()
            });
        if let Some(meta) = meta {
            meta.insert("id".into(), serde_json::Value::String(id.clone()));
        }
        let body = serde_json::to_vec_pretty(&doc)
            .map_err(|e| Error::Other(format!("serialize pdf sidecar: {e}")))?;
        write_atomic(Path::new(&pdf_sidecar_for(path)), &body)?;
        Ok(id)
    }
}

struct PdfMeta {
    id: String,
    title: String,
    tags: Vec<String>,
}

/// Parse a PDF's companion json `metadata` block (id / title / tags),
/// tolerating a missing or malformed sidecar.
fn read_pdf_metadata(pdf_path: &str) -> PdfMeta {
    let doc = read_pdf_json(pdf_path);
    let meta = doc.get("metadata");
    let id = meta
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_id(s))
        .unwrap_or_default()
        .to_string();
    let title = meta
        .and_then(|m| m.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tags = meta
        .and_then(|m| m.get("tags"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    PdfMeta { id, title, tags }
}

/// Read + parse a PDF's companion json, or `{}` when missing / unparseable.
fn read_pdf_json(pdf_path: &str) -> serde_json::Value {
    let sidecar = pdf_sidecar_for(pdf_path);
    match std::fs::read(&sidecar) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn abs(d: &TempDir, name: &str) -> String {
        d.path().join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn md_ensure_stamps_and_persists_id() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.md");
        std::fs::write(&p, b"---\ntitle: t\n---\nbody").unwrap();
        let id = ensure_id(&p, None).unwrap();
        assert!(is_valid_id(&id));
        // Persisted: a second read sees the same id.
        assert_eq!(read_id(&p).as_deref(), Some(id.as_str()));
        // Idempotent.
        assert_eq!(ensure_id(&p, None).unwrap(), id);
    }

    #[test]
    fn md_ensure_honours_desired_id_when_absent() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.md");
        std::fs::write(&p, b"body, no frontmatter").unwrap();
        let id = ensure_id(&p, Some("abcd1234efgh5678")).unwrap();
        assert_eq!(id, "abcd1234efgh5678");
        let m = read_meta(&p).unwrap();
        assert_eq!(m.id, "abcd1234efgh5678");
        assert_eq!(m.title, "note", "default title is the filename stem");
    }

    #[test]
    fn md_default_title_is_stem() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "My Paper.md");
        std::fs::write(&p, b"---\nid: abcd1234efgh5678\n---\nx").unwrap();
        assert_eq!(read_meta(&p).unwrap().title, "My Paper");
    }

    #[test]
    fn pdf_ensure_writes_sidecar_id() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "paper.pdf");
        std::fs::write(&p, b"%PDF-1.4 fake").unwrap();
        let id = ensure_id(&p, None).unwrap();
        assert!(is_valid_id(&id));
        assert_eq!(read_id(&p).as_deref(), Some(id.as_str()));
        // The sidecar landed where util::pdf_sidecar_for points.
        assert!(d.path().join(".paper.assets/paper.json").exists());
    }

    #[test]
    fn pdf_ensure_preserves_existing_sidecar_fields() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "paper.pdf");
        std::fs::write(&p, b"%PDF").unwrap();
        std::fs::create_dir_all(d.path().join(".paper.assets")).unwrap();
        std::fs::write(
            d.path().join(".paper.assets/paper.json"),
            r#"{"metadata":{"title":"keep"},"highlights":[{"id":"h1"}]}"#,
        )
        .unwrap();
        let id = ensure_id(&p, None).unwrap();
        let m = read_meta(&p).unwrap();
        assert_eq!(m.id, id);
        assert_eq!(m.title, "keep", "existing title preserved");
        // Highlights survive the id stamp.
        let raw = std::fs::read_to_string(d.path().join(".paper.assets/paper.json")).unwrap();
        assert!(raw.contains("\"h1\""), "highlights preserved: {raw}");
    }

    #[test]
    fn non_addressable_type_errors() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.txt");
        std::fs::write(&p, b"x").unwrap();
        assert!(read_meta(&p).is_none());
        assert!(ensure_id(&p, None).is_err());
    }

    #[test]
    fn content_path_maps_pdf_to_sidecar_else_self() {
        // A pdf's collab/history content is its sidecar json; md/txt are self.
        assert_eq!(content_path("papers/foo.pdf"), "papers/.foo.assets/foo.json");
        assert_eq!(content_path("notes/foo.md"), "notes/foo.md");
        assert_eq!(content_path("notes/foo.txt"), "notes/foo.txt");
    }

    #[test]
    fn merge_remote_sidecar_keeps_disk_identity_takes_annotations() {
        let disk = br#"{"metadata":{"id":"abcd1234efgh5678","title":"real","tags":["t"],"backrefs":["b1"]},"highlights":[{"id":"old"}]}"#;
        let incoming = br#"{"metadata":{"id":"hackhack00000000","title":"HACK","tags":["evil"],"backrefs":["evil"]},"highlights":[{"id":"new"}],"comments":[{"body":"hi"}]}"#;
        let merged = merge_remote_sidecar(disk, incoming);
        let doc: serde_json::Value = serde_json::from_slice(&merged).unwrap();
        let meta = &doc["metadata"];
        assert_eq!(meta["id"], "abcd1234efgh5678", "remote cannot change id");
        assert_eq!(meta["title"], "real", "remote cannot change title");
        assert_eq!(meta["tags"][0], "t", "remote cannot change tags");
        assert_eq!(meta["backrefs"][0], "b1", "remote cannot change backrefs");
        // Annotation data is taken from the remote write.
        assert_eq!(doc["highlights"][0]["id"], "new", "highlights accepted");
        assert_eq!(doc["comments"][0]["body"], "hi", "comments accepted");
    }

    #[test]
    fn merge_remote_sidecar_drops_identity_absent_on_disk() {
        // Disk sidecar has no identity at all: a remote write cannot mint one.
        let disk = br#"{"highlights":[]}"#;
        let incoming = br#"{"metadata":{"id":"hackhack00000000","title":"HACK"},"highlights":[{"id":"x"}]}"#;
        let merged = merge_remote_sidecar(disk, incoming);
        let doc: serde_json::Value = serde_json::from_slice(&merged).unwrap();
        assert!(doc["metadata"].get("id").is_none(), "remote id dropped");
        assert!(doc["metadata"].get("title").is_none(), "remote title dropped");
        assert_eq!(doc["highlights"][0]["id"], "x", "annotation still accepted");
    }

    #[test]
    fn merge_remote_sidecar_passes_through_non_json() {
        // Unparseable disk or incoming -> incoming returned verbatim.
        assert_eq!(merge_remote_sidecar(b"not json", br#"{"a":1}"#), br#"{"a":1}"#);
        assert_eq!(merge_remote_sidecar(br#"{"a":1}"#, b"not json"), b"not json");
    }
}
