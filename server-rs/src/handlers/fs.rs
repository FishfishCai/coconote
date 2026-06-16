// /.file CRUD (server.md): GET listing, GET/HEAD <path> (body + X-* meta,
// HEAD has no body and no X-Content-Hash), PUT ?save_type=/?type=dir,
// DELETE (file or empty dir). If-Modified-Since -> 304, X-If-Unmodified-
// Since mismatch -> 409 stale write. PUT, the only wire write path,
// records history rows when the file has a frontmatter `id:`.

use crate::error::Result;
use crate::history::SaveType;
use crate::state::AppState;
use crate::types::{Entry, Perm};

use axum::body::Body;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;
use std::sync::Arc;

const X_PERMISSION: HeaderName = HeaderName::from_static("x-permission");
const X_LAST_MODIFIED: HeaderName = HeaderName::from_static("x-last-modified");
const X_CONTENT_HASH: HeaderName = HeaderName::from_static("x-content-hash");
const X_IF_UNMODIFIED_SINCE: HeaderName = HeaderName::from_static("x-if-unmodified-since");
const IF_MODIFIED_SINCE: HeaderName = HeaderName::from_static("if-modified-since");

fn perm_str(p: Perm) -> &'static str {
    match p {
        Perm::Ro => "ro",
        Perm::Rw => "rw",
    }
}

/// Spec metadata headers. X-Content-Hash appears only when the entry
/// carries a hash, i.e. on full-body reads and writes. Metadata-only
/// entries (HEAD, 304, dir creation, conflict) have an empty hash.
fn set_meta_headers(headers: &mut HeaderMap, e: &Entry) {
    headers.insert(
        X_PERMISSION,
        HeaderValue::from_static(perm_str(e.perm)),
    );
    if let Ok(v) = HeaderValue::from_str(&e.mtime.to_string()) {
        headers.insert(X_LAST_MODIFIED, v);
    }
    if !e.content_hash.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&e.content_hash) {
            headers.insert(X_CONTENT_HASH, v);
        }
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    /// `?all=1` returns every supported md/pdf, with `coconote: false` on
    /// unadmitted rows (content.md path-view "show all supported files").
    all: Option<String>,
    /// `?prefix=path/.foo.assets/` lists every file path under the prefix
    /// (dot dirs included) as a flat JSON string array. Lets the client
    /// walk a md file's assets folder, which the regular listing filters out.
    prefix: Option<String>,
}

