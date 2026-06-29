// Absolute-path file access for the file-centric redesign. There is no
// vault root: every endpoint addresses a file by its absolute path
// (`?path=`), the access boundary (loopback open-set / remote refs closure)
// is enforced upstream in `boundary`, and these functions only guard
// against path traversal (`..`) and NUL bytes, then read/write the bytes.
//
// Writes are tempfile+rename for crash safety and stamp a default
// frontmatter (id + title) onto a `.md` file that lacks one (design.md: a
// markdown file gets a default frontmatter and a minted id on first save).
// Per-file read-only (design.md L318): a file whose on-disk read-only bit is
// set reports `X-Permission: ro` and rejects writes with 405. There is no
// whole-instance read-only mode.

use crate::error::{Error, Result};
use crate::frontmatter::ensure_default_frontmatter;
use crate::types::{Entry, Perm};
use crate::util::{gen_id, is_valid_id};

use std::path::{Path, PathBuf};
use tokio::fs;

/// Thin file accessor handed to handlers. Stateless: paths are absolute, so
/// there is no root to hold and no global flag to carry. Per-file read-only is
/// read from each file's on-disk permission bit.
#[derive(Clone, Copy, Default)]
pub struct Disk;

impl Disk {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_file_meta(&self, path: &str) -> Result<Entry> {
        let full = safe_path(path)?;
        let meta = stat(&full).await?;
        if meta.is_dir() {
            return Err(Error::NotFound);
        }
        let perm = perm_from(&meta);
        Ok(entry_from_std(&meta, perm))
    }

