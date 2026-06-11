// Disk-backed SpacePrimitives, one per local root (MultiRoot composes them).
// Dot files are hidden from listings but stay readable by path: the pdf
// sidecar `.<name>.json` and assets dir `.<name>.assets/` (file.md). Traversal
// is rejected at safe_path(), writes are tempfile+rename for crash safety,
// and md coconote:true docs without `id:` get one auto-injected.

use crate::error::{Error, Result};
use crate::frontmatter::{ensure_id, ensure_title, read_id, regen_id, scan_frontmatter};
use super::scan::{
    cached_scan, id_in_use_elsewhere, is_sidecar_json, md_scan, normalize_sidecar_id,
    pdf_sidecar_path, sidecar_scan_pdf, ScanCache,
};
use crate::types::{Entry, EntryType, Perm, SpacePrimitives};

use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::fs;
use walkdir::WalkDir;

pub struct DiskSpacePrimitives {
    root_path: PathBuf,
    scan_cache: ScanCache,
}

impl DiskSpacePrimitives {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let abs = std::fs::canonicalize(root.as_ref())
            .map_err(|e| Error::Other(format!("resolve root {:?}: {e}", root.as_ref())))?;
        let stat = std::fs::metadata(&abs)
            .map_err(|e| Error::Other(format!("stat root {:?}: {e}", abs)))?;
        if !stat.is_dir() {
            return Err(Error::Other(format!("not a directory: {:?}", abs)));
        }
        Ok(Self {
            root_path: abs,
            scan_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Rejects absolute paths and `..` traversal. The leading `.` of a
    /// sidecar / assets folder is allowed (those stay addressable).
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

/// Free fn so the blocking listing closure can use it without borrowing `self`.
fn entry_from_std(rel: &str, kind: EntryType, m: &std::fs::Metadata) -> Entry {
    let mtime_ms = m.modified().map(crate::util::system_time_ms).unwrap_or(0);
    Entry {
        kind,
        path: rel.to_string(),
        size: if kind == EntryType::File { m.len() as i64 } else { 0 },
        mtime: mtime_ms,
        perm: Perm::Rw,
        ..Default::default()
    }
}

#[async_trait]
impl SpacePrimitives for DiskSpacePrimitives {
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>> {
        let root = self.root_path.clone();
        let cache = self.scan_cache.clone();
        let entries = tokio::task::spawn_blocking(move || -> Vec<Entry> {
            let mut out = Vec::new();
            // Paths that may carry a scan cache entry (md files + pdf
            // sidecars). After the walk the cache retains only these,
            // so deletions don't leak entries.
            let mut seen: HashSet<PathBuf> = HashSet::new();
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
                let mut e = entry_from_std(&rel, kind, &meta);
                if kind == EntryType::File && rel.to_ascii_lowercase().ends_with(".md") {
                    seen.insert(path.to_path_buf());
                    // Walk metadata for a symlink describes the link.
                    // Restat so the cache validates against the bytes
                    // actually read.
                    let target_meta = if entry.path_is_symlink() {
                        std::fs::metadata(path).ok()
                    } else {
                        Some(meta.clone())
                    };
                    let cached = cached_scan(&cache, path, target_meta.as_ref(), || md_scan(path));
                    let scan = cached.scan;
                    if !scan.accepted {
                        // Default mode hides excluded rows, "show all
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
                        e.headings = cached.headings;
                        e.wikilinks = cached.wikilinks;
                    }
                }
                if kind == EntryType::File && rel.to_ascii_lowercase().ends_with(".pdf") {
                    // Sidecar is dot-hidden, surface its metadata on the pdf row.
                    let sidecar = pdf_sidecar_path(&root, &rel);
                    if let Some(p) = &sidecar {
                        seen.insert(p.clone());
                    }
                    if let Some(s) = sidecar.as_deref().and_then(sidecar_scan_pdf) {
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
                        // Sidecar-less pdf is unincluded, surfaced so the
                        // UI can offer "Include in Coconote".
                        e.coconote = false;
                    } else {
                        continue;
                    }
                }
                out.push(e);
            }
            cache.lock().unwrap().retain(|p, _| seen.contains(p));
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
        Ok(entry_from_std(path, kind, &meta))
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
        // An in-vault symlink could point outside the root and fs::read
        // would follow it. Canonicalize and require the real target under
        // the root: one extra syscall, still TOCTOU-racy, but stops the
        // plain escape. Intentional out-of-vault symlinks now 400.
        let canon = fs::canonicalize(&full).await.map_err(Error::Io)?;
        if !canon.starts_with(&self.root_path) {
            return Err(Error::PathOutsideRoot);
        }
        let data = fs::read(&full).await.map_err(Error::Io)?;
        let mut e = entry_from_std(path, EntryType::File, &meta);
        e.content_hash = crate::util::blake3_hex(&data);
        Ok((data, e))
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<Entry> {
        let full = self.safe_path(path)?;
        let root = self.root_path.clone();
        let cache = self.scan_cache.clone();
        let path_owned = path.to_string();
        let data_owned = data.to_vec();
        // Frontmatter normalization and the durable tmp+rename write are
        // blocking fs work: keep them off the async workers.
        let bytes_written: Vec<u8> = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let data = data_owned;
            // Normalize coconote:true frontmatter (inject missing id,
            // regen on vault collision, default title to filename) and
            // hash the bytes actually persisted (file.md Frontmatter).
            let injected: Option<Vec<u8>> = if path_owned.to_ascii_lowercase().ends_with(".md") {
                let mut working = ensure_id(&data).map(|(b, _)| b);
                if let Some(id) = read_id(working.as_deref().unwrap_or(&data)) {
                    // file.md: regenerate if it would collide with
                    // another id in the vault.
                    if id_in_use_elsewhere(&cache, &root, &path_owned, &id) {
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
                // file.md: sidecar metadata.id follows the same rule as md
                // frontmatter (inject when missing, regen on collision).
                normalize_sidecar_id(&cache, &root, &path_owned, &data)
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
            Ok(bytes_to_write)
        })
        .await
        .map_err(|e| Error::Other(format!("write join: {e}")))??;
        let mut e = self.get_file_meta(path).await?;
        e.content_hash = crate::util::blake3_hex(&bytes_written);
        if path.to_ascii_lowercase().ends_with(".md") {
            let scan = scan_frontmatter(&bytes_written);
            e.page_id = scan.id;
            e.title = scan.title;
            e.tag = scan.tag;
            e.prereq = scan.prereq;
        } else if path.to_ascii_lowercase().ends_with(".json") {
            // Surface sidecar metadata.id so history records sidecar
            // updates under the pdf page_id (history.md: pdf file set
            // = the sidecar).
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
        let full = self.safe_path(path)?;
        let meta = match fs::metadata(&full).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound),
            Err(e) => return Err(Error::Io(e)),
        };
        if meta.is_dir() {
            // Spec: DELETE /.file/<path> deletes a file OR an empty dir.
            // Non-empty dirs would silently lose data: refuse with a
            // client error (the request is wrong, not the server).
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
        let full = self.safe_path(path)?;
        fs::create_dir_all(&full).await.map_err(Error::Io)?;
        let m = fs::metadata(&full).await.map_err(Error::Io)?;
        Ok(entry_from_std(path, EntryType::Dir, &m))
    }

    /// Raw file list under a prefix: no dot-file filter, no md/pdf
    /// restriction. Used to gather `.<name>.assets/` images for history
    /// snapshots (file.md).
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
        s.write_file(".p.json", body).await.unwrap();
        let (data, _) = s.read_file(".p.json").await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        let id = v["metadata"]["id"].as_str().unwrap();
        assert_eq!(id.len(), 16, "injected 16-char id, got {id:?}");
    }

    #[tokio::test]
    async fn sidecar_put_keeps_own_id() {
        let (_d, s) = tdir();
        let body = br#"{"metadata":{"id":"aaaaaaaaaaaaaaaa","coconote":true},"highlights":[]}"#;
        s.write_file(".p.json", body).await.unwrap();
        // Re-save with the same id must NOT regenerate against itself.
        s.write_file(".p.json", body).await.unwrap();
        let (data, _) = s.read_file(".p.json").await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(v["metadata"]["id"], "aaaaaaaaaaaaaaaa");
    }

    #[tokio::test]
    async fn sidecar_put_regenerates_colliding_id() {
        let (_d, s) = tdir();
        s.write_file("note.md", b"---\nid: aaaaaaaaaaaaaaaa\ncoconote: true\n---\nx\n")
            .await
            .unwrap();
        let body = br#"{"metadata":{"id":"aaaaaaaaaaaaaaaa","coconote":true},"highlights":[]}"#;
        s.write_file(".p.json", body).await.unwrap();
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
            .write_file("note.md", b"hello")
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
    async fn listing_rescans_externally_changed_file() {
        let (d, s) = tdir();
        std::fs::write(
            d.path().join("a.md"),
            "---\ncoconote: true\ntitle: old\n---\nx",
        )
        .unwrap();
        let list = s.fetch_file_list().await.unwrap();
        assert_eq!(list[0].title, "old");
        // External edit with a different size, so stat validation must
        // miss even on coarse mtime granularity.
        std::fs::write(
            d.path().join("a.md"),
            "---\ncoconote: true\ntitle: newer\n---\nxyz",
        )
        .unwrap();
        let list = s.fetch_file_list().await.unwrap();
        assert_eq!(list[0].title, "newer", "scan cache must not serve stale data");
    }

    #[tokio::test]
    async fn collision_detected_through_listing_primed_cache() {
        let (d, s) = tdir();
        std::fs::write(
            d.path().join("first.md"),
            "---\ncoconote: true\nid: aaaaaaaaaaaaaaaa\n---\nx",
        )
        .unwrap();
        // Prime the cache, then make the id walk consume the cached
        // entry: regenerate-on-collision (file.md) must still fire.
        s.fetch_file_list().await.unwrap();
        s.write_file("second.md", b"---\ncoconote: true\nid: aaaaaaaaaaaaaaaa\n---\ny")
            .await
            .unwrap();
        let (bytes, _) = s.read_file("second.md").await.unwrap();
        assert_ne!(read_id(&bytes).unwrap(), "aaaaaaaaaaaaaaaa");
    }

    #[tokio::test]
    async fn read_only_wrapper_rejects_writes() {
        let d = TempDir::new().unwrap();
        let disk = Arc::new(DiskSpacePrimitives::new(d.path()).unwrap());
        let s = crate::space::ReadOnlySpacePrimitives::new(disk);
        let err = s.write_file("x.md", b"x").await.unwrap_err();
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
        s.write_file("second.md", b"---\ncoconote: true\nid: aaaaaaaaaaaaaaaa\n---\ny")
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
        s.write_file("note.md", b"---\ncoconote: true\nid: bbbbbbbbbbbbbbbb\n---\ny")
            .await
            .unwrap();
        let (bytes, _) = s.read_file("note.md").await.unwrap();
        assert_ne!(read_id(&bytes).unwrap(), "bbbbbbbbbbbbbbbb");
    }
}
