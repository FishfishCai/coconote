// `coconote` binary entry point. Boot order (welcome.md, server.md,
// file.md): resolve coconote.yaml -> open local roots (MultiRoot) -> sweep
// each root for orphan `.<name>.json` / `.<name>.assets/` -> open per-vault
// SQLite history (or warn) -> listen, drain on SIGINT/SIGTERM.

use clap::Parser;
use coconote::config::{ensure_default_config, FileConfig, DEFAULT_PORT};
use coconote::router::build_router;
use coconote::space::{
    DiskSpacePrimitives, EmbeddedReadOnlySpacePrimitives, MultiRootSpacePrimitives,
    ReadOnlySpacePrimitives,
};
use coconote::state::{AppState, DynSpace, LiveSpace};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process;
use arc_swap::ArcSwap;
use std::sync::Arc;
use tokio::signal;
use tokio::sync::Notify;
use tracing::info;

#[derive(Parser, Debug)]
#[command(about = "Coconote - self-hosted markdown notebook server")]
struct Args {
    /// Host or address to listen on.
    #[arg(short = 'L', long = "listen", default_value = "127.0.0.1")]
    host: String,

    /// Listen port (overrides coconote.yaml, default 40704). 0 = ephemeral.
    #[arg(short = 'p', long = "port")]
    port: Option<u16>,

    /// Read-only vault (writes return 405).
    #[arg(long = "read-only")]
    read_only: bool,

    /// Single vault folder (overrides coconote.yaml `root:`).
    folder: Option<PathBuf>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    if let Err(e) = run(args).await {
        eprintln!("coconote: {e}");
        process::exit(1);
    }
}

