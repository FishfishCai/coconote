// Disk-backed SpacePrimitives. One backend per local root; the
// MultiRootSpacePrimitives layer composes several under named prefixes.
//
// - Hidden dot files / dirs are skipped in listings BUT remain readable
//   by path. The PDF sidecar `.<name>.json` and the assets folder
//   `.<name>.assets/` (file.md, `<name>` = basename without extension)
//   follow this convention — they are addressable via `/.file/.<name>.json`
//   but never appear as their own row in `GET /.file`.
// - Path traversal is rejected at safe_path() (Error::PathOutsideRoot).
// - Writes go through a tempfile + rename for crash safety and an
//   md `coconote:true` doc without `id:` gets one auto-injected.

use crate::error::{Error, Result};
use crate::frontmatter::{
    ensure_id, ensure_title, new_id, read_head, read_id, regen_id, scan_frontmatter,
    scan_headings, scan_wikilinks, BODY_SCAN_LIMIT, FRONTMATTER_READ_LIMIT,
};
use crate::types::{Entry, EntryType, Perm, SpacePrimitives};

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tokio::fs;
use walkdir::WalkDir;

pub struct DiskSpacePrimitives {
    root_path: PathBuf,
    read_only: bool,
}

impl DiskSpacePrimitives {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        Self::with_read_only(root, false)
    }

    pub fn with_read_only(root: impl AsRef<Path>, read_only: bool) -> Result<Self> {
        let abs = std::fs::canonicalize(root.as_ref())
            .map_err(|e| Error::Other(format!("resolve root {:?}: {e}", root.as_ref())))?;
        let stat = std::fs::metadata(&abs)
            .map_err(|e| Error::Other(format!("stat root {:?}: {e}", abs)))?;
        if !stat.is_dir() {
            return Err(Error::Other(format!("not a directory: {:?}", abs)));
        }
        Ok(Self {
            root_path: abs,
            read_only,
        })
    }

    /// Rejects absolute paths and any `..` traversal. The leading `.` of
    /// a sidecar / assets folder is allowed — those are addressable.
    fn safe_path(&self, p: &str) -> Result<PathBuf> {
        let clean = Path::new(p);
        if clean.is_absolute() {
            return Err(Error::PathOutsideRoot);
        }
        for comp in clean.components() {
            use std::path::Component::*;
            match comp {
                ParentDir => return Err(Error::PathOutsideRoot),
                Prefix(_) | RootDir => return Err(Error::PathOutsideRoot),
                _ => {}
            }
        }
        Ok(self.root_path.join(clean))
    }
}

/// Listing/metadata row from std metadata. Free function so the
/// blocking listing closure can use it without borrowing `self`.
fn entry_from_std(rel: &str, kind: EntryType, m: &std::fs::Metadata, read_only: bool) -> Entry {
    let mtime_ms = m.modified().map(crate::util::system_time_ms).unwrap_or(0);
    Entry {
        kind,
        path: rel.to_string(),
        size: if kind == EntryType::File { m.len() as i64 } else { 0 },
        mtime: mtime_ms,
        perm: if read_only { Perm::Ro } else { Perm::Rw },
        ..Default::default()
    }
}

pub fn content_hash(bytes: &[u8]) -> String {
    crate::util::blake3_hex(bytes)
}

