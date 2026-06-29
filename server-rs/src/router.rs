// Spec API routes (design.md "server API"): GET /.health, GET /.resolve,
// GET/PUT/DELETE /.file, GET/DELETE /.history, POST /.history/restore, POST
// /.history/keep, WS /.collab, GET/PATCH /.config -- all addressed by `?id=`
// (loopback may also use `?path=`). Any unmatched GET falls back to the
// embedded client bundle (SPA routing).

use crate::handlers::{auth, collab, config, fs, health, history, resolve, ssr};
use crate::state::AppState;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, Method};
use axum::middleware;
use axum::routing::{get, post, MethodRouter};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

/// PUT /.file upper bound. The editor's large-paste path bypasses the 16MB
/// WS frame cap by going through HTTP, so this is the real file-size
/// ceiling (SPEC-redesign: PUT body cap 64 MB).
const MAX_PUT_BYTES: usize = 64 * 1024 * 1024;

pub fn build_router(state: AppState) -> Router {
    let file: MethodRouter<AppState> = MethodRouter::new()
        .get(fs::get_or_head)
        .head(fs::get_or_head)
        .put(fs::put)
        .delete(fs::delete)
        .layer(DefaultBodyLimit::max(MAX_PUT_BYTES));
    let history_route: MethodRouter<AppState> = MethodRouter::new()
        .get(history::list_or_preview)
        .delete(history::delete_at);
    let config_route: MethodRouter<AppState> = MethodRouter::new()
        .get(config::get_config)
        .patch(config::patch_config);

    // Cross-instance push/pull makes the browser call a remote coconote from
    // the local one's origin. Permissive ACAO is fine because every endpoint
    // already enforces bearer auth (loopback bypass intact). X-Content-Hash
    // etc. are exposed so the client can read them cross-origin.
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
            HeaderName::from_static("x-id"),
        ]);

    Router::new()
        .route("/.health", get(health::health))
        .route("/.resolve", get(resolve::resolve))
        .route("/.file", file)
        .route("/.history", history_route)
        .route("/.history/restore", post(history::restore))
        .route("/.history/keep", post(history::keep))
        .route("/.collab", get(collab::ws_handler))
        .route("/.config", config_route)
        .fallback(ssr::static_or_index)
        // Boundary runs AFTER auth (inner layer added first): it reads the
        // loopback/remote tag set by require_bearer and gates remote `?id=`
        // by the refs closure. require_bearer is the outer gate.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_boundary,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_bearer,
        ))
        .layer(cors)
        // gzip text responses (client.js shrinks markedly), the biggest win
        // on a remote browser's first load. Binary assets pass through.
        .layer(CompressionLayer::new())
        .with_state(state)
}