async fn run(args: Args) -> Result<(), String> {
    let mut cfg_loaded: Option<FileConfig> = None;
    let mut config_path: Option<String> = None;
    // welcome.md coconote.yaml: the yaml lives in the effective config dir
    // (standard dir, optionally redirected by the `config-path` pointer).
    // Every boot ensures a usable yaml there: ensure_default_config writes
    // a default when missing or unparseable. --folder bypasses this and
    // uses the CLI-supplied root only.
    let cfg_path = if args.folder.is_some() {
        None
    } else {
        Some(
            ensure_default_config()
                .map_err(|e| format!("ensure default config: {e}"))?,
        )
    };
    if let Some(cfg_path) = cfg_path {
        info!("Loading config from {}", cfg_path.display());
        let cfg = FileConfig::load(&cfg_path)
            .map_err(|e| format!("load config: {e}"))?
            .unwrap_or_default();
        config_path = Some(cfg_path.to_string_lossy().to_string());
        cfg_loaded = Some(cfg);
    }
    let cfg = cfg_loaded.unwrap_or_default();
    let port = args.port.or(cfg.port).unwrap_or(DEFAULT_PORT);
    let auth_token = cfg.auth_token();
    let roots = cfg.root_configs().map_err(|e| format!("root config: {e}"))?;
    let roots_pretty: indexmap::IndexMap<String, String> = roots
        .iter()
        .map(|r| (r.name.clone(), r.path.to_string_lossy().into_owned()))
        .collect();

    // Empty roots is OK: boot with an empty space, the user adds roots
    // via Setting -> Local at runtime. `--folder` still wins when passed
    // (single-vault CLI use).
    let base: DynSpace = if let Some(folder) = args.folder.as_ref() {
        Arc::new(DiskSpacePrimitives::new(folder).map_err(|e| format!("vault: {e}"))?)
    } else {
        Arc::new(
            MultiRootSpacePrimitives::new(roots.clone())
                .map_err(|e| format!("multiroot: {e}"))?,
        )
    };
    let space: DynSpace = if args.read_only {
        Arc::new(ReadOnlySpacePrimitives::new(base))
    } else {
        base
    };

    // Orphan sweep on every configured root (file.md). Empty roots =
    // nothing to sweep.
    {
        let scan_roots: Vec<PathBuf> = if let Some(folder) = args.folder.as_ref() {
            vec![folder.clone()]
        } else {
            roots.iter().map(|r| r.path.clone()).collect()
        };
        for r in scan_roots {
            let (j, a) = coconote::orphan::sweep_root(&r);
            if j + a > 0 {
                info!("orphan sweep at {}: {j} sidecar, {a} assets removed", r.display());
            }
        }
    }

    let build_time = option_env!("COCONOTE_BUILD_TIME")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    let started_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let timestamp_ms = coconote::util::now_ms();

    // Per-vault history scope so two vaults sharing filenames stay
    // isolated. Config path is the most stable identifier.
    let history_scope = config_path
        .as_deref()
        .map(|p| format!("config:{p}"))
        .unwrap_or_else(|| {
            roots_pretty
                .values()
                .next()
                .map(|p| format!("vault:{p}"))
                .unwrap_or_else(|| "vault:default".into())
        });
    let history = match coconote::history::HistoryDb::open(&history_scope).await {
        Ok(db) => {
            let arc = Arc::new(db);
            // Drop history rows for page_ids no on-disk file claims.
            // Must run after the space is fully open (we walk it for
            // the live id set). None = listing empty or failed (e.g.
            // no roots): skip the sweep, wiping the whole DB on an
            // empty boot is never right.
            match collect_live_page_ids(&space).await {
                Some(live_ids) => match arc.drop_orphan_page_ids(&live_ids).await {
                    Ok((rows, blobs)) if rows + blobs > 0 => {
                        info!(
                            "history orphan sweep: {rows} version rows, {blobs} blobs collected"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("history orphan sweep failed: {e}"),
                },
                None => info!("history orphan sweep skipped: empty listing"),
            }
            arc.spawn_pruner();
            Some(arc)
        }
        Err(e) => {
            tracing::warn!("history disabled: {e}");
            None
        }
    };

    let restart_notify = Arc::new(Notify::new());
    let state = AppState {
        live: Arc::new(ArcSwap::from_pointee(LiveSpace {
            roots: roots_pretty,
            space,
        })),
        client_bundle: Arc::new(EmbeddedReadOnlySpacePrimitives::new(timestamp_ms)),
        read_only: args.read_only,
        auth_token,
        build_time,
        started_at,
        pid: process::id(),
        history,
        config_path: config_path.as_deref().map(PathBuf::from),
        restart_notify: restart_notify.clone(),
    };

    let app = build_router(state);

    let addr: SocketAddr = format!("{}:{}", args.host, port)
        .parse()
        .map_err(|e| format!("parse addr: {e}"))?;
    if args.host == "127.0.0.1" {
        info!("coconote is local-only; pass -L 0.0.0.0 (with TLS reverse proxy) to expose publicly.");
    }
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "port {port} already in use - quit the other process \
                 (try `lsof -i :{port}`) or pass -p to choose another port"
            )
        } else {
            format!("listen {addr}: {e}")
        }
    })?;
    let visible = if args.host == "127.0.0.1" {
        format!("http://localhost:{port}")
    } else {
        format!("http://{addr}")
    };
    info!("coconote running: {visible}");

    // Distinguish "shut down for good" from "shut down to re-exec with a
    // new config dir". restart_notify fires the latter: set the flag,
    // drain axum, then exec ourselves.
    let restart_requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutdown = {
        let restart_notify = restart_notify.clone();
        let restart_requested = restart_requested.clone();
        async move {
            let ctrl_c = async {
                let _ = signal::ctrl_c().await;
            };
            let term = async {
                #[cfg(unix)]
                {
                    use signal::unix::{signal as unix_signal, SignalKind};
                    if let Ok(mut s) = unix_signal(SignalKind::terminate()) {
                        s.recv().await;
                    }
                }
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            };
            let restart = async {
                restart_notify.notified().await;
                restart_requested.store(true, std::sync::atomic::Ordering::SeqCst);
            };
            tokio::select! {
                _ = ctrl_c => {},
                _ = term => {},
                _ = restart => {},
            }
            info!("graceful shutdown initiated");
        }
    };

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .map_err(|e| format!("serve: {e}"))?;

    info!("graceful shutdown complete");

    if restart_requested.load(std::sync::atomic::Ordering::SeqCst) {
        restart_self()?;
    }
    Ok(())
}

/// Replace the current process with a fresh copy (same args). Triggered
/// by Setting -> Config file via `PATCH /.config` with `{configDir}` so
/// the new yaml location takes effect. Unix exec() keeps the PID,
/// Windows spawns a child and exits.
fn restart_self() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    info!("re-executing {} for config-path change", exe.display());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe).args(&args).exec();
        // exec only returns on failure.
        Err(format!("exec {}: {err}", exe.display()))
    }
    #[cfg(not(unix))]
    {
        std::process::Command::new(&exe)
            .args(&args)
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", exe.display()))?;
        std::process::exit(0);
    }
}

/// Collect every page_id in the live space (frontmatter / sidecar),
/// INCLUDING excluded pages (`coconote: false`): excluding a page must
/// not delete its history. None when the listing fails or is empty (no
/// roots), so the caller skips the sweep instead of dropping every row.
async fn collect_live_page_ids(
    space: &coconote::state::DynSpace,
) -> Option<std::collections::HashSet<String>> {
    let entries = space.fetch_file_list_all(true).await.ok()?;
    if entries.is_empty() {
        return None;
    }
    let mut out = std::collections::HashSet::new();
    for e in entries {
        if !e.page_id.is_empty() {
            out.insert(e.page_id);
        }
    }
    Some(out)
}
