// The /.file header names and the helpers that stamp them: spec metadata
// (X-Permission / X-Last-Modified / X-Content-Hash), the file id (X-Id), and
// the request-side conditional header names.
use crate::types::{Entry, Perm};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue};

/// The header set every /.file response shares: spec metadata, the file id,
/// and the path-derived Content-Type. Built in ONE place so the three
/// response branches (304 / HEAD / GET) cannot drift apart - a HEAD that
/// dropped Content-Type is exactly what made every pdf open as its raw json.
/// content_type returns only static ASCII literals, so from_static is safe.
pub(super) fn base_headers(meta: &Entry, id: &Option<String>, file_path: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, meta);
    set_id_header(&mut h, id);
    if let Some(ct) = crate::util::content_type(file_path) {
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
    }
    h
}

pub(super) const X_PERMISSION: HeaderName = HeaderName::from_static("x-permission");
pub(super) const X_LAST_MODIFIED: HeaderName = HeaderName::from_static("x-last-modified");
pub(super) const X_CONTENT_HASH: HeaderName = HeaderName::from_static("x-content-hash");
pub(super) const X_ID: HeaderName = HeaderName::from_static("x-id");
pub(super) const X_IF_UNMODIFIED_SINCE: HeaderName =
    HeaderName::from_static("x-if-unmodified-since");
pub(super) const IF_MODIFIED_SINCE: HeaderName = HeaderName::from_static("if-modified-since");

pub(super) fn perm_str(p: Perm) -> &'static str {
    match p {
        Perm::Ro => "ro",
        Perm::Rw => "rw",
    }
}

/// Spec metadata headers. X-Content-Hash appears only when the entry carries
/// a hash (full-body reads and writes).
pub(super) fn set_meta_headers(headers: &mut HeaderMap, e: &Entry) {
    headers.insert(X_PERMISSION, HeaderValue::from_static(perm_str(e.perm)));
    if let Ok(v) = HeaderValue::from_str(&e.mtime.to_string()) {
        headers.insert(X_LAST_MODIFIED, v);
    }
    if !e.content_hash.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&e.content_hash) {
            headers.insert(X_CONTENT_HASH, v);
        }
    }
}

pub(super) fn set_id_header(headers: &mut HeaderMap, id: &Option<String>) {
    if let Some(id) = id {
        if let Ok(v) = HeaderValue::from_str(id) {
            headers.insert(X_ID, v);
        }
    }
}
