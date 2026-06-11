// Server-startup orphan scan (file.md "Orphan files"):
//
// > At server startup, root folders are scanned for orphan
// > `.<name>.json` and `.<name>.assets/` entries; orphans are auto-deleted.
//
// `<name>` is the basename WITHOUT extension. A sidecar `.foo.json`
// is paired with `foo.pdf`; an assets dir `.foo.assets/` is paired
// with `foo.md`. Either is orphan when the matching parent file
// doesn't exist. Idempotent; safe to run every boot.

use std::fs;
use std::path::{Path, PathBuf};

/// Walk one root, removing every orphan sidecar / assets dir. Returns
/// `(json_removed, assets_removed)`.
pub fn sweep_root(root: &Path) -> (u64, u64) {
    let mut json_removed = 0u64;
    let mut assets_removed = 0u64;
    if !root.is_dir() {
        return (0, 0);
    }
    walk(root, &mut json_removed, &mut assets_removed);
    (json_removed, assets_removed)
}

fn walk(dir: &Path, json_removed: &mut u64, assets_removed: &mut u64) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("orphan sweep read_dir {}: {e}", dir.display());
            return;
        }
    };
    // Two passes: collect first so companion lookups can match the
    // extension case-insensitively (listings accept `Foo.MD`; a plain
    // exists() probe on `foo.md` would mis-judge its assets dir as
    // orphan on a case-sensitive FS).
    let mut dirs: Vec<(PathBuf, String)> = Vec::new();
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            dirs.push((path, name));
        } else if ft.is_file() {
            files.push((path, name));
        }
    }
    // Companion = exact-case stem + case-insensitive extension.
    let has_companion = |stem: &str, ext: &str| {
        files.iter().any(|(_, n)| {
            n.strip_prefix(stem)
                .is_some_and(|rest| rest.eq_ignore_ascii_case(ext))
        })
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for (path, name) in &dirs {
        if let Some(stem) = strip_dot_suffix(name, ".assets") {
            // `.foo.assets/` → pair file is `foo.md`. Anything else
            // is treated as orphan.
            if !has_companion(&stem, ".md") {
                tracing::info!("orphan assets removed: {}", path.display());
                if fs::remove_dir_all(path).is_ok() {
                    *assets_removed += 1;
                }
                continue;
            }
        }
        // Recurse — but never into a `.dot.assets/` we just kept;
        // it's a leaf directory of images and has no sub-files we own.
        if !name.starts_with('.') {
            subdirs.push(path.clone());
        }
    }
    for (path, name) in &files {
        if let Some(stem) = strip_dot_suffix(name, ".json") {
            // `.foo.json` → pair file is `foo.pdf`.
            if !has_companion(&stem, ".pdf") {
                tracing::info!("orphan sidecar removed: {}", path.display());
                if fs::remove_file(path).is_ok() {
                    *json_removed += 1;
                }
            }
        }
    }
    for sub in subdirs {
        walk(&sub, json_removed, assets_removed);
    }
}

/// `.foo<suffix>` → `Some("foo")`; None for other shapes. `<name>` carries
/// no extension — the pair file appends its own (`.md` for `.assets`,
/// `.pdf` for `.json`).
fn strip_dot_suffix(name: &str, suffix: &str) -> Option<String> {
    let inner = name.strip_prefix('.')?;
    let stem = inner.strip_suffix(suffix)?;
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn removes_orphan_sidecar() {
        let d = TempDir::new().unwrap();
        std::fs::write(d.path().join(".ghost.json"), b"{}").unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (1, 0));
        assert!(!d.path().join(".ghost.json").exists());
    }

    #[test]
    fn keeps_sidecar_when_parent_exists() {
        let d = TempDir::new().unwrap();
        std::fs::write(d.path().join("paper.pdf"), b"%PDF").unwrap();
        std::fs::write(d.path().join(".paper.json"), b"{}").unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (0, 0));
        assert!(d.path().join(".paper.json").exists());
    }

    #[test]
    fn removes_orphan_assets_dir() {
        let d = TempDir::new().unwrap();
        let assets = d.path().join(".ghost.assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("img.png"), b"x").unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (0, 1));
        assert!(!assets.exists());
    }

    #[test]
    fn keeps_assets_dir_when_parent_exists() {
        let d = TempDir::new().unwrap();
        std::fs::write(d.path().join("note.md"), b"x").unwrap();
        std::fs::create_dir_all(d.path().join(".note.assets")).unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (0, 0));
        assert!(d.path().join(".note.assets").exists());
    }

    #[test]
    fn recurses_into_subdirs() {
        let d = TempDir::new().unwrap();
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(d.path().join("sub/.ghost.json"), b"{}").unwrap();
        let (j, _) = sweep_root(d.path());
        assert_eq!(j, 1);
    }

    #[test]
    fn keeps_pairs_with_uppercase_extension() {
        let d = TempDir::new().unwrap();
        std::fs::write(d.path().join("Note.MD"), b"x").unwrap();
        std::fs::create_dir_all(d.path().join(".Note.assets")).unwrap();
        std::fs::write(d.path().join("Paper.PDF"), b"%PDF").unwrap();
        std::fs::write(d.path().join(".Paper.json"), b"{}").unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (0, 0));
        assert!(d.path().join(".Note.assets").exists());
        assert!(d.path().join(".Paper.json").exists());
    }

    #[test]
    fn ignores_unrelated_dot_files() {
        let d = TempDir::new().unwrap();
        std::fs::write(d.path().join(".DS_Store"), b"x").unwrap();
        let (j, a) = sweep_root(d.path());
        assert_eq!((j, a), (0, 0));
        assert!(d.path().join(".DS_Store").exists());
    }
}
