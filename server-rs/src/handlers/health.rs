// GET /.health (SPEC-redesign): a service self-description so a client can
// probe that a url really is a coconote server. No root map (the file-centric
// model has no vault): app / version / pid / startedAt.

use crate::state::AppState;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Json, Response};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    app: &'static str,
    version: String,
    pid: u32,
    started_at: String,
}

pub async fn health(State(app): State<AppState>) -> Response {
    let body = HealthBody {
        app: "coconote",
        version: app.build_time.clone(),
        pid: app.pid,
        started_at: app.started_at.clone(),
    };
    let mut r = Json(body).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-cache"));
    r
}
