// Catch-all fallback: serve the embedded client bundle for any GET that
// doesn't match the spec API. The client is a single-page app: any path
// resolves to index.html and the client routes on the path itself.

use crate::state::AppState;
use crate::util::decode_path;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

const INDEX_HTML_PATH: &str = ".client/index.html";

pub async fn static_or_index(State(app): State<AppState>, req: Request) -> Response {
    // GETs only (server.md: "Any GET that doesn't match ... falls
    // back"): an unmatched POST/DELETE must surface an error, not a
    // 200 index.html.
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = decode_path(req.uri().path());

    // 1. Try a literal hit on the embedded bundle (CSS, JS, fonts, ...).
    if let Ok(data) = app.client_bundle.read_file(&path) {
        let mut r = Response::new(Body::from(data));
        let ct = crate::util::content_type(&path).unwrap_or("application/octet-stream");
        if let Ok(v) = HeaderValue::from_str(ct) {
            r.headers_mut().insert(header::CONTENT_TYPE, v);
        }
        r.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return r;
    }

    // 2. Otherwise serve index.html: client-side routing takes over.
    let idx = match app.client_bundle.read_file(INDEX_HTML_PATH) {
        Ok(x) => x,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                "client bundle not embedded - run `npm run build` and rebuild",
            )
                .into_response();
        }
    };
    let mut r = String::from_utf8_lossy(&idx).into_owned().into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}
