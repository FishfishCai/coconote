// Live filesystem watcher (design.md L41): a `notify` watcher over the config
// `watch` roots keeps the id->path resolver current while the server runs, on
// top of the boot scan + lazy relocation. Each event is forwarded to
// `Resolver::handle_path_event` (create/modify -> (re)index, delete/move-away
// -> forget, moved-in dir -> rescan). With no `watch` roots the server stays
// purely lazy and no watcher is created; PATCH /.config addWatch lazily creates
// one via `make_watcher` and then `watch_root`.

use crate::resolver::Resolver;
use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Create a `notify` watcher wired to `resolver`, watching nothing yet. Add
/// roots with [`watch_root`]. None when notify cannot create a backend (the
/// server then relies on the boot scan + lazy relocation alone).
pub fn make_watcher(resolver: Arc<Resolver>) -> Option<notify::RecommendedWatcher> {
    // notify invokes this handler on its own thread for every batch of events.
    let handler = move |res: notify::Result<notify::Event>| match res {
        Ok(event) => {
            for path in event.paths {
                resolver.handle_path_event(&path);
            }
        }
        Err(e) => tracing::warn!("file watch error: {e}"),
    };
    match notify::recommended_watcher(handler) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!("file watcher unavailable: {e}; relying on lazy relocation");
            None
        }
    }
}

/// Start watching `root` recursively. Returns true on success.
pub fn watch_root(watcher: &mut notify::RecommendedWatcher, root: &Path) -> bool {
    match watcher.watch(root, RecursiveMode::Recursive) {
        Ok(()) => {
            tracing::info!("watching {}", root.display());
            true
        }
        Err(e) => {
            tracing::warn!("watch {}: {e}", root.display());
            false
        }
    }
}

/// Stop watching `root`. Logs (does not fail) when the root was not watched.
pub fn unwatch_root(watcher: &mut notify::RecommendedWatcher, root: &Path) {
    match watcher.unwatch(root) {
        Ok(()) => tracing::info!("stopped watching {}", root.display()),
        Err(e) => tracing::warn!("unwatch {}: {e}", root.display()),
    }
}

/// Start watching `roots` recursively, dispatching every event to `resolver`.
/// Returns the live watcher, which MUST be kept alive for events to keep
/// arriving (the caller holds it for the process lifetime). Returns None when
/// `roots` is empty (purely lazy) or no root could be watched; the server then
/// relies on the boot scan + lazy relocation alone.
pub fn spawn_watcher(
    resolver: Arc<Resolver>,
    roots: Vec<String>,
) -> Option<notify::RecommendedWatcher> {
    let roots: Vec<PathBuf> = roots
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if roots.is_empty() {
        return None;
    }
    let mut watcher = make_watcher(resolver)?;
    let mut any = false;
    for root in &roots {
        if watch_root(&mut watcher, root) {
            any = true;
        }
    }
    any.then_some(watcher)
}