#[async_trait]
impl SpacePrimitives for DiskSpacePrimitives {
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>> {
        let root = self.root_path.clone();
        let read_only = self.read_only;
        let entries = tokio::task::spawn_blocking(move || -> Vec<Entry> {
            let mut out = Vec::new();
            for entry in WalkDir::new(&root).into_iter().filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                e.file_name()
                    .to_str()
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(true)
            }) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!("walkdir under {}: {e}", root.display());
                        continue;
                    }
                };
                if entry.depth() == 0 {
                    continue;
                }
                let path = entry.path();
                let rel = path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if rel.is_empty() {
                    continue;
                }
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("stat {}: {e}", path.display());
                        continue;
                    }
                };
                let kind = if entry.file_type().is_dir() {
                    EntryType::Dir
                } else {
                    EntryType::File
                };
                let mut e = entry_from_std(&rel, kind, &meta, read_only);
                if kind == EntryType::File && rel.to_ascii_lowercase().ends_with(".md") {
                    // One head read per md row feeds all three scanners
                    // (scan_frontmatter caps itself at 16 KiB inside).
                    let head = read_head(path, BODY_SCAN_LIMIT);
                    let scan = scan_frontmatter(&head);
                    if !scan.accepted {
                        // Default mode hides excluded rows; "show all
                        // supported files" mode keeps them with coconote:false.
                        if !include_excluded {
                            continue;
                        }
                        e.coconote = false;
                    }
                    e.page_id = scan.id;
                    e.title = scan.title;
                    e.tag = scan.tag;
                    e.prereq = scan.prereq;
                    if e.coconote {
                        e.headings = scan_headings(&head);
                        e.wikilinks = scan_wikilinks(&head);
                    }
                }
                if kind == EntryType::File && rel.to_ascii_lowercase().ends_with(".pdf") {
                    // pdf sidecar `.<name>.json` is hidden (dot-prefix),
                    // but we still surface its metadata on the pdf row.
                    if let Some(s) = sidecar_scan_pdf(&root, &rel) {
                        if !s.accepted {
                            if !include_excluded {
                                continue;
                            }
                            e.coconote = false;
                        }
                        e.page_id = s.id;
                        e.title = s.title;
                        e.tag = s.tag;
                    } else if include_excluded {
                        // PDF without sidecar is unincluded; surface it
                        // so the UI can offer "Include in Coconote".
                        e.coconote = false;
                    } else {
                        continue;
                    }
                }
                out.push(e);
            }
            out
        })
        .await
        .map_err(|e| Error::Other(format!("walkdir join: {e}")))?;
        Ok(entries)
    }

    async fn get_file_meta(&self, path: &str) -> Result<Entry> {
        let full = self.safe_path(path)?;
        let meta = match fs::metadata(&full).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound),
            Err(e) => return Err(Error::Io(e)),
        };
        let kind = if meta.is_dir() {
            EntryType::Dir
        } else {
            EntryType::File
        };
        Ok(entry_from_std(path, kind, &meta, self.read_only))
    }

    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let full = self.safe_path(path)?;
        let meta = match fs::metadata(&full).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound),
            Err(e) => return Err(Error::Io(e)),
        };
        if meta.is_dir() {
            return Err(Error::NotFound);
        }
        // An in-vault symlink could point outside the root (link →
        // /etc/passwd) and would be followed by fs::read. Canonicalize
        // and require the real target to stay under the root. One extra
        // syscall per read and still TOCTOU-racy, but it stops the
        // plain escape; intentional symlinks out of the vault stop
        // resolving (they 400).
        let canon = fs::canonicalize(&full).await.map_err(Error::Io)?;
        if !canon.starts_with(&self.root_path) {
            return Err(Error::PathOutsideRoot);
        }
        let data = fs::read(&full).await.map_err(Error::Io)?;
        let mut e = entry_from_std(path, EntryType::File, &meta, self.read_only);
        e.content_hash = content_hash(&data);
        Ok((data, e))
    }

    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mtime_hint: Option<i64>,
    ) -> Result<Entry> {
        if self.read_only {
            return Err(Error::NotAllowed);
        }
        let full = self.safe_path(path)?;
        let root = self.root_path.clone();
        let path_owned = path.to_string();
        let data_owned = data.to_vec();
        // Frontmatter normalization (id inject / collision regen /
        // title default) plus the durable tmp+rename write are all
        // blocking fs work — keep them off the async workers.
        let bytes_written: Vec<u8> = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let data = data_owned;
            // Normalize coconote:true frontmatter (inject id when
            // missing, regen id on vault collision, default title to
            // filename). Hash the bytes we actually persist
            // (file.md §Frontmatter).
            let injected: Option<Vec<u8>> = if path_owned.to_ascii_lowercase().ends_with(".md") {
                let mut working = ensure_id(&data).map(|(b, _)| b);
                if let Some(id) = read_id(working.as_deref().unwrap_or(&data)) {
                    // file.md: "on write, regenerated if it would
                    // collide with another id in the vault".
                    if id_in_use_elsewhere(&root, &path_owned, &id) {
                        if let Some((regen_bytes, _)) =
                            regen_id(working.as_deref().unwrap_or(&data))
                        {
                            working = Some(regen_bytes);
                        }
                    }
                }
                // Title default = basename without .md
                let basename_no_ext = Path::new(&path_owned)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                if !basename_no_ext.is_empty() {
                    if let Some(b) =
                        ensure_title(working.as_deref().unwrap_or(&data), basename_no_ext)
                    {
                        working = Some(b);
                    }
                }
                working
            } else if is_sidecar_json(&path_owned) {
                // file.md: sidecar metadata.id follows the SAME rule as
                // md frontmatter — inject when missing, regenerate on a
                // vault collision.
                normalize_sidecar_id(&root, &path_owned, &data)
            } else {
                None
            };
            let bytes_to_write = injected.unwrap_or(data);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(Error::Io)?;
            }
            let parent = full.parent().unwrap_or_else(|| Path::new("."));
            let mut tmp = tempfile::Builder::new()
                .prefix(".coconote.write.")
                .tempfile_in(parent)
                .map_err(Error::Io)?;
            use std::io::Write as _;
            tmp.write_all(&bytes_to_write).map_err(Error::Io)?;
            tmp.flush().map_err(Error::Io)?;
            tmp.as_file().sync_all().map_err(Error::Io)?;
            tmp.persist(&full).map_err(|e| Error::Io(e.error))?;
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            if let Some(ms) = mtime_hint {
                if ms > 0 {
                    let when =
                        std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
                    let _ = filetime::set_file_mtime(
                        &full,
                        filetime::FileTime::from_system_time(when),
                    );
                }
            }
            Ok(bytes_to_write)
        })
        .await
        .map_err(|e| Error::Other(format!("write join: {e}")))??;
        let mut e = self.get_file_meta(path).await?;
        e.content_hash = content_hash(&bytes_written);
        if path.to_ascii_lowercase().ends_with(".md") {
            let scan = scan_frontmatter(&bytes_written);
            e.page_id = scan.id;
            e.title = scan.title;
            e.tag = scan.tag;
            e.prereq = scan.prereq;
        } else if path.to_ascii_lowercase().ends_with(".json") {
            // PDF sidecar `.<name>.json` — surface metadata.id so the
            // history layer can record sidecar updates under the PDF
            // page_id (history.md: pdf page's file set = sidecar).
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes_written) {
                if let Some(meta) = v.get("metadata") {
                    if let Some(id) = meta.get("id").and_then(|x| x.as_str()) {
                        e.page_id = id.to_string();
                    }
                    if let Some(t) = meta.get("title").and_then(|x| x.as_str()) {
                        e.title = t.to_string();
                    }
                    if let Some(tags) = meta.get("tag").and_then(|x| x.as_array()) {
                        e.tag = tags
                            .iter()
                            .filter_map(|x| x.as_str())
                            .map(|s| s.to_string())
                            .collect();
                    }
                }
            }
        }
        Ok(e)
    }

    async fn delete_file(&self, path: &str) -> Result<()> {
        if self.read_only {
            return Err(Error::NotAllowed);
        }
        let full = self.safe_path(path)?;
        let meta = match fs::metadata(&full).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound),
            Err(e) => return Err(Error::Io(e)),
        };
        if meta.is_dir() {
            // Spec: DELETE /.file/<path> deletes a file OR an empty
            // directory. Non-empty dirs would silently lose data;
            // refuse with a client error (the request is wrong, the
            // server isn't broken).
            match fs::remove_dir(&full).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                    Err(Error::BadRequest("directory not empty".into()))
                }
                Err(e) => Err(Error::Io(e)),
            }
        } else {
            match fs::remove_file(&full).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Error::NotFound),
                Err(e) => Err(Error::Io(e)),
            }
        }
    }

    async fn create_dir(&self, path: &str) -> Result<Entry> {
        if self.read_only {
            return Err(Error::NotAllowed);
        }
        let full = self.safe_path(path)?;
        fs::create_dir_all(&full).await.map_err(Error::Io)?;
        let m = fs::metadata(&full).await.map_err(Error::Io)?;
        Ok(entry_from_std(path, EntryType::Dir, &m, self.read_only))
    }

    /// Raw file list under a path prefix — no dot-file filter, no
    /// md/pdf restriction. Walks the disk under `<root>/<prefix>` and
    /// returns every file's relative path. Used to gather
    /// `.<name>.assets/` images for history snapshots (file.md).
    async fn list_under_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let prefix = prefix.trim_end_matches('/');
        let full = self.root_path.join(prefix);
        if !full.exists() {
            return Ok(Vec::new());
        }
        let root = self.root_path.clone();
        let out = tokio::task::spawn_blocking(move || -> Vec<String> {
            let mut out = Vec::new();
            for entry in WalkDir::new(&full).into_iter().flatten() {
                if !entry.file_type().is_file() {
                    continue;
                }
                if let Ok(rel) = entry.path().strip_prefix(&root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
            out
        })
        .await
        .unwrap_or_default();
        Ok(out)
    }
}

