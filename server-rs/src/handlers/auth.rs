// Bearer-token middleware (server.md §API).
//
// Only the API surface (/.file, /.history, /.config, /.collab) is
// gated. Everything else — the embedded client bundle, the SPA index
// fallback (client routes like /.content/*, /.setting) and /.health —
// serves unauthenticated, so a remote browser can load the UI and
// present the token at login (welcome.md §Headless server).
//
// Loopback bypasses ONLY when all of these hold:
//   - the TCP peer address is loopback;
//   - the Host header names a loopback host (localhost / 127.0.0.1 /
//     [::1], any port) — behind a same-host reverse proxy every remote
//     request arrives from a loopback peer, so the peer IP alone must
//     not unlock the bypass;
//   - the request is same-origin or has no Origin header — a
//     cross-origin fetch from a malicious page in the user's browser
//     must still present the bearer, otherwise CORS-permissive
//     defaults would let any web page exfiltrate the vault.
// Browsers can't set custom headers on WS handshakes, so /.collab/*
// also accepts `?token=`. Constant-time compare avoids timing leaks.

use crate::state::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use subtle::ConstantTimeEq;

/// API prefixes that require auth; all other paths (static assets,
/// index fallback, /.health) stay open.
const PROTECTED_PREFIXES: &[&str] = &["/.file", "/.history", "/.config", "/.collab"];

fn is_protected(path: &str) -> bool {
    PROTECTED_PREFIXES.iter().any(|p| {
        path == *p
            || path
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

pub async fn require_bearer(
    State(app): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if !is_protected(req.uri().path()) {
        return next.run(req).await;
    }
    if addr.ip().is_loopback() && host_is_loopback(&req) && origin_is_self(&req) {
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
    let query_token = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("token=")))
        .map(|raw| percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned());
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

/// True when the request's Host (or :authority) names a loopback host:
/// `localhost`, `127.0.0.1` or `[::1]`, any port. A same-host reverse
/// proxy preserves the public hostname here, which is what lets us
/// tell proxied remote traffic apart from a genuine local visit.
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

/// Loopback requests without an Origin (curl, same-origin XHR/fetch)
/// are treated as first-party. A browser-initiated cross-origin
/// request carries an Origin header from the calling page; that path
/// must always present the bearer even on 127.0.0.1.
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
        for p in ["/.file", "/.file/a/b.md", "/.history/x", "/.config", "/.collab/n.md"] {
            assert!(is_protected(p), "{p} must be gated");
        }
        for p in ["/.health", "/", "/index.html", "/.content/tag", "/.setting", "/.filex"] {
            assert!(!is_protected(p), "{p} must stay open");
        }
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