pub async fn list(
    State(app): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Response> {
    if let Some(prefix) = q.prefix.as_deref() {
        let paths = app.space().list_under_prefix(prefix).await?;
        return Ok(Json(paths).into_response());
    }
    let include_excluded = matches!(q.all.as_deref(), Some("1") | Some("true"));
    let entries = app
        .space()
        .fetch_file_list_all(include_excluded)
        .await?;
    Ok(Json(entries).into_response())
}

#[derive(Deserialize)]
pub struct PutQuery {
    save_type: Option<String>,
    #[serde(rename = "type")]
    type_: Option<String>,
}

pub async fn get_or_head(
    State(app): State<AppState>,
    method: Method,
    AxPath(path): AxPath<String>,
    headers: HeaderMap,
) -> Result<Response> {
    // Axum's Path extractor already percent-decoded the capture,
    // decoding again would corrupt names with a literal `%HH`.
    let path = path.trim_start_matches('/').to_string();
    let sp = app.space();

    // Conditional GET (ms epoch). HEAD also honors it.
    if let Some(client_mtime) = headers
        .get(&IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
    {
        if let Ok(meta) = sp.get_file_meta(&path).await {
            if meta.mtime <= client_mtime {
                let mut h = HeaderMap::new();
                set_meta_headers(&mut h, &meta);
                let mut r = (StatusCode::NOT_MODIFIED, "").into_response();
                r.headers_mut().extend(h);
                return Ok(r);
            }
        }
    }

    if method == Method::HEAD {
        // HEAD never reads the body and never computes hashes.
        let meta = sp.get_file_meta(&path).await?;
        let mut h = HeaderMap::new();
        set_meta_headers(&mut h, &meta);
        let mut r = Response::new(Body::empty());
        *r.headers_mut() = h;
        return Ok(r);
    }

    let (data, meta) = sp.read_file(&path).await?;
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, &meta);
    if let Some(ct) = crate::util::content_type(&path) {
        if let Ok(v) = HeaderValue::from_str(ct) {
            h.insert(header::CONTENT_TYPE, v);
        }
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let mut r = Response::new(Body::from(data));
    *r.headers_mut() = h;
    Ok(r)
}

pub async fn put(
    State(app): State<AppState>,
    AxPath(path): AxPath<String>,
    Query(q): Query<PutQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response> {
    // Already percent-decoded by the Path extractor (see get_or_head).
    let path = path.trim_start_matches('/').to_string();
    let sp = app.space();

    // ?type=dir creates an empty directory: body and save_type ignored.
    if q.type_.as_deref() == Some("dir") {
        let e = sp.create_dir(&path).await?;
        let mut h = HeaderMap::new();
        set_meta_headers(&mut h, &e);
        let mut r = (StatusCode::OK, "OK").into_response();
        r.headers_mut().extend(h);
        return Ok(r);
    }

    // Optimistic concurrency.
    if let Some(client_mtime) = headers
        .get(&X_IF_UNMODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
    {
        if let Ok(cur) = sp.get_file_meta(&path).await {
            if cur.mtime > client_mtime {
                let mut h = HeaderMap::new();
                set_meta_headers(&mut h, &cur);
                let mut r = (StatusCode::CONFLICT, "stale write").into_response();
                r.headers_mut().extend(h);
                return Ok(r);
            }
        }
    }

    let written = sp.write_file(&path, &body).await?;
    if let Some(h) = &app.history {
        record_history(h.clone(), sp.clone(), &path, &written, &body, q.save_type.as_deref())
            .await;
    }
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, &written);
    let mut r = (StatusCode::OK, "OK").into_response();
    r.headers_mut().extend(h);
    Ok(r)
}

pub async fn delete(
    State(app): State<AppState>,
    AxPath(path): AxPath<String>,
) -> Result<Response> {
    // Already percent-decoded by the Path extractor (see get_or_head).
    let path = path.trim_start_matches('/');
    app.space().delete_file(path).await?;
    Ok((StatusCode::OK, "OK").into_response())
}

/// Insert one history row for a successful PUT (history.md SaveType).
/// Also called by the collab 5 s checkpoint so per-save history is
/// recorded uniformly for HTTP PUT and WebSocket Yjs sync.
pub(crate) async fn record_history(
    h: Arc<crate::history::HistoryDb>,
    sp: crate::state::DynSpace,
    path: &str,
    written: &Entry,
    body: &[u8],
    save_type_q: Option<&str>,
) {
    if written.page_id.is_empty() {
        return;
    }
    let body_hash = crate::util::blake3_hex(body);
    // If write_file auto-injected an id, the persisted bytes diverge
    // from `body`: re-read so the recorded version matches what readers
    // will see.
    let bytes_for_history: Vec<u8> = if written.content_hash != body_hash {
        match sp.read_file(path).await {
            Ok((b, _)) => b,
            Err(_) => body.to_vec(),
        }
    } else {
        body.to_vec()
    };
    // An explicit `?save_type=push|pull` is honoured verbatim: those are
    // cross-vault syncs whose provenance must survive even on the very
    // first write of a page id. With None the create-vs-edit decision is
    // made inside record()'s own INSERT, so two racing first writes
    // can't both land as `create`.
    let explicit = save_type_q.and_then(SaveType::from_put_query);
    let main_file = path.rsplit('/').next().unwrap().to_string();
    let pid = written.page_id.clone();
    let path_owned = path.to_string();
    tokio::spawn(async move {
        // For .md pages also pull every file under `.<name>.assets/` so
        // Restore returns body and images (history.md "page's full file
        // set = md body + every image under .<name>.assets/").
        let extra = if path_owned.to_ascii_lowercase().ends_with(".md") {
            gather_md_assets(&sp, &path_owned).await
        } else {
            Vec::new()
        };
        if extra.is_empty() {
            if let Err(e) = h
                .record_single(&pid, explicit, &main_file, &bytes_for_history)
                .await
            {
                tracing::warn!("history record({pid}): {e}");
            }
            return;
        }
        let main_hash = crate::util::blake3_hex(&bytes_for_history);
        let mut files = indexmap::IndexMap::new();
        files.insert(main_file.clone(), main_hash.clone());
        let mut blobs: Vec<(String, Vec<u8>)> =
            vec![(main_hash, bytes_for_history)];
        for (rel, bytes) in extra {
            let hash = crate::util::blake3_hex(&bytes);
            files.insert(rel, hash.clone());
            blobs.push((hash, bytes));
        }
        let manifest = crate::history::Manifest { files };
        if let Err(e) = h.record(&pid, explicit, &manifest, &blobs).await {
            tracing::warn!("history record({pid}): {e}");
        }
    });
}

/// Walk the on-disk `.<name>.assets/` of an md page, returning
/// `(.<name>.assets/<f>, bytes)` tuples. Keys keep the assets-dir
/// component so the flat manifest stays unambiguous next to the md
/// basename and Restore can re-target under the page's current stem.
/// Empty when the folder is absent.
async fn gather_md_assets(
    sp: &crate::state::DynSpace,
    md_path: &str,
) -> Vec<(String, Vec<u8>)> {
    let assets_prefix = crate::util::assets_prefix_for(md_path);
    // Manifest keys are relative to the page's directory.
    let dir_len = md_path.rfind('/').map(|i| i + 1).unwrap_or(0);
    // Walk the per-page `.<name>.assets/` subtree only, not the whole space.
    let Ok(paths) = sp.list_under_prefix(&assets_prefix).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for path in paths {
        match sp.read_file(&path).await {
            Ok((bytes, _)) => {
                let name = path[dir_len..].to_string();
                out.push((name, bytes));
            }
            Err(err) => {
                tracing::warn!("history asset read {}: {err}", path);
            }
        }
    }
    out
}

