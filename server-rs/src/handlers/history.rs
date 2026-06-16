// /.history endpoints (server.md): GET <page_id> lists [{ts, save_type}],
// GET ?ts=<ms> previews the main md text, DELETE ?ts=<ms> deletes one row
// (any save_type), POST /restore?ts=<ms> writes the manifest back and
// appends an edit row, POST /pin clones the latest row as save_type=pin.

use crate::error::{Error, Result};
use crate::history::SaveType;
use crate::state::AppState;

use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct TsQuery {
    ts: Option<i64>,
}

pub async fn list_or_preview(
    State(app): State<AppState>,
    AxPath(page_id): AxPath<String>,
    Query(q): Query<TsQuery>,
) -> Result<Response> {
    let Some(h) = &app.history else {
        // History disabled: list returns [], preview must 404 (clients
        // expect octet-stream and would mis-parse a JSON array).
        if q.ts.is_some() {
            return Err(Error::NotFound);
        }
        return Ok(Json(serde_json::json!([])).into_response());
    };
    if let Some(ts) = q.ts {
        let body = h
            .preview_at(&page_id, ts)
            .await
            .map_err(|e| Error::Other(e.to_string()))?
            .ok_or(Error::NotFound)?;
        let mut r = body.into_response();
        r.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::header::HeaderValue::from_static("application/octet-stream"),
        );
        Ok(r)
    } else {
        let rows = h
            .list_id(&page_id)
            .await
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(Json(rows).into_response())
    }
}

pub async fn delete_at(
    State(app): State<AppState>,
    AxPath(page_id): AxPath<String>,
    Query(q): Query<TsQuery>,
) -> Result<Response> {
    let h = app.history.as_ref().ok_or(Error::NotFound)?;
    let ts = q.ts.ok_or_else(|| Error::BadRequest("ts required".into()))?;
    let n = h
        .delete_at(&page_id, ts)
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    if n == 0 {
        return Err(Error::NotFound);
    }
    Ok((StatusCode::OK, "OK").into_response())
}

/// POST /.history/<page_id>/restore?ts=<ms>: write every blob in the
/// snapshot's manifest back to disk (history.md Restore). Spec takes only
/// `?ts=`, destination resolves by scanning the vault for the current
/// `page_id`. Callers that already know the path (history panel) may
/// pass `?path=<rel>` to skip the scan.
#[derive(Deserialize)]
pub struct RestoreQuery {
    ts: i64,
    /// Optional override, useful when the page_id is no longer on disk
    /// (file deleted) and the caller wants the snapshot somewhere specific.
    #[serde(default)]
    path: Option<String>,
}

pub async fn restore(
    State(app): State<AppState>,
    AxPath(page_id): AxPath<String>,
    Query(q): Query<RestoreQuery>,
) -> Result<Response> {
    let h = app.history.as_ref().ok_or(Error::NotFound)?;
    let manifest = h
        .manifest_at(&page_id, q.ts)
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .ok_or(Error::NotFound)?;
    let sp = app.space();
    // Resolve destination path: explicit override > live listing scan.
    let target_path = if let Some(p) = q.path {
        p
    } else {
        let list = sp.fetch_file_list_all(true).await?;
        list.into_iter()
            .find(|e| e.page_id == page_id)
            .map(|e| e.path)
            .ok_or_else(|| {
                Error::Other(format!(
                    "no live file carries page_id {page_id}; supply ?path=<rel>"
                ))
            })?
    };
    // Each entry's destination derives from the CURRENT page path (the
    // page may have been renamed since the snapshot): main `*.md` -> the
    // resolved page path, main `.<old>.json` -> `.<current_stem>.json`
    // beside the pdf, asset `.<old>.assets/f` ->
    // `<dir>/.<current_stem>.assets/f`. The manifest main of a PDF page
    // is the sidecar, never the listing's .pdf path itself.
    let assets_prefix = crate::util::assets_prefix_for(&target_path);
    // Stage 1: fetch every blob up front so a missing one aborts with
    // 500 before any disk write. Stage 2's per-file writes are each
    // atomic (tmp+rename) but the set as a whole is not transactional:
    // an I/O failure midway can still leave a partial restore.
    let mut writes: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, hash) in manifest.files.iter() {
        let bytes = h
            .get_blob(hash)
            .await
            .map_err(|e| Error::Other(e.to_string()))?
            .ok_or_else(|| Error::Other(format!("blob lost for {name}")))?;
        let dest = if name.as_str() == manifest.main_file() {
            if crate::history::is_sidecar_name(name) {
                sidecar_path_for(&target_path)
            } else {
                target_path.clone()
            }
        } else {
            format!("{assets_prefix}{}", asset_rel_name(name))
        };
        writes.push((dest, bytes));
    }
    for (dest, bytes) in &writes {
        sp.write_file(dest, bytes).await?;
    }

    // Record a new edit row mirroring the restored manifest so its asset
    // blobs stay referenced even if the source row later decays out of
    // retention.
    h.record(&page_id, Some(SaveType::Edit), &manifest, &[])
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    Ok((StatusCode::OK, "OK").into_response())
}

/// `<dir>/foo.pdf` -> `<dir>/.foo.json` (file.md sidecar naming).
fn sidecar_path_for(pdf_path: &str) -> String {
    let (dir, base) = match pdf_path.rfind('/') {
        Some(i) => (&pdf_path[..i + 1], &pdf_path[i + 1..]),
        None => ("", pdf_path),
    };
    let stem = std::path::Path::new(base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(base);
    format!("{dir}.{stem}.json")
}

/// Manifest asset keys are `.<old_stem>.assets/<f>` (current writer) or a
/// bare `<f>` (older rows). Both land under the CURRENT page's assets dir.
fn asset_rel_name(name: &str) -> &str {
    if let Some((first, rest)) = name.split_once('/') {
        if first.starts_with('.') && first.ends_with(".assets") && !rest.is_empty() {
            return rest;
        }
    }
    name
}

/// POST /.history/<page_id>/pin: clone the latest row's manifest with a
/// fresh ts and save_type=pin (history.md).
pub async fn pin(
    State(app): State<AppState>,
    AxPath(page_id): AxPath<String>,
) -> Result<Response> {
    let h = app.history.as_ref().ok_or(Error::NotFound)?;
    let manifest = h
        .latest_manifest(&page_id)
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .ok_or(Error::NotFound)?;
    // Empty blob list: the manifest references blobs already in the pool.
    h.record(&page_id, Some(SaveType::Pin), &manifest, &[])
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    Ok((StatusCode::OK, "OK").into_response())
}
