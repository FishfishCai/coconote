// Stat-validated file scanning + the vault id conventions shared by
// the listing walk and the write path (space/disk.rs): per-path scan
// cache, md head scans, PDF sidecar parsing, and the id collision walk
// behind file.md's regenerate-id-on-collision rule.

use crate::body_scan::{scan_headings, scan_wikilinks, BODY_SCAN_LIMIT};
use crate::frontmatter::{
    new_id, read_head, scan_frontmatter, ScanResult, FRONTMATTER_READ_LIMIT,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

#[derive(Clone, Default)]
pub(crate) struct FileScan {
    pub(crate) scan: ScanResult,
    pub(crate) headings: Vec<String>,
    pub(crate) wikilinks: Vec<String>,
    pub(crate) sidecar_id: Option<String>,
}

pub(crate) struct ScanCacheEntry {
    mtime: SystemTime,
    size: u64,
    scan: FileScan,
}

/// Per-path scan cache shared by the listing walk and the id collision
/// walk (Arc because both run inside spawn_blocking closures). Entries
/// are a pure function of the file bytes, validated by (mtime, size):
/// a new or changed file always misses and is re-read, so file.md's
/// regenerate-id-on-collision guarantee still sees every file.
pub(crate) type ScanCache = Arc<Mutex<HashMap<PathBuf, ScanCacheEntry>>>;

/// Stat-validated lookup: reuse the cached derivation while `meta` matches
/// the stored (mtime, size), else run `scan` and replace the entry. `meta`
/// must describe the bytes the scan reads (symlink callers pass the
/// target's metadata). `None` (stat failed or no mtime) scans fresh
/// without caching.
pub(crate) fn cached_scan(
    cache: &ScanCache,
    path: &Path,
    meta: Option<&std::fs::Metadata>,
    scan: impl FnOnce() -> FileScan,
) -> FileScan {
    let Some(key) = meta.and_then(|m| m.modified().ok().map(|t| (t, m.len()))) else {
        return scan();
    };
    if let Some(e) = cache.lock().unwrap().get(path) {
        if (e.mtime, e.size) == key {
            return e.scan.clone();
        }
    }
    let fresh = scan();
    cache.lock().unwrap().insert(
        path.to_path_buf(),
        ScanCacheEntry {
            mtime: key.0,
            size: key.1,
            scan: fresh.clone(),
        },
    );
    fresh
}

/// One head read per md file feeds all three scanners
/// (scan_frontmatter caps itself at 16 KiB inside).
pub(crate) fn md_scan(path: &Path) -> FileScan {
    let head = read_head(path, BODY_SCAN_LIMIT);
    FileScan {
        scan: scan_frontmatter(&head),
        headings: scan_headings(&head),
        wikilinks: scan_wikilinks(&head),
        sidecar_id: None,
    }
}


/// True when another file in this root already claims `id`. Checks md
/// frontmatter ids and pdf sidecar `metadata.id` (one shared vault id
/// namespace, file.md: "same generation rule as markdown") through the
/// stat-validated cache, so unchanged files cost one stat instead of a
/// read + parse. Per-root only: ids are minted while writing into one
/// root, a cross-root pass isn't worth its cost here.
pub(crate) fn id_in_use_elsewhere(cache: &ScanCache, root: &Path, self_rel: &str, id: &str) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            // Follows symlinks, like the reads below: the cache key
            // (mtime, size) must describe the bytes the scans see.
            let Ok(meta) = std::fs::metadata(&p) else {
                continue;
            };
            if meta.is_dir() {
                // Dot dirs (.git, .obsidian, `.<name>.assets/`) can't
                // host vault pages.
                if !name.starts_with('.') {
                    stack.push(p);
                }
                continue;
            }
            if name.starts_with('.') {
                // PDF sidecar `.<stem>.json`: skip the file being
                // written itself, or every sidecar save would "collide"
                // with its own on-disk copy.
                if name.len() > ".json".len() + 1 && name.ends_with(".json") {
                    let rel = p
                        .strip_prefix(root)
                        .ok()
                        .and_then(|r| r.to_str())
                        .map(|s| s.replace('\\', "/"))
                        .unwrap_or_default();
                    if rel != self_rel {
                        let cached = cached_scan(cache, &p, Some(&meta), || FileScan {
                            sidecar_id: sidecar_id(&p),
                            ..FileScan::default()
                        });
                        if cached.sidecar_id.as_deref() == Some(id) {
                            return true;
                        }
                    }
                }
                continue;
            }
            if p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                // Force forward slashes: the listing protocol uses
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
                if cached_scan(cache, &p, Some(&meta), || md_scan(&p)).scan.id == id {
                    return true;
                }
            }
        }
    }
    false
}

/// Dot-prefixed `.<stem>.json` basename: the PDF sidecar convention
/// (file.md). Matches the manifest main-file derivation in history.rs.
pub(crate) fn is_sidecar_json(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap();
    name.starts_with('.')
        && name.len() > ".json".len() + 1
        && name.to_ascii_lowercase().ends_with(".json")
}

/// Apply the md id rule to a sidecar body: inject `metadata.id` when
/// missing/empty, regenerate on collision with another file's id. None
/// when the body is fine as-is (or isn't conforming JSON: the bytes are
/// then persisted untouched).
pub(crate) fn normalize_sidecar_id(
    cache: &ScanCache,
    root: &Path,
    self_rel: &str,
    data: &[u8],
) -> Option<Vec<u8>> {
    let mut v: serde_json::Value = serde_json::from_slice(data).ok()?;
    let meta = v.get_mut("metadata")?.as_object_mut()?;
    let cur = meta
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if !cur.is_empty() && !id_in_use_elsewhere(cache, root, self_rel, &cur) {
        return None;
    }
    meta.insert("id".into(), serde_json::Value::String(new_id()));
    serde_json::to_vec_pretty(&v).ok()
}

/// `metadata.id` from a pdf sidecar. Head-read first, only a sidecar
/// larger than the head limit (truncated JSON) falls back to a full read.
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

/// On-disk path of the PDF sidecar paired with `rel` (file.md):
/// `<name>` is the basename WITHOUT the `.pdf` extension, so
/// `papers/foo.pdf` pairs with `papers/.foo.json`.
pub(crate) fn pdf_sidecar_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let stem = Path::new(rel).file_stem()?.to_string_lossy().into_owned();
    let mut sidecar = root.join(rel);
    sidecar.set_file_name(format!(".{stem}.json"));
    Some(sidecar)
}

/// Read a PDF sidecar into a ScanResult-shaped struct, kept compatible
/// with the md scan path.
pub(crate) fn sidecar_scan_pdf(sidecar: &Path) -> Option<PdfSidecarScan> {
    let body = std::fs::read(sidecar).ok()?;
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

pub(crate) struct PdfSidecarScan {
    pub(crate) accepted: bool,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) tag: Vec<String>,
}

