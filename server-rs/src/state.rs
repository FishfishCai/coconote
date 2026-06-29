// Shared app state threaded into every handler via axum's State extractor.
//
// Files are addressed by id; the `resolver` turns an id into the file's
// current absolute path (config seeds + watch-root scan + relocation). The
// boundary (recent + pin ids for the remote refs closure) is the one piece of
// config the request path needs live, so it sits behind an ArcSwap that PATCH
// /.config refreshes.

use crate::resolver::Resolver;
use crate::space::{ClientBundle, Disk};
use arc_swap::ArcSwap;
use std::sync::{Arc, Mutex};

/// Live boundary inputs: the remote-reachability entry set, as file IDS.
/// Swapped atomically by PATCH /.config so a freshly pinned/opened file is
/// reachable without a restart.
#[derive(Default)]
pub struct Boundary {
    /// recent file ids.
    pub recent: Vec<String>,
    /// pin file ids.
    pub pin: Vec<String>,
}

#[derive(Clone)]
pub struct AppState {
    /// Static client bundle the SSR fallback serves on unmatched GETs.
    pub client_bundle: ClientBundle,
    /// Live boundary entry set (recent + pin ids) for the remote refs closure.
    pub boundary: Arc<ArcSwap<Boundary>>,
    /// id -> current path resolver (watch scan + relocation).
    pub resolver: Arc<Resolver>,
    /// Bearer token. Genuinely local requests (loopback peer + loopback
    /// Host) bypass it, everyone else needs `Authorization: Bearer <auth>`.
    pub auth_token: String,
    /// Build timestamp baked at compile time.
    pub build_time: String,
    /// RFC3339 timestamp captured at process start.
    pub started_at: String,
    pub pid: u32,
    /// coconote.yaml the server booted from (if any). PATCH /.config
    /// rewrites it.
    pub config_path: Option<std::path::PathBuf>,
    /// Live filesystem watcher over the config `watch` roots (None when no
    /// roots are set). Behind a Mutex so PATCH /.config can add/remove roots on
    /// it (lazily creating one when the first root is added). The running
    /// router holds AppState for the process lifetime, keeping it alive.
    pub watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
}

impl AppState {
    /// File accessor for handlers. Stateless, since paths are absolute and
    /// per-file read-only is read from each file's on-disk permission bit.
    pub fn space(&self) -> Disk {
        Disk::new()
    }

    /// Snapshot of the live (recent, pin) id entry set.
    pub fn boundary(&self) -> Arc<Boundary> {
        self.boundary.load_full()
    }
}
