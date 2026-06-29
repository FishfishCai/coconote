// Boot sequence for the coconote binary (design.md): resolve coconote.yaml,
// build the id->path resolver (scan watch roots + seed from recent/pin),
// reconcile recent/pin against disk (relocate / drop / backfill ids), then
// assemble AppState. The file-centric model has no vault to open and no
// central history DB (history lives in each file's companion folder). Lives in
// the lib (not the bin) so the binary stays a thin process-lifecycle shell and
// the assembly is reachable from tests.

use crate::config::{ensure_default_config, reconcile_entries, FileConfig, FileRef, DEFAULT_PORT};
use crate::meta;
use crate::resolver::Resolver;
use crate::space::ClientBundle;
use crate::state::{AppState, Boundary};
use arc_swap::ArcSwap;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use tracing::info;

/// What the binary passes from its CLI args. `open` is an optional file path
/// to open on launch (recorded as the freshest recent entry, design.md:
/// launching with a file path opens it).
pub struct BootOptions {
    pub open: Option<PathBuf>,
    pub port_override: Option<u16>,
}

/// The assembled server: state ready for build_router, plus the resolved
/// listen port (CLI override, else yaml, else default). The live filesystem
/// watcher over the config `watch` roots lives inside `state` (held for the
/// process lifetime by the running router) so PATCH /.config can add / remove
/// roots on it.
pub struct Booted {
    pub state: AppState,
    pub port: u16,
}

/// Resolve config and build AppState. Errors abort boot.
pub async fn boot(opts: BootOptions) -> Result<Booted, String> {
    let (mut cfg, config_path) = load_config()?;
    let port = opts.port_override.or(cfg.port).unwrap_or(DEFAULT_PORT);
    let auth_token = cfg.auth_token();

    // Build the resolver: recursively scan the watch roots (stamping ids onto
    // id-less files) and seed from the config (id, path) pairs.
    let resolver = Arc::new(Resolver::new(cfg.watch.clone()));
    resolver.boot_scan(&cfg.seeds());

    // Live-watch the config `watch` roots so files created / moved / deleted
    // while the server runs stay resolvable (design.md L41). Empty roots -> no
    // watcher (purely lazy); PATCH /.config addWatch lazily creates one.
    let watcher = crate::watch::spawn_watcher(resolver.clone(), cfg.watch.clone());

    // A command-line file becomes the freshest recent entry so it is reachable
    // and shows at the top of the recent list. Mint/read its id first.
    if let Some(open) = &opts.open {
        let p = open.to_string_lossy().into_owned();
        if let Ok(id) = meta::ensure_id(&p, None) {
            resolver.index_path(&id, &p);
            cfg.recent.retain(|x| x.id != id);
            cfg.recent.insert(0, FileRef { id, path: p });
        } else {
            tracing::warn!("opened file {p} is not a markdown/pdf or does not exist; not recorded");
        }
    }

    // Reconcile recent/pin against disk: relocate moved files, backfill ids on
    // legacy path-only entries, drop deleted-and-unrelocatable ones.
    let mut changed = reconcile_entries(&resolver, &mut cfg.recent);
    changed |= reconcile_entries(&resolver, &mut cfg.pin);
    let limit = cfg.recent_limit();
    if cfg.recent.len() > limit {
        cfg.recent.truncate(limit);
        changed = true;
    }
    if changed {
        if let Some(p) = &config_path {
            if let Err(e) = cfg.save(std::path::Path::new(p)) {
                tracing::warn!("persist reconciled config: {e}");
            }
        }
    }

    let build_time = option_env!("COCONOTE_BUILD_TIME")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    let started_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let state = AppState {
        client_bundle: ClientBundle::new(),
        boundary: Arc::new(ArcSwap::from_pointee(Boundary {
            recent: cfg.recent_ids(),
            pin: cfg.pin_ids(),
        })),
        resolver,
        auth_token,
        build_time,
        started_at,
        pid: process::id(),
        config_path: config_path.as_deref().map(PathBuf::from),
        watcher: Arc::new(std::sync::Mutex::new(watcher)),
    };
    Ok(Booted { state, port })
}

/// Ensure a usable yaml in the effective config dir and load it. Returns the
/// parsed config and the yaml path string.
fn load_config() -> Result<(FileConfig, Option<String>), String> {
    let cfg_path = ensure_default_config().map_err(|e| format!("ensure default config: {e}"))?;
    info!("Loading config from {}", cfg_path.display());
    let cfg = FileConfig::load(&cfg_path)
        .map_err(|e| format!("load config: {e}"))?
        .unwrap_or_default();
    Ok((cfg, Some(cfg_path.to_string_lossy().to_string())))
}
