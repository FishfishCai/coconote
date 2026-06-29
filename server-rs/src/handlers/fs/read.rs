// GET / HEAD /.file: resolve the target, honour If-Modified-Since (-> 304),
// and stream the body with the spec metadata + X-Id headers. HEAD returns the
// headers with no body and no X-Content-Hash.
use super::headers::{base_headers, IF_MODIFIED_SINCE};
use super::{owner_id, resolve_target, FileQuery, Loopback};
use crate::error::Result;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

pub async fn get_or_head(
    State(app): State<AppState>,
    Extension(Loopback(loopback)): Extension<Loopback>,
    method: Method,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response> {
    let target = resolve_target(&app, &q, loopback, false)?;
    let file_path = target.file_path();
    let sp = app.space();
    // Asset reads carry no id of their own; the owner's id gates them.
    let id = if target.is_asset() {
        target.resolved_id.clone()
    } else {
        owner_id(&app, &target)
    };

    if let Some(client_mtime) = headers
        .get(&IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
    {
        if let Ok(meta) = sp.get_file_meta(&file_path).await {
            if meta.mtime <= client_mtime {
                // Build from the bare status (no `""` body, which would add a
                // second text/plain Content-Type that extend() then appends to
                // base_headers') and set the shared header set as the whole map.
                let mut r = StatusCode::NOT_MODIFIED.into_response();
                *r.headers_mut() = base_headers(&meta, &id, &file_path);
                return Ok(r);
            }
        }
    }

    if method == Method::HEAD {
        let meta = sp.get_file_meta(&file_path).await?;
        let mut r = Response::new(Body::empty());
        *r.headers_mut() = base_headers(&meta, &id, &file_path);
        return Ok(r);
    }

    let (data, meta) = sp.read_file(&file_path).await?;
    let mut h = base_headers(&meta, &id, &file_path);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let mut r = Response::new(Body::from(data));
    *r.headers_mut() = h;
    Ok(r)
}
