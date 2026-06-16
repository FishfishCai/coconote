// Boot sequence for the coconote binary (welcome.md / server.md / file.md
// boot order): resolve coconote.yaml -> open the space -> sweep orphans ->
// open per-vault history -> assemble AppState. Lives in the lib (not the
// bin) so the binary stays a thin process-lifecycle shell and the assembly
// is reachable from tests.

mod history;
mod space;

use crate::config::{ensure_default_config, FileConfig, DEFAULT_PORT};
use crate::space::EmbeddedReadOnlySpacePrimitives;
use crate::state::{AppState, LiveSpace};
use arc_swap::ArcSwap;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;
use tokio::sync::Notify;
use tracing::info;

/// What the binary passes from its CLI args (host is only needed later for
/// the listener, so it is not part of boot).
pub struct BootOptions {
    pub folder: Option<PathBuf>,
    pub port_override: Option<u16>,
    pub read_only: bool,
}

/// The assembled server: state ready for build_router, plus the resolved
/// listen port (CLI override, else yaml, else default).
pub struct Booted {
    pub state: AppState,
    pub port: u16,
}

/// Resolve config, open the space, sweep orphans, open history, and build
/// AppState. Errors abort boot; a history open failure only disables history.
pub async fn boot(opts: BootOptions) -> Result<Booted, String> {
    let (cfg, config_path) = load_config(opts.folder.as_deref())?;
    let port = opts.port_override.or(cfg.port).unwrap_or(DEFAULT_PORT);
    let auth_token = cfg.auth_token();
    let roots = cfg.root_configs().map_err(|e| format!("root config: {e}"))?;
    let roots_pretty: indexmap::IndexMap<String, String> = roots
        .iter()
        .map(|r| (r.name.clone(), r.path.to_string_lossy().into_owned()))
        .collect();

    let space = space::build_space(&roots, opts.folder.as_deref(), opts.read_only)?;
    space::sweep_orphans(&roots, opts.folder.as_deref());

    let build_time = option_env!("COCONOTE_BUILD_TIME")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    let started_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let timestamp_ms = crate::util::now_ms();

    let history = history::open_history(config_path.as_deref(), &roots_pretty, &space).await;

    let state = AppState {
        live: Arc::new(ArcSwap::from_pointee(LiveSpace {
            roots: roots_pretty,
            space,
        })),
        client_bundle: Arc::new(EmbeddedReadOnlySpacePrimitives::new(timestamp_ms)),
        read_only: opts.read_only,
        auth_token,
        build_time,
        started_at,
        pid: process::id(),
        history,
        config_path: config_path.as_deref().map(PathBuf::from),
        restart_notify: Arc::new(Notify::new()),
    };
    Ok(Booted { state, port })
}

/// welcome.md coconote.yaml: ensure a usable yaml in the effective config
/// dir (unless --folder bypasses it) and load it. Returns the parsed config
/// and the yaml path string (None in --folder mode).
fn load_config(folder: Option<&Path>) -> Result<(FileConfig, Option<String>), String> {
    if folder.is_some() {
        return Ok((FileConfig::default(), None));
    }
    let cfg_path = ensure_default_config().map_err(|e| format!("ensure default config: {e}"))?;
    info!("Loading config from {}", cfg_path.display());
    let cfg = FileConfig::load(&cfg_path)
        .map_err(|e| format!("load config: {e}"))?
        .unwrap_or_default();
    Ok((cfg, Some(cfg_path.to_string_lossy().to_string())))
}
