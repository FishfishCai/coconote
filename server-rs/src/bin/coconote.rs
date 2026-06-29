// `coconote` binary entry point. State assembly (config -> AppState) lives in
// coconote::boot; this file is just the process lifecycle: parse args, bind
// the listener, serve, and drain on SIGINT/SIGTERM.

use clap::Parser;
use coconote::boot::{boot, BootOptions};
use coconote::router::build_router;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process;
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

    /// A file to open on launch (recorded as the freshest recent entry).
    file: Option<PathBuf>,
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
        open: args.file.clone(),
        port_override: args.port,
    })
    .await?;
    let port = booted.port;
    // The live filesystem watcher lives inside AppState; the running router
    // holds it for the process lifetime so watch-root tracking stays active.
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

    let shutdown = async move {
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
        tokio::select! {
            _ = ctrl_c => {},
            _ = term => {},
        }
        info!("graceful shutdown initiated");
    };

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .map_err(|e| format!("serve: {e}"))?;

    info!("graceful shutdown complete");
    Ok(())
}