    pub async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let full = safe_path(path)?;
        let meta = stat(&full).await?;
        if meta.is_dir() {
            return Err(Error::NotFound);
        }
        let perm = perm_from(&meta);
        let data = fs::read(&full).await.map_err(Error::Io)?;
        let mut e = entry_from_std(&meta, perm);
        e.content_hash = crate::util::blake3_hex(&data);
        Ok((data, e))
    }

    /// Write `data` to `path`. For `.md` files a default frontmatter block
    /// (id + title) is stamped when missing: the id is `desired_id` when a
    /// caller supplies a valid one (client-chosen id on create), else the
    /// file's existing id, else a freshly minted one. Returns metadata whose
    /// content_hash matches the bytes actually persisted.
    pub async fn write_file(&self, path: &str, data: &[u8], desired_id: Option<&str>) -> Result<Entry> {
        let full = safe_path(path)?;
        // Per-file read-only (design.md L318): the atomic temp+rename writer
        // would otherwise replace an on-disk read-only file (rename is gated by
        // the directory, not the file's bit), so honour the bit explicitly. A
        // not-yet-existing file (fresh create) has no bit to check.
        if let Ok(meta) = fs::metadata(&full).await {
            if meta.permissions().readonly() {
                return Err(Error::NotAllowed);
            }
        }
        let path_owned = path.to_string();
        let data_owned = data.to_vec();
        // Pre-pick an id for a md file that ends up needing one; an existing
        // valid id in the doc always wins inside ensure_default_frontmatter.
        let fallback_id = desired_id
            .filter(|s| is_valid_id(s))
            .map(str::to_string)
            .unwrap_or_else(gen_id);
        let bytes_written: Vec<u8> = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let bytes_to_write = if path_owned.to_ascii_lowercase().ends_with(".md") {
                let default_title = Path::new(&path_owned)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                ensure_default_frontmatter(&data_owned, default_title, &fallback_id)
                    .unwrap_or(data_owned)
            } else {
                data_owned
            };
            crate::util::write_atomic(&full, &bytes_to_write)?;
            Ok(bytes_to_write)
        })
        .await
        .map_err(|e| Error::Other(format!("write join: {e}")))??;
        let mut e = self.get_file_meta(path).await?;
        e.content_hash = crate::util::blake3_hex(&bytes_written);
        Ok(e)
    }

    pub async fn delete_file(&self, path: &str) -> Result<()> {
        let full = safe_path(path)?;
        let meta = stat(&full).await?;
        if meta.is_dir() {
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
}

/// Resolve a request path to an absolute filesystem path. The redesign
/// addresses files by absolute path, so a relative path is taken as-is but
/// any `..` component or NUL byte is rejected (traversal guard). The
/// access boundary (which absolute paths are reachable) is enforced
/// elsewhere. This is only the anti-traversal and anti-NUL check.
pub fn safe_path(p: &str) -> Result<PathBuf> {
    if p.is_empty() {
        return Err(Error::BadRequest("empty path".into()));
    }
    if p.as_bytes().contains(&0) {
        return Err(Error::BadRequest("path contains NUL".into()));
    }
    let clean = Path::new(p);
    // Reject any `..` component (via util::contains_parent_dir) so no request
    // can traverse out of the addressed file's directory.
    if crate::util::contains_parent_dir(clean) {
        return Err(Error::PathOutsideRoot);
    }
    Ok(clean.to_path_buf())
}

/// Per-file permission (design.md L318): `ro` when the file carries the
/// on-disk read-only bit, else `rw`.
fn perm_from(meta: &std::fs::Metadata) -> Perm {
    if meta.permissions().readonly() {
        Perm::Ro
    } else {
        Perm::Rw
    }
}

async fn stat(full: &Path) -> Result<std::fs::Metadata> {
    match fs::metadata(full).await {
        Ok(m) => Ok(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Error::NotFound),
        Err(e) => Err(Error::Io(e)),
    }
}

fn entry_from_std(m: &std::fs::Metadata, perm: Perm) -> Entry {
    let mtime_ms = m.modified().map(crate::util::system_time_ms).unwrap_or(0);
    Entry {
        mtime: mtime_ms,
        perm,
        content_hash: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn disk() -> Disk {
        Disk::new()
    }

    fn abs(d: &TempDir, name: &str) -> String {
        d.path().join(name).to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn roundtrip_write_read() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.txt");
        let m = disk().write_file(&p, b"hello", None).await.unwrap();
        assert_eq!(m.content_hash, crate::util::blake3_hex(b"hello"));
        let (data, _m) = disk().read_file(&p).await.unwrap();
        assert_eq!(data, b"hello");
    }

    #[tokio::test]
    async fn md_write_stamps_default_frontmatter_and_id() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.md");
        disk().write_file(&p, b"body only", None).await.unwrap();
        let (data, _) = disk().read_file(&p).await.unwrap();
        let s = String::from_utf8(data).unwrap();
        assert!(s.starts_with("---\n"), "default frontmatter prepended: {s:?}");
        assert!(s.contains("title: note"));
        assert!(s.ends_with("body only"));
        let scan = crate::frontmatter::scan_frontmatter(s.as_bytes());
        assert!(crate::util::is_valid_id(&scan.id), "a fresh id was stamped: {s:?}");
    }

    #[tokio::test]
    async fn md_write_honours_desired_id() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "fresh.md");
        disk().write_file(&p, b"body", Some("abcd1234efgh5678")).await.unwrap();
        let (data, _) = disk().read_file(&p).await.unwrap();
        assert_eq!(crate::frontmatter::scan_frontmatter(&data).id, "abcd1234efgh5678");
    }

    #[tokio::test]
    async fn reject_traversal() {
        let err = disk().read_file("/tmp/../etc/passwd").await.unwrap_err();
        assert!(matches!(err, Error::PathOutsideRoot));
    }

    #[tokio::test]
    async fn per_file_readonly_reports_ro_and_blocks_write() {
        // design.md L318: a file whose on-disk read-only bit is set reports
        // X-Permission: ro and rejects writes with 405, even on an rw server.
        let d = TempDir::new().unwrap();
        let p = abs(&d, "locked.md");
        let s = disk(); // rw server
        s.write_file(&p, b"original", None).await.unwrap();
        // Flip the on-disk read-only bit.
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&p, perms).unwrap();
        // GET reports ro.
        let (_, e) = s.read_file(&p).await.unwrap();
        assert_eq!(e.perm, Perm::Ro, "on-disk read-only file reports ro");
        assert_eq!(s.get_file_meta(&p).await.unwrap().perm, Perm::Ro);
        // A write is refused with 405 (NotAllowed) despite the rw server.
        assert!(matches!(
            s.write_file(&p, b"changed", None).await.unwrap_err(),
            Error::NotAllowed
        ));
        // Restore writability so TempDir can clean up everywhere.
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&p, perms).unwrap();
        // A writable file is rw again and accepts writes.
        assert_eq!(s.read_file(&p).await.unwrap().1.perm, Perm::Rw);
        s.write_file(&p, b"changed", None).await.unwrap();
    }

    #[tokio::test]
    async fn delete_removes_file_then_not_found() {
        let d = TempDir::new().unwrap();
        let p = abs(&d, "note.md");
        disk().write_file(&p, b"x", None).await.unwrap();
        disk().delete_file(&p).await.unwrap();
        assert!(matches!(disk().delete_file(&p).await.unwrap_err(), Error::NotFound));
    }

    #[tokio::test]
    async fn delete_non_empty_dir_is_bad_request() {
        let d = TempDir::new().unwrap();
        std::fs::create_dir(d.path().join("full")).unwrap();
        std::fs::write(d.path().join("full/x.txt"), b"x").unwrap();
        assert!(matches!(
            disk().delete_file(&abs(&d, "full")).await.unwrap_err(),
            Error::BadRequest(_)
        ));
    }
}
