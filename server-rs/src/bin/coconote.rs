// `coconote` binary entry point. State assembly (config -> space -> orphan
// sweep -> history -> AppState) lives in coconote::boot; this file is just
// the process lifecycle: parse args, bind the listener, serve, and drain on
// SIGINT/SIGTERM (re-exec when Setting -> Config file changed the yaml dir).

use clap::Parser;
use coconote::boot::{boot, BootOptions};
use coconote::router::build_router;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::signal;
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
    let booted = boot(BootOptions {
        folder: args.folder.clone(),
        port_override: args.port,
        read_only: args.read_only,
    })
    .await?;
    let port = booted.port;
    // restart_notify drives the config-dir re-exec; grab it before the
    // state moves into the router.
    let restart_notify = booted.state.restart_notify.clone();
    let app = build_router(booted.state);

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
    let restart_requested = Arc::new(AtomicBool::new(false));
    let shutdown = {
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
                restart_requested.store(true, Ordering::SeqCst);
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

    if restart_requested.load(Ordering::SeqCst) {
        restart_self()?;
    }
    Ok(())
}

/// Replace the current process with a fresh copy (same args). Triggered
/// by Setting -> Config file via `PATCH /.config` with `{configDir}` so
/// the new yaml location takes effect. Unix exec() keeps the PID,
/// Windows spawns a child and exits.
fn restart_self() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
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
