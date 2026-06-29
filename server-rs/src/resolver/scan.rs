// Directory scanning: the boot-time recursive walk of the watch roots, the
// runtime add/remove of roots, and the live filesystem-event handler. Each
// stamps ids onto id-less addressable files and feeds the index in `mod.rs`.
use super::Resolver;
use crate::meta::{self, is_addressable};
use std::path::{Path, PathBuf};

impl Resolver {
    /// Boot-time population: recursively scan the watch roots (stamping ids
    /// onto id-less files), then overlay the config (id, path) seed hints so
    /// files outside any watch root stay resolvable by their last-known path.
    pub fn boot_scan(&self, seeds: &[(String, String)]) {
        let roots = self.roots.read().unwrap().clone();
        for root in &roots {
            self.scan_dir(root);
        }
        for (id, path) in seeds {
            if !Path::new(path).exists() || !is_addressable(path) {
                continue;
            }
            // Bind the seed id when the file has none yet, else trust the
            // file's own id.
            let effective = meta::ensure_id(path, Some(id)).unwrap_or_else(|_| id.clone());
            self.index_path(&effective, path);
        }
    }

    /// Add a watch root at runtime (PATCH /.config addWatch): record it for
    /// relocation searches and immediately scan it so its files are indexed
    /// (id-less ones stamped) without waiting for a live event. Idempotent:
    /// re-adding an existing root just rescans it.
    pub fn add_root(&self, dir: &str) {
        let pb = PathBuf::from(dir);
        {
            let mut roots = self.roots.write().unwrap();
            if !roots.iter().any(|r| r == &pb) {
                roots.push(pb.clone());
            }
        }
        self.scan_dir(&pb);
    }

    /// Drop a watch root at runtime (PATCH /.config removeWatch): relocation no
    /// longer searches it. Already-indexed files keep their last-known path
    /// (lazy resolve still relocates within the hint dir / remaining roots).
    pub fn remove_root(&self, dir: &str) {
        let pb = PathBuf::from(dir);
        self.roots.write().unwrap().retain(|r| r != &pb);
    }

    /// Recursively index every addressable file under `dir`, skipping hidden
    /// directories (`.assets`, `.history`, `.git`, ...) and not following
    /// symlinked directories (loop guard).
    fn scan_dir(&self, dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                let name = entry.file_name();
                let hidden = name.to_str().is_some_and(|n| n.starts_with('.'));
                if !hidden {
                    self.scan_dir(&path);
                }
            } else if ft.is_file() {
                let Some(p) = path.to_str() else { continue };
                if is_addressable(p) {
                    if let Ok(id) = meta::ensure_id(p, None) {
                        self.index_path(&id, p);
                    }
                }
            }
        }
    }

    /// React to a live filesystem event under a `watch` root (design.md L41).
    /// An addressable file that exists is (re)indexed (stamping an id when it
    /// has none, like the boot scan); a path that no longer exists is
    /// forgotten; a directory that appeared / moved in is rescanned. Idempotent
    /// and safe to call for any path the watcher reports.
    pub fn handle_path_event(&self, path: &Path) {
        match std::fs::metadata(path) {
            Ok(m) if m.is_dir() => {
                // A moved-in / new directory: index its addressable files.
                // Skip hidden dirs (`.assets`, `.history`, ...) like the scan.
                let hidden = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'));
                if !hidden {
                    self.scan_dir(path);
                }
            }
            Ok(_) => {
                if let Some(p) = path.to_str() {
                    if is_addressable(p) {
                        if let Ok(id) = meta::ensure_id(p, None) {
                            self.index_path(&id, p);
                        }
                    }
                }
            }
            Err(_) => {
                // Gone (delete or rename-away): drop the stale mapping.
                if let Some(p) = path.to_str() {
                    self.forget_path(p);
                }
            }
        }
    }
}