/// True when another file in this root already claims `id`. Reads only
/// the head (16 KiB) of each md for the frontmatter id, and each pdf
/// sidecar's `metadata.id` — both share the vault id namespace
/// (file.md: "same generation rule as markdown"). Per-root only: ids
/// are minted while writing into one root, and a listing-wide
/// cross-root pass isn't worth its cost here.
fn id_in_use_elsewhere(root: &Path, self_rel: &str, id: &str) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if p.is_dir() {
                // Dot dirs (.git, .obsidian, `.<name>.assets/`) can't
                // host vault pages.
                if !name.starts_with('.') {
                    stack.push(p);
                }
                continue;
            }
            if name.starts_with('.') {
                // PDF sidecar `.<stem>.json` — skip the file being
                // written itself, or every sidecar save would "collide"
                // with its own on-disk copy.
                if name.len() > ".json".len() + 1 && name.ends_with(".json") {
                    let rel = p
                        .strip_prefix(root)
                        .ok()
                        .and_then(|r| r.to_str())
                        .map(|s| s.replace('\\', "/"))
                        .unwrap_or_default();
                    if rel != self_rel && sidecar_id(&p).as_deref() == Some(id) {
                        return true;
                    }
                }
                continue;
            }
            if p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                // Force forward slashes; the listing protocol uses
                // URL-style paths.
                let rel = p
                    .strip_prefix(root)
                    .ok()
                    .and_then(|r| r.to_str())
                    .map(|s| s.replace('\\', "/"))
                    .unwrap_or_default();
                if rel == self_rel {
                    continue;
                }
                let head = read_head(&p, FRONTMATTER_READ_LIMIT);
                if read_id(&head).as_deref() == Some(id) {
                    return true;
                }
            }
        }
    }
    false
}

