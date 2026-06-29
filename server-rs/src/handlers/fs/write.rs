// PUT / DELETE /.file. PUT honours X-If-Unmodified-Since (-> 409), routes an
// `?asset=` to the sidecar path, keeps remote writes frontmatter-read-only,
// stamps the id, and records an in-place history row. DELETE removes the file
// and forgets the id (main file only). `record_history` is shared with collab.
use super::asset::put_asset;
use super::headers::{set_id_header, set_meta_headers, X_IF_UNMODIFIED_SINCE};
use super::{owner_id, resolve_target, FileQuery, Loopback};
use crate::error::Result;
use crate::history::SaveType;
use crate::meta;
use crate::state::AppState;
use crate::types::Entry;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

pub async fn put(
    State(app): State<AppState>,
    Extension(Loopback(loopback)): Extension<Loopback>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response> {
    let target = resolve_target(&app, &q, loopback, true)?;
    let file_path = target.file_path();
    let sp = app.space();

    // Optimistic concurrency on the file actually being written.
    if let Some(client_mtime) = headers
        .get(&X_IF_UNMODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
    {
        if let Ok(cur) = sp.get_file_meta(&file_path).await {
            if cur.mtime > client_mtime {
                let mut h = HeaderMap::new();
                set_meta_headers(&mut h, &cur);
                let mut r = (StatusCode::CONFLICT, "stale write").into_response();
                r.headers_mut().extend(h);
                return Ok(r);
            }
        }
    }

    if target.is_asset() {
        return put_asset(&app, &target, &q, loopback, &body).await;
    }

    // Remote writes are frontmatter read-only: keep the on-disk frontmatter,
    // accept only the body (design.md). The desired id (loopback create) is
    // stamped into a brand-new file's frontmatter by write_file.
    let to_write = if loopback {
        body.to_vec()
    } else {
        merge_remote_body(&sp, &file_path, &body).await
    };

    // Stamp id = the addressed id, else the file's existing id (a body-only
    // write must not re-mint), else a fresh one (new file). An existing valid
    // id inside the incoming frontmatter still wins inside write_file.
    let desired_id = target
        .resolved_id
        .clone()
        .or_else(|| meta::read_id(&file_path));
    let written = sp
        .write_file(&file_path, &to_write, desired_id.as_deref())
        .await?;
    record_history(
        &file_path,
        &written,
        &to_write,
        q.save_type.as_deref(),
        q.peer.clone(),
    );
    // Learn / confirm the id and keep the resolver index current.
    let id = match &target.resolved_id {
        Some(id) => {
            app.resolver.index_path(id, &file_path);
            Some(id.clone())
        }
        None => owner_id(&app, &target),
    };
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, &written);
    set_id_header(&mut h, &id);
    let mut r = (StatusCode::OK, "OK").into_response();
    r.headers_mut().extend(h);
    Ok(r)
}

pub async fn delete(
    State(app): State<AppState>,
    Extension(Loopback(loopback)): Extension<Loopback>,
    Query(q): Query<FileQuery>,
) -> Result<Response> {
    let target = resolve_target(&app, &q, loopback, false)?;
    app.space().delete_file(&target.file_path()).await?;
    // Forget the id when the main file (not an asset) is deleted.
    if !target.is_asset() {
        if let Some(id) = &target.resolved_id {
            app.resolver.forget(id);
        }
    }
    Ok((StatusCode::OK, "OK").into_response())
}

/// On a remote PUT, splice the on-disk frontmatter back over the incoming
/// body so the remote can only change the body. A missing/unreadable
/// on-disk file leaves the incoming bytes untouched (first write).
async fn merge_remote_body(sp: &crate::space::Disk, path: &str, body: &[u8]) -> Vec<u8> {
    match sp.read_file(path).await {
        Ok((disk, _)) => crate::frontmatter::merge_remote_frontmatter(&disk, body),
        Err(_) => body.to_vec(),
    }
}

/// Record one in-place history row for a successful write (design.md
/// history). Called by PUT and by the collab checkpoint with the OWNER path
/// (the md/pdf the request addressed). History always keys off the owner so a
/// pdf's `.history/` lives in its `.<stem>.assets/`, but the bytes versioned
/// are the owner's CONTENT:
///   - markdown: the md file itself, plus its `.<name>.assets/` images;
///   - pdf: the sidecar json (keyed under `.<stem>.assets/<stem>.json`), the
///     immutable binary is never versioned.
/// `written` / `body` describe the content bytes just persisted. `peer` stamps
/// a push/pull row. Runs on a blocking thread; failures are logged, never
/// surfaced to the client.
pub(crate) fn record_history(
    owner_path: &str,
    written: &Entry,
    body: &[u8],
    save_type_q: Option<&str>,
    peer: Option<String>,
) {
    // An explicit ?save_type=push|pull is honoured verbatim; edit/None let the
    // store pick create-vs-edit (first row is always create).
    let explicit = save_type_q.and_then(SaveType::from_put_query);
    let is_pdf = meta::is_pdf(owner_path);
    // The content file whose bytes are versioned, and its manifest key.
    let (content_path, main_file) = if is_pdf {
        (
            crate::util::pdf_sidecar_for(owner_path),
            crate::util::pdf_sidecar_rel_key(owner_path),
        )
    } else {
        (
            owner_path.to_string(),
            owner_path.rsplit('/').next().unwrap_or(owner_path).to_string(),
        )
    };
    let owner_owned = owner_path.to_string();
    let gather_assets = meta::is_md(owner_path);
    // The persisted bytes (post frontmatter-stamp) are what readers see, so
    // the snapshot is keyed by the bytes actually written. write_file already
    // hashed those into `written.content_hash`, so reuse it instead of
    // re-hashing the body. `same` only decides whether a stamp rewrote the
    // bytes (then reload the content file from disk for the blob below).
    let body_owned = body.to_vec();
    let main_hash = written.content_hash.clone();
    let same = crate::util::blake3_hex(&body_owned) == main_hash;
    tokio::task::spawn_blocking(move || {
        let main_bytes = if same {
            body_owned
        } else {
            std::fs::read(&content_path).unwrap_or(body_owned)
        };
        let assets = if gather_assets {
            gather_md_assets(&owner_owned)
        } else {
            Vec::new()
        };
        let mut files = indexmap::IndexMap::new();
        files.insert(main_file.clone(), main_hash.clone());
        let mut blobs: Vec<(String, Vec<u8>)> = vec![(main_hash, main_bytes)];
        for (rel, bytes) in assets {
            let hash = crate::util::blake3_hex(&bytes);
            files.insert(rel, hash.clone());
            blobs.push((hash, bytes));
        }
        if let Err(e) = crate::history::record(&owner_owned, explicit, peer, files, &blobs) {
            tracing::warn!("history record({owner_owned}): {e}");
        }
        // Best-effort retention so history does not grow unbounded
        // (design.md history). A prune failure is non-fatal.
        if let Err(e) = crate::history::prune(&owner_owned, crate::util::now_ms()) {
            tracing::warn!("history prune({owner_owned}): {e}");
        }
    });
}

/// Walk the on-disk `.<name>.assets/` of an md file (excluding `.history/`),
/// returning `(.<name>.assets/<f>, bytes)` tuples. Empty when absent.
fn gather_md_assets(md_path: &str) -> Vec<(String, Vec<u8>)> {
    let assets_prefix = crate::util::assets_prefix_for(md_path); // ".<name>.assets/"
    let dir = std::path::Path::new(assets_prefix.trim_end_matches('/'));
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            // Skip the `.history/` subtree.
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        match std::fs::read(entry.path()) {
            Ok(bytes) => out.push((format!("{assets_prefix}{name}"), bytes)),
            Err(e) => tracing::warn!("history asset read {name}: {e}"),
        }
    }
    out
}
