// Apply a PATCH /.config field mutation (design.md config): add/remove a url
// (url, auth) pair, a recent (id, path) pair (MRU), a pin (id, path) pair, or a
// watch dir root, then persist the yaml and refresh the live boundary (recent +
// pin ids drive remote reach). Adding a recent/pin also indexes (id -> path) in
// the resolver so a freshly opened file is immediately resolvable; adding a
// watch root scans + live-watches it so its files index immediately
// (design.md L105).

use super::persist::write_yaml_atomically;
use super::{load_current, refresh_boundary, PatchBody};
use crate::config::{FileRef, UrlEntry};
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::util::is_valid_id;

pub(super) async fn apply_patch(app: &AppState, patch: PatchBody) -> Result<()> {
    let mut cfg = load_current(app)?;
    let mut boundary_changed = false;

    if let Some(UrlEntry { url, auth }) = patch.add_url {
        let u = url.trim().trim_end_matches('/').to_string();
        if u.is_empty() || !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err(Error::BadRequest("url must be http(s)://host[:port]".into()));
        }
        match cfg.url.iter_mut().find(|x| x.url == u) {
            Some(existing) => existing.auth = auth, // update the token
            None => cfg.url.push(UrlEntry { url: u, auth }),
        }
    }
    if let Some(url) = patch.remove_url.as_deref() {
        let trimmed = url.trim().trim_end_matches('/');
        let before = cfg.url.len();
        cfg.url.retain(|x| x.url != trimmed);
        if cfg.url.len() == before {
            return Err(Error::BadRequest(format!("url '{trimmed}' not found")));
        }
    }

    if let Some(entry) = patch.add_recent {
        let entry = validate_ref(entry)?;
        app.resolver.index_path(&entry.id, &entry.path);
        // MRU: move to front by id, cap at recent_limit.
        cfg.recent.retain(|x| x.id != entry.id);
        cfg.recent.insert(0, entry);
        let limit = cfg.recent_limit();
        cfg.recent.truncate(limit);
        boundary_changed = true;
    }
    if let Some(id) = patch.remove_recent.as_deref() {
        cfg.recent.retain(|x| x.id != id);
        boundary_changed = true;
    }

    if let Some(entry) = patch.add_pin {
        let entry = validate_ref(entry)?;
        app.resolver.index_path(&entry.id, &entry.path);
        if !cfg.pin.iter().any(|x| x.id == entry.id) {
            cfg.pin.push(entry);
        }
        boundary_changed = true;
    }
    if let Some(id) = patch.remove_pin.as_deref() {
        let before = cfg.pin.len();
        cfg.pin.retain(|x| x.id != id);
        if cfg.pin.len() == before {
            return Err(Error::BadRequest(format!("pin '{id}' not found")));
        }
        boundary_changed = true;
    }

    if let Some(dir) = patch.add_watch.as_deref() {
        let dir = normalize_dir(dir);
        let p = std::path::Path::new(&dir);
        if dir.is_empty() || !p.is_absolute() {
            return Err(Error::BadRequest("watch path must be an absolute directory".into()));
        }
        if !p.is_dir() {
            return Err(Error::BadRequest(format!("watch path '{dir}' is not a directory")));
        }
        if !cfg.watch.iter().any(|w| w == &dir) {
            cfg.watch.push(dir.clone());
        }
        // Index the new root's files now (and stamp ids), then live-watch it so
        // OS events keep it current without a restart.
        app.resolver.add_root(&dir);
        watch_live_add(app, &dir);
    }
    if let Some(dir) = patch.remove_watch.as_deref() {
        let dir = normalize_dir(dir);
        let before = cfg.watch.len();
        cfg.watch.retain(|w| w != &dir);
        if cfg.watch.len() == before {
            return Err(Error::BadRequest(format!("watch '{dir}' not found")));
        }
        app.resolver.remove_root(&dir);
        watch_live_remove(app, &dir);
    }

    write_yaml_atomically(app.config_path.as_deref(), &cfg)?;

    if boundary_changed {
        refresh_boundary(app, &cfg);
    }
    Ok(())
}

/// A recent/pin entry must carry a valid id and a non-empty path.
fn validate_ref(entry: FileRef) -> Result<FileRef> {
    let id = entry.id.trim().to_string();
    let path = entry.path.trim().to_string();
    if !is_valid_id(&id) {
        return Err(Error::BadRequest("recent/pin id must be 16 chars [a-z0-9]".into()));
    }
    if path.is_empty() {
        return Err(Error::BadRequest("recent/pin path cannot be empty".into()));
    }
    Ok(FileRef { id, path })
}

/// Trim surrounding whitespace and a single trailing slash so add/remove of the
/// same root match (keeping a bare "/").
fn normalize_dir(s: &str) -> String {
    let raw = s.trim();
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() { raw.to_string() } else { trimmed.to_string() }
}

/// Start live-watching `dir`, lazily creating the watcher when none exists yet
/// (config booted with no `watch` roots). A failure to create / watch is logged
/// (not fatal): the root is already persisted + scanned, so live OS-watching
/// simply resumes on the next launch.
fn watch_live_add(app: &AppState, dir: &str) {
    let mut guard = app.watcher.lock().unwrap();
    if guard.is_none() {
        *guard = crate::watch::make_watcher(app.resolver.clone());
    }
    if let Some(w) = guard.as_mut() {
        crate::watch::watch_root(w, std::path::Path::new(dir));
    }
}

/// Stop live-watching `dir` (no-op when no watcher exists).
fn watch_live_remove(app: &AppState, dir: &str) {
    if let Some(w) = app.watcher.lock().unwrap().as_mut() {
        crate::watch::unwatch_root(w, std::path::Path::new(dir));
    }
}