/// Dot-prefixed `.<stem>.json` basename — the PDF sidecar convention
/// (file.md). Matches the manifest main-file derivation in history.rs.
fn is_sidecar_json(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.starts_with('.')
        && name.len() > ".json".len() + 1
        && name.to_ascii_lowercase().ends_with(".json")
}

/// Apply the md id rule to a sidecar body: inject `metadata.id` when
/// missing/empty, regenerate when it collides with another file's id.
/// Returns None when the body is fine as-is (or isn't conforming JSON —
/// the bytes are then persisted untouched).
fn normalize_sidecar_id(root: &Path, self_rel: &str, data: &[u8]) -> Option<Vec<u8>> {
    let mut v: serde_json::Value = serde_json::from_slice(data).ok()?;
    let meta = v.get_mut("metadata")?.as_object_mut()?;
    let cur = meta
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if !cur.is_empty() && !id_in_use_elsewhere(root, self_rel, &cur) {
        return None;
    }
    meta.insert("id".into(), serde_json::Value::String(new_id()));
    serde_json::to_vec_pretty(&v).ok()
}

/// `metadata.id` from a pdf sidecar. Head-read first; only a sidecar
/// larger than the head limit (truncated JSON) falls back to a full
/// read.
fn sidecar_id(p: &Path) -> Option<String> {
    let head = read_head(p, FRONTMATTER_READ_LIMIT);
    let v: serde_json::Value = match serde_json::from_slice(&head) {
        Ok(v) => v,
        Err(_) if head.len() == FRONTMATTER_READ_LIMIT => {
            serde_json::from_slice(&std::fs::read(p).ok()?).ok()?
        }
        Err(_) => return None,
    };
    Some(v.get("metadata")?.get("id")?.as_str()?.to_string())
}

