// Spec API (server.md + setting.md). Total surface:
//
//   GET     /.health
//   GET     /.file
//   GET/HEAD/PUT/DELETE  /.file/<path>
//   GET/DELETE           /.history/<page_id>
//   POST                 /.history/<page_id>/restore
//   POST                 /.history/<page_id>/pin
//   WS                   /.collab/<path>
//   GET/PATCH            /.config        (setting.md §Local + §Remote + §Config file)
//
// Any GET that doesn't match falls back to the embedded client bundle
// (server.md).

use crate::handlers::{auth, collab, config, fs, health, history, ssr};
use crate::state::AppState;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, Method};
use axum::middleware;
use axum::routing::{get, post, MethodRouter};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

/// PUT /.file/<path> upper bound. Editor's large-paste path bypasses
/// the 16MB WS frame cap by going through HTTP, so this is the real
/// vault-file size ceiling. 64MB is generous but bounded.
const MAX_PUT_BYTES: usize = 64 * 1024 * 1024;

pub fn build_router(state: AppState) -> Router {
    let file_path: MethodRouter<AppState> = MethodRouter::new()
        .get(fs::get_or_head)
        .head(fs::get_or_head)
        .put(fs::put)
        .delete(fs::delete)
        // Axum's default body cap is 2MB; raise to MAX_PUT_BYTES so
        // editor-side large-paste-over-HTTP and PDF/asset uploads work.
        .layer(DefaultBodyLimit::max(MAX_PUT_BYTES));
    let history_id: MethodRouter<AppState> = MethodRouter::new()
        .get(history::list_or_preview)
        .delete(history::delete_at);
    let config_root: MethodRouter<AppState> = MethodRouter::new()
        .get(config::get_config)
        .patch(config::patch_config);

    // Cross-vault push/pull requires browsers to call a remote
    // coconote server from the local one's origin. server.md doesn't
    // specify CORS but the browser blocks cross-origin fetches without
    // these headers; permissive ACAO is OK because every endpoint
    // already enforces bearer auth (loopback bypass remains intact).
    // X-Content-Hash etc. need to be exposed so the client can read
    // them on cross-origin responses.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET, Method::HEAD, Method::PUT, Method::POST,
            Method::PATCH, Method::DELETE, Method::OPTIONS,
        ])
        .allow_headers(Any)
        .expose_headers([
            HeaderName::from_static("x-permission"),
            HeaderName::from_static("x-last-modified"),
            HeaderName::from_static("x-content-hash"),
        ]);

    Router::new()
        .route("/.health", get(health::health))
        .route("/.file", get(fs::list))
        .route("/.file/*path", file_path)
        .route("/.history/:page_id", history_id)
        .route("/.history/:page_id/restore", post(history::restore))
        .route("/.history/:page_id/pin", post(history::pin))
        .route("/.collab/*path", get(collab::ws_handler))
        .route("/.config", config_root)
        // The handler itself 405s anything but GET/HEAD — an unmatched
        // POST/DELETE must not come back as a 200 index.html.
        .fallback(ssr::static_or_index)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_bearer,
        ))
        .layer(cors)
        // gzip text responses (client.js ~590K -> ~185K) — the biggest
        // win on a remote browser's first load. tower-http skips bodies
        // that are already compressed or not worth it; binary assets
        // (woff2/png/wasm) pass through. Loopback desktop traffic also
        // negotiates it at negligible cost.
        .layer(CompressionLayer::new())
        .with_state(state)
}
