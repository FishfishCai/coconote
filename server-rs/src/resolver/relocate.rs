// Relocation: when a cached path is stale (a file renamed/moved while the
// server was idle), search the hint dir's subtree then each watch root's for
// an addressable file whose id matches. `resolve` (mod.rs) drives this.
use super::Resolver;
use crate::meta::{is_addressable, read_id};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

impl Resolver {
    /// Search for a file whose id equals `id`: the hint directory's subtree
    /// first, then each watch root's subtree. Returns the first match.
    pub(super) fn find_by_id(&self, id: &str, hint_dir: Option<&Path>) -> Option<String> {
        let mut seen: HashSet<PathBuf> = HashSet::new();
        if let Some(dir) = hint_dir {
            if let Some(hit) = self.search_dir(dir, id, &mut seen) {
                return Some(hit);
            }
        }
        let roots = self.roots.read().unwrap().clone();
        for root in &roots {
            if let Some(hit) = self.search_dir(root, id, &mut seen) {
                return Some(hit);
            }
        }
        None
    }

    /// Recursively look for an addressable file with id `id` under `dir`,
    /// deduping directories already visited (hint dir may sit under a root).
    fn search_dir(&self, dir: &Path, id: &str, seen: &mut HashSet<PathBuf>) -> Option<String> {
        let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !seen.insert(canon) {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        let mut subdirs: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                let hidden = entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with('.'));
                if !hidden {
                    subdirs.push(path);
                }
            } else if ft.is_file() {
                if let Some(p) = path.to_str() {
                    if is_addressable(p) && read_id(p).as_deref() == Some(id) {
                        return Some(p.to_string());
                    }
                }
            }
        }
        for sub in subdirs {
            if let Some(hit) = self.search_dir(&sub, id, seen) {
                return Some(hit);
            }
        }
        None
    }
}