/// Read the PDF sidecar `.<name>.json` alongside `rel` (file.md) and
/// return a ScanResult-shaped tuple — kept compatible with the md scan
/// path. `<name>` is the basename WITHOUT the `.pdf` extension, so
/// `papers/foo.pdf` pairs with `papers/.foo.json`.
fn sidecar_scan_pdf(root: &Path, rel: &str) -> Option<PdfSidecarScan> {
    let stem = Path::new(rel).file_stem()?.to_string_lossy().into_owned();
    let mut sidecar = root.join(rel);
    sidecar.set_file_name(format!(".{stem}.json"));
    let body = std::fs::read(&sidecar).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let m = v.get("metadata")?;
    let accepted = m.get("coconote").and_then(|x| x.as_bool()).unwrap_or(false);
    Some(PdfSidecarScan {
        accepted,
        id: m.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        title: m.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        tag: m
            .get("tag")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

struct PdfSidecarScan {
    accepted: bool,
    id: String,
    title: String,
    tag: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tdir() -> (TempDir, DiskSpacePrimitives) {
        let d = TempDir::new().unwrap();
        let s = DiskSpacePrimitives::new(d.path()).unwrap();
        (d, s)
    }

    #[tokio::test]
    async fn sidecar_put_injects_missing_id() {
        let (_d, s) = tdir();
        let body = br#"{"metadata":{"coconote":true,"title":"p","tag":[]},"highlights":[],"anchors":[],"comments":[]}"#;
        s.write_file(".p.json", body, None).await.unwrap();
        let (data, _) = s.read_file(".p.json").await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        let id = v["metadata"]["id"].as_str().unwrap();
        assert_eq!(id.len(), 16, "injected 16-char id, got {id:?}");
    }

    #[tokio::test]
    async fn sidecar_put_keeps_own_id() {
        let (_d, s) = tdir();
        let body = br#"{"metadata":{"id":"aaaaaaaaaaaaaaaa","coconote":true},"highlights":[]}"#;
        s.write_file(".p.json", body, None).await.unwrap();
        // Re-save with the same id — must NOT regenerate against itself.
        s.write_file(".p.json", body, None).await.unwrap();
        let (data, _) = s.read_file(".p.json").await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(v["metadata"]["id"], "aaaaaaaaaaaaaaaa");
    }

    #[tokio::test]
    async fn sidecar_put_regenerates_colliding_id() {
        let (_d, s) = tdir();
        s.write_file("note.md", b"---\nid: aaaaaaaaaaaaaaaa\ncoconote: true\n---\nx\n", None)
            .await
            .unwrap();
        let body = br#"{"metadata":{"id":"aaaaaaaaaaaaaaaa","coconote":true},"highlights":[]}"#;
        s.write_file(".p.json", body, None).await.unwrap();
        let (data, _) = s.read_file(".p.json").await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        let id = v["metadata"]["id"].as_str().unwrap();
        assert_ne!(id, "aaaaaaaaaaaaaaaa", "colliding sidecar id must regenerate");
        assert_eq!(id.len(), 16);
    }

    #[tokio::test]
    async fn roundtrip_write_read() {
        let (_d, s) = tdir();
        let m = s
            .write_file("note.md", b"hello", None)
            .await
            .expect("write");
        assert_eq!(m.size, 5);
        let (data, _m) = s.read_file("note.md").await.unwrap();
        assert_eq!(data, b"hello");
    }

    #[tokio::test]
    async fn reject_traversal() {
        let (_d, s) = tdir();
        let err = s.read_file("../etc/passwd").await.unwrap_err();
        assert!(matches!(err, Error::PathOutsideRoot));
    }

    #[tokio::test]
    async fn list_skips_md_without_coconote_true() {
        let (d, s) = tdir();
        std::fs::write(d.path().join("a.md"), "---\ncoconote: true\n---\nx").unwrap();
        std::fs::write(d.path().join("b.md"), "---\ncoconote: false\n---\nx").unwrap();
        std::fs::write(d.path().join("c.md"), "no frontmatter").unwrap();
        let list = s.fetch_file_list().await.unwrap();
        let paths: Vec<&str> = list.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md"]);
    }

    #[tokio::test]
    async fn list_includes_dirs() {
        let (d, s) = tdir();
        std::fs::create_dir(d.path().join("sub")).unwrap();
        let list = s.fetch_file_list().await.unwrap();
        assert!(list
            .iter()
            .any(|e| e.path == "sub" && matches!(e.kind, EntryType::Dir)));
    }

    #[tokio::test]
    async fn pdf_visible_only_with_sidecar_coconote_true() {
        let (d, s) = tdir();
        std::fs::write(d.path().join("paper.pdf"), b"%PDF-1.4").unwrap();
        let list = s.fetch_file_list().await.unwrap();
        assert!(!list.iter().any(|e| e.path == "paper.pdf"));
        std::fs::write(
            d.path().join(".paper.json"),
            r#"{"metadata":{"coconote":true,"id":"abc","title":"P","tag":[]}}"#,
        )
        .unwrap();
        let list = s.fetch_file_list().await.unwrap();
        let row = list.iter().find(|e| e.path == "paper.pdf").unwrap();
        assert_eq!(row.page_id, "abc");
        assert_eq!(row.title, "P");
    }

    #[tokio::test]
    async fn read_only_rejects_writes() {
        let d = TempDir::new().unwrap();
        let s = DiskSpacePrimitives::with_read_only(d.path(), true).unwrap();
        let err = s.write_file("x.md", b"x", None).await.unwrap_err();
        assert!(matches!(err, Error::NotAllowed));
    }

    #[tokio::test]
    async fn create_dir_then_delete_empty() {
        let (_d, s) = tdir();
        s.create_dir("inner").await.unwrap();
        s.delete_file("inner").await.unwrap();
        assert!(matches!(
            s.get_file_meta("inner").await.unwrap_err(),
            Error::NotFound
        ));
    }

    #[tokio::test]
    async fn delete_non_empty_dir_is_bad_request() {
        let (d, s) = tdir();
        std::fs::create_dir(d.path().join("full")).unwrap();
        std::fs::write(d.path().join("full/x.txt"), b"x").unwrap();
        assert!(matches!(
            s.delete_file("full").await.unwrap_err(),
            Error::BadRequest(_)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_rejects_symlink_escaping_root() {
        let (d, s) = tdir();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"top secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            d.path().join("leak.txt"),
        )
        .unwrap();
        assert!(matches!(
            s.read_file("leak.txt").await.unwrap_err(),
            Error::PathOutsideRoot
        ));
    }

    #[tokio::test]
    async fn write_regenerates_colliding_id() {
        let (d, s) = tdir();
        std::fs::write(
            d.path().join("first.md"),
            "---\ncoconote: true\nid: aaaaaaaaaaaaaaaa\n---\nx",
        )
        .unwrap();
        s.write_file(
            "second.md",
            b"---\ncoconote: true\nid: aaaaaaaaaaaaaaaa\n---\ny",
            None,
        )
        .await
        .unwrap();
        let (bytes, _) = s.read_file("second.md").await.unwrap();
        let id = read_id(&bytes).unwrap();
        assert_ne!(id, "aaaaaaaaaaaaaaaa");
    }

    #[tokio::test]
    async fn write_regenerates_id_colliding_with_sidecar() {
        let (d, s) = tdir();
        std::fs::write(d.path().join("paper.pdf"), b"%PDF").unwrap();
        std::fs::write(
            d.path().join(".paper.json"),
            r#"{"metadata":{"coconote":true,"id":"bbbbbbbbbbbbbbbb"}}"#,
        )
        .unwrap();
        s.write_file(
            "note.md",
            b"---\ncoconote: true\nid: bbbbbbbbbbbbbbbb\n---\ny",
            None,
        )
        .await
        .unwrap();
        let (bytes, _) = s.read_file("note.md").await.unwrap();
        assert_ne!(read_id(&bytes).unwrap(), "bbbbbbbbbbbbbbbb");
    }
}
