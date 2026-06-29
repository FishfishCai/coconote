// Bearer-token + access-boundary middleware (design.md API). Only
// PROTECTED_PREFIXES are gated, the rest (bundle, SPA fallback, /.health)
// stays open so a remote browser can load the UI and present the token at
// login. Loopback bypass requires loopback peer AND loopback Host AND
// same-origin (rationales on the helpers below). /.collab also accepts
// `?token=` (browsers can't set custom headers on WS handshakes). After
// auth, the boundary middleware reads the loopback/remote tag and (for
// remote) enforces the refs-closure reachability of `?id=` and rejects
// `?path=` (path addressing is loopback-only). Constant-time compare avoids
// timing leaks.

use crate::handlers::fs::Loopback;
use crate::state::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use subtle::ConstantTimeEq;

/// API prefixes that require auth. All other paths (static assets,
/// index fallback, /.health) stay open.
const PROTECTED_PREFIXES: &[&str] = &["/.file", "/.history", "/.config", "/.collab", "/.resolve"];

fn is_protected(path: &str) -> bool {
    PROTECTED_PREFIXES.iter().any(|p| {
        path == *p
            || path
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Whether a request qualifies for the loopback bypass: loopback peer AND
/// loopback Host AND same-origin.
fn is_loopback(addr: &SocketAddr, req: &Request) -> bool {
    addr.ip().is_loopback() && host_is_loopback(req) && origin_is_self(req)
}

/// Loopback status for the request, computed once by require_bearer (the
/// outer layer) and stashed as a `Loopback` extension; require_boundary only
/// reads it here. An absent marker is unreachable (require_bearer always
/// inserts it first), so default to non-loopback and let the boundary gate.
fn loopback_of(req: &Request) -> bool {
    matches!(req.extensions().get::<Loopback>(), Some(Loopback(true)))
}

/// Last value of query key `key`, percent-decoded, if present. Takes the
/// LAST occurrence so duplicate keys match serde_urlencoded (what the
/// handlers parse), closing the boundary-vs-handler disagreement on a
/// crafted `?path=a&path=b`.
fn query_param(req: &Request, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    req.uri().query().and_then(|q| {
        q.split('&')
            .filter_map(|pair| pair.strip_prefix(prefix.as_str()))
            .last()
            .map(|raw| {
                percent_encoding::percent_decode_str(raw)
                    .decode_utf8_lossy()
                    .into_owned()
            })
    })
}

/// Read the request's loopback status (stashed by require_bearer) and, for
/// remote requests, enforce the id refs-closure boundary (design.md: remote
/// reach = recent + pin transitive closure over refs ids) and reject `?path=`
/// (path addressing is loopback-only). Loopback requests reach any id/path;
/// /.health and /.config carry no id and are not boundary-gated here.
pub async fn require_boundary(
    State(app): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if !loopback_of(&req) {
        // Path addressing is a loopback-only convenience; a remote caller
        // must use an id (no disk paths cross the wire).
        if query_param(&req, "path").is_some() {
            return (StatusCode::BAD_REQUEST, "path addressing is loopback-only").into_response();
        }
        if let Some(id) = query_param(&req, "id") {
            let b = app.boundary();
            if !crate::boundary::is_allowed(&id, false, &b.recent, &b.pin, &app.resolver) {
                return (StatusCode::BAD_REQUEST, "id outside access boundary").into_response();
            }
        }
    }
    next.run(req).await
}

pub async fn require_bearer(
    State(app): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    // Compute loopback once here (the outer layer) and stash it so the
    // inner require_boundary reuses it instead of recomputing per request.
    let loopback = is_loopback(&addr, &req);
    req.extensions_mut().insert(Loopback(loopback));
    if !is_protected(req.uri().path()) {
        return next.run(req).await;
    }
    if loopback {
        return next.run(req).await;
    }
    let header_token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        // RFC 6750: the auth scheme is case-insensitive.
        .and_then(|s| {
            s.get(..7)
                .filter(|scheme| scheme.eq_ignore_ascii_case("bearer "))
                .map(|_| &s[7..])
        });
    let query_token = query_param(&req, "token");
    let presented_bytes: &[u8] = match (header_token, query_token.as_deref()) {
        (Some(h), _) => h.as_bytes(),
        (None, Some(q)) => q.as_bytes(),
        (None, None) => b"",
    };
    if presented_bytes
        .ct_eq(app.auth_token.as_bytes())
        .into()
    {
        return next.run(req).await;
    }
    (
        StatusCode::FORBIDDEN,
        "missing or invalid bearer token",
    )
        .into_response()
}

/// True when Host (or :authority) names a loopback host: `localhost`,
/// `127.0.0.1`, or `[::1]`, any port. Behind a same-host reverse proxy
/// every remote request arrives from a loopback peer, so the peer IP
/// alone must not unlock the bypass: the proxy preserves the public
/// hostname here, telling proxied traffic apart from a local visit.
fn host_is_loopback(req: &Request) -> bool {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .or_else(|| req.uri().authority().map(|a| a.as_str()));
    let Some(host) = host.map(str::trim) else {
        return false;
    };
    // Bracketed IPv6 literal, optionally with port.
    if let Some(rest) = host.strip_prefix('[') {
        return rest.find(']').is_some_and(|end| &rest[..end] == "::1");
    }
    let bare = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    bare.eq_ignore_ascii_case("localhost") || bare == "127.0.0.1"
}

/// Loopback requests without an Origin (curl, same-origin XHR/fetch) are
/// first-party. A cross-origin request carries the calling page's Origin
/// and must still present the bearer even on 127.0.0.1, else a malicious
/// page in the user's browser could exfiltrate the vault.
fn origin_is_self(req: &Request) -> bool {
    let Some(origin) = req.headers().get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    // Strip scheme to compare host:port against the Host header.
    let origin_host = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    req.headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|host| host == origin_host)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_only_api_prefixes() {
        for p in [
            "/.file", "/.history", "/.config", "/.collab", "/.resolve", "/.history/restore",
        ] {
            assert!(is_protected(p), "{p} must be gated");
        }
        for p in ["/.health", "/", "/index.html", "/.setting", "/.filex"] {
            assert!(!is_protected(p), "{p} must stay open");
        }
    }

    #[test]
    fn query_param_decodes() {
        let req = Request::builder()
            .uri("/.file?path=%2Ftmp%2Fa%20b.md")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(query_param(&req, "path").as_deref(), Some("/tmp/a b.md"));
        let no_q = Request::builder()
            .uri("/.health")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(query_param(&no_q, "path"), None);
    }

    #[test]
    fn query_param_takes_last_duplicate() {
        // serde_urlencoded keeps the LAST value of a repeated key, so the
        // boundary check must read the same one or a crafted
        // `?path=allowed&path=secret` would gate the wrong path.
        let req = Request::builder()
            .uri("/.file?path=/in/closure.md&path=/out/secret.md")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(query_param(&req, "path").as_deref(), Some("/out/secret.md"));
    }

    #[test]
    fn loopback_hosts() {
        for h in ["localhost", "localhost:40704", "127.0.0.1:1", "[::1]:40704", "LOCALHOST"] {
            let req = Request::builder()
                .uri("/.file")
                .header(header::HOST, h)
                .body(axum::body::Body::empty())
                .unwrap();
            assert!(host_is_loopback(&req), "{h} should count as loopback");
        }
        for h in ["notes.example.com", "notes.example.com:443", "127.0.0.2", "[2001:db8::1]"] {
            let req = Request::builder()
                .uri("/.file")
                .header(header::HOST, h)
                .body(axum::body::Body::empty())
                .unwrap();
            assert!(!host_is_loopback(&req), "{h} must NOT count as loopback");
        }
    }
}
