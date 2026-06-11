// Shared app state threaded into every handler via axum's State extractor.

use crate::history::HistoryDb;
use crate::space::EmbeddedReadOnlySpacePrimitives;
use crate::types::SpacePrimitives;
use arc_swap::ArcSwap;
use std::sync::Arc;
use tokio::sync::Notify;

pub type DynSpace = Arc<dyn SpacePrimitives>;

/// Snapshot of the `root:` map plus the live space they back. /.config
/// PATCH swaps the whole struct atomically so handlers always see a
/// coherent (roots, space) pair.
pub struct LiveSpace {
    pub roots: indexmap::IndexMap<String, String>,
    pub space: DynSpace,
}

#[derive(Clone)]
pub struct AppState {
    /// Atomically-swappable space + root snapshot. Hot-path reads are
    /// lock-free; /.config PATCH publishes a fresh snapshot via `store`.
    pub live: Arc<ArcSwap<LiveSpace>>,
    /// Static client bundle the SSR fallback serves under any
    /// unmatched GET.
    pub client_bundle: Arc<EmbeddedReadOnlySpacePrimitives>,
    /// Whether the current space rejects writes (CLI flag).
    pub read_only: bool,
    /// Bearer token (welcome.md `auth:`). Genuinely local requests
    /// (loopback peer + loopback Host) bypass it; everyone else needs
    /// `Authorization: Bearer <auth>` on the API routes.
    pub auth_token: String,
    /// Build timestamp baked at compile time (cargo `COCONOTE_BUILD_TIME`).
    pub build_time: String,
    /// RFC3339 timestamp captured at process start.
    pub started_at: String,
    pub pid: u32,
    /// Per-vault SQLite history. `None` when the DB couldn't open
    /// (read-only $XDG, disk full, ...) — handlers degrade to empty
    /// lists.
    pub history: Option<Arc<HistoryDb>>,
    /// Path of the coconote.yaml the server booted from (if any). The
    /// /.config PATCH handler atomically rewrites this file.
    pub config_path: Option<std::path::PathBuf>,
    /// Notified by `PATCH /.config` with `{configDir}`. main() awaits this
    /// alongside the OS shutdown signals; firing it drains axum and triggers
    /// a self-restart so the new pointer takes effect.
    pub restart_notify: Arc<Notify>,
}

impl AppState {
    pub fn space(&self) -> DynSpace {
        self.live.load().space.clone()
    }

    pub fn roots_snapshot(&self) -> indexmap::IndexMap<String, String> {
        self.live.load().roots.clone()
    }
}
