// GET /.health (server.md): {app, version, pid, startedAt, rootPath}.
// Spec spells "rootPath" but welcome.md allows multiple local roots, so
// the value is a map {name -> absolute path} keyed by yaml root names.

use crate::state::AppState;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Json, Response};
use indexmap::IndexMap;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    app: &'static str,
    version: String,
    pid: u32,
    started_at: String,
    root_path: IndexMap<String, String>,
}

pub async fn health(State(app): State<AppState>) -> Response {
    let body = HealthBody {
        app: "coconote",
        version: app.build_time.clone(),
        pid: app.pid,
        started_at: app.started_at.clone(),
        root_path: app.roots_snapshot(),
    };
    let mut r = Json(body).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-cache"));
    r
}
