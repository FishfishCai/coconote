// id -> path resolver (design.md "file tracking"). Endpoints address files by
// id; this module turns an id into the file's current absolute path. It draws
// on three sources:
//
//   (a) config recent / pin (id, path) pairs   -> seed hints,
//   (b) the `watch` dir roots                  -> a boot-time recursive scan,
//   (c) path-hint + relocation                 -> when a recorded path is
//       stale, search from the original directory within the watch roots for a
//       file whose frontmatter (or pdf sidecar) id equals the target, then
//       update the stored path.
//
// Live filesystem watching (the `notify` crate, see `watch.rs`) keeps the
// index current while the server runs: create/modify -> (re)index, delete/
// move-away -> forget, on top of the boot scan plus lazy on-access relocation.
// With no `watch` roots the server stays purely lazy. A file that was deleted
// and cannot be relocated resolves to None, and the caller drops it from
// recent / pin. This file owns the index + id/title lookup; the recursive
// scan is in `scan.rs` and the stale-path relocation search in `relocate.rs`.

mod relocate;
mod scan;
#[cfg(test)]
mod tests;

use crate::meta::{read_id, read_meta};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// One indexed file: its last-known path and cached display metadata (for
/// title resolution). Cached title/tags can lag a live edit; the closure and
/// id resolution always re-read the file, so staleness only affects
/// /.resolve ranking, never access decisions.
#[derive(Clone)]
struct IndexEntry {
    path: PathBuf,
    title: String,
    tags: Vec<String>,
}

/// A /.resolve candidate (one file matching a queried title).
#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
}

/// Result of resolving a title (or `tag/title`) to ids.
pub enum TitleResolution {
    /// Exactly one match.
    Single(String),
    /// Zero (missing) or many (ambiguous) matches.
    Candidates(Vec<Candidate>),
}

pub struct Resolver {
    /// Watch roots: the recursive scan + relocation search are bounded here.
    /// Editable at runtime (PATCH /.config add/remove watch), so behind a lock.
    roots: RwLock<Vec<PathBuf>>,
    /// id -> last-known location + display metadata.
    index: RwLock<HashMap<String, IndexEntry>>,
}

impl Resolver {
    pub fn new(roots: Vec<String>) -> Self {
        Self {
            roots: RwLock::new(roots.into_iter().map(PathBuf::from).collect()),
            index: RwLock::new(HashMap::new()),
        }
    }

    /// Record (or refresh) an id -> path mapping, caching the file's display
    /// metadata for title resolution.
    pub fn index_path(&self, id: &str, path: &str) {
        let (title, tags) = read_meta(path)
            .map(|m| (m.title, m.tags))
            .unwrap_or_default();
        self.index.write().unwrap().insert(
            id.to_string(),
            IndexEntry {
                path: PathBuf::from(path),
                title,
                tags,
            },
        );
    }

    /// Drop an id from the index (after a delete).
    pub fn forget(&self, id: &str) {
        self.index.write().unwrap().remove(id);
    }

    /// Drop any index entries whose cached path equals `path` (a file deleted
    /// or moved away). The id can be re-indexed if the file reappears, and
    /// `resolve` would relocate it anyway, but forgetting promptly keeps
    /// `resolve_title` from offering a vanished file.
    fn forget_path(&self, path: &str) {
        self.index
            .write()
            .unwrap()
            .retain(|_, e| e.path.to_str() != Some(path));
    }

    /// Resolve an id to its current absolute path. Verifies the cached path
    /// still carries the id, else relocates from the original directory and
    /// the watch roots, updating the index. None when the file is gone and
    /// unrelocatable.
    pub fn resolve(&self, id: &str) -> Option<String> {
        let hint = self.index.read().unwrap().get(id).map(|e| e.path.clone());
        if let Some(ref path) = hint {
            if let Some(p) = path.to_str() {
                if read_id(p).as_deref() == Some(id) {
                    return Some(p.to_string());
                }
            }
        }
        // Stale or unknown: relocate. Search the original directory first
        // (locality: a rename usually stays in place), then the watch roots.
        let hint_dir = hint.as_deref().and_then(Path::parent).map(Path::to_path_buf);
        let found = self.find_by_id(id, hint_dir.as_deref());
        if let Some(ref p) = found {
            self.index_path(id, p);
        }
        found
    }

    /// Outgoing link ids of `id` (markdown refs; a pdf has none), read fresh
    /// from disk so the boundary closure never trusts a stale cache.
    pub fn refs_of(&self, id: &str) -> Vec<String> {
        match self.resolve(id) {
            Some(path) => read_meta(&path).map(|m| m.refs).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    /// Resolve a title (or `tag/title`) to id(s). When `allowed` is Some, only
    /// ids in that set are considered (remote callers are limited to their
    /// refs-closure). The index is the known universe (watch scan + seeds);
    /// titles/tags are matched case-sensitively against the cached metadata.
    pub fn resolve_title(&self, query: &str, allowed: Option<&HashSet<String>>) -> TitleResolution {
        let (tag, title) = match query.split_once('/') {
            Some((t, rest)) => (Some(t), rest),
            None => (None, query),
        };
        let index = self.index.read().unwrap();
        let mut hits: Vec<Candidate> = Vec::new();
        for (id, entry) in index.iter() {
            if let Some(set) = allowed {
                if !set.contains(id) {
                    continue;
                }
            }
            if entry.title != title {
                continue;
            }
            if let Some(tag) = tag {
                if !entry.tags.iter().any(|t| t == tag) {
                    continue;
                }
            }
            hits.push(Candidate {
                id: id.clone(),
                title: entry.title.clone(),
                tags: entry.tags.clone(),
            });
        }
        if hits.len() == 1 {
            TitleResolution::Single(hits.pop().unwrap().id)
        } else {
            // Stable order so an ambiguous list is deterministic.
            hits.sort_by(|a, b| a.id.cmp(&b.id));
            TitleResolution::Candidates(hits)
        }
    }

    /// Every currently indexed id (for diagnostics / closure seeding fallback).
    #[cfg(test)]
    pub fn known_ids(&self) -> Vec<String> {
        self.index.read().unwrap().keys().cloned().collect()
    }

    /// Number of watch roots currently tracked.
    #[cfg(test)]
    pub fn root_count(&self) -> usize {
        self.roots.read().unwrap().len()
    }
}
