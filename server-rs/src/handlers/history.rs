// /.history endpoints (design.md "server API"): all addressed by `?id=`.
//   GET  /.history?id=               -> [{ts, save_type, peer?}], newest first
//   GET  /.history?id=&ts=<ms>       -> that snapshot's main-file bytes
//   GET  /.history?id=&peer=<url>    -> the 3-way merge base for that peer
//   DELETE /.history?id=&ts=<ms>     -> delete one row (any save_type)
//   POST /.history/restore?id=&ts=<ms> -> write the snapshot back, append edit
//   POST /.history/keep?id=          -> clone the latest row as save_type=keep
//
// The server resolves the id to a path; history is then read from the file's
// in-place companion (`.<name>.assets/.history/`).

use crate::error::{Error, Result};
use crate::history::{self, SaveType};
use crate::state::AppState;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;

/// Resolve an `?id=` to its current path, 404 when unresolvable.
fn resolve_id(app: &AppState, id: &str) -> Result<String> {
    app.resolver.resolve(id).ok_or(Error::NotFound)
}

#[derive(Deserialize)]
pub struct ListQuery {
    id: String,
    ts: Option<i64>,
    peer: Option<String>,
}

pub async fn list_or_preview(
    State(app): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Response> {
    let path = resolve_id(&app, &q.id)?;
    if let Some(ts) = q.ts {
        let body = tokio::task::spawn_blocking(move || history::preview_at(&path, ts))
            .await
            .map_err(|e| Error::Other(e.to_string()))?
            .ok_or(Error::NotFound)?;
        Ok(octet_stream(body))
    } else if let Some(peer) = q.peer {
        // Merge base: the latest push/pull row content for that peer (empty
        // body when this file has never synced with it).
        let body = tokio::task::spawn_blocking(move || history::merge_base_for_peer(&path, &peer))
            .await
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(octet_stream(body))
    } else {
        let rows = tokio::task::spawn_blocking(move || history::list(&path))
            .await
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(Json(rows).into_response())
    }
}

fn octet_stream(body: Vec<u8>) -> Response {
    let mut r = body.into_response();
    r.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::header::HeaderValue::from_static("application/octet-stream"),
    );
    r
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    id: String,
    ts: Option<i64>,
}

pub async fn delete_at(
    State(app): State<AppState>,
    Query(q): Query<DeleteQuery>,
) -> Result<Response> {
    let ts = q.ts.ok_or_else(|| Error::BadRequest("ts required".into()))?;
    let path = resolve_id(&app, &q.id)?;
    let n = tokio::task::spawn_blocking(move || history::delete_at(&path, ts))
        .await
        .map_err(|e| Error::Other(e.to_string()))??;
    if n == 0 {
        return Err(Error::NotFound);
    }
    Ok((StatusCode::OK, "OK").into_response())
}

#[derive(Deserialize)]
pub struct RestoreQuery {
    id: String,
    ts: i64,
}

/// POST /.history/restore?id=&ts=: write every blob in the snapshot back to
/// disk relative to the file's directory (main file at the resolved path,
/// assets under `.<name>.assets/`), then append an `edit` row mirroring the
/// manifest. Non-destructive (design.md).
pub async fn restore(
    State(app): State<AppState>,
    Query(q): Query<RestoreQuery>,
) -> Result<Response> {
    let path = resolve_id(&app, &q.id)?;
    let ts = q.ts;
    let sp = app.space();
    let manifest = history::manifest_at(&path, ts).ok_or(Error::NotFound)?;
    let dir = match path.rfind('/') {
        Some(i) => &path[..i + 1],
        None => "",
    };
    let main_file = manifest.main_file().to_string();
    // Stage 1: fetch every blob up front so a missing one aborts before any
    // write. Stage 2 writes are each atomic but the set is not transactional.
    let mut writes: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, hash) in manifest.files.iter() {
        let bytes = history::read_blob(&path, hash)
            .ok_or_else(|| Error::Other(format!("blob lost for {name}")))?;
        let dest = if name == &main_file && !name.contains('/') {
            // Main file (md basename or pdf annots top-level) lands at path.
            path.clone()
        } else {
            // Asset or sidecar keyed relative to the file's directory.
            format!("{dir}{name}")
        };
        writes.push((dest, bytes));
    }
    for (dest, bytes) in &writes {
        sp.write_file(dest, bytes, None).await?;
    }
    // Append a fresh edit row mirroring the manifest so its blobs stay
    // referenced even if the source row later decays.
    let files = manifest.files.clone();
    let path_owned = path.clone();
    tokio::task::spawn_blocking(move || {
        let ts = history::record(&path_owned, Some(SaveType::Edit), None, files, &[])?;
        // Best-effort retention after the row lands (design.md history).
        if let Err(e) = history::prune(&path_owned, crate::util::now_ms()) {
            tracing::warn!("history prune({path_owned}): {e}");
        }
        Ok::<_, Error>(ts)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;
    Ok((StatusCode::OK, "OK").into_response())
}

#[derive(Deserialize)]
pub struct KeepQuery {
    id: String,
}

/// POST /.history/keep?id=: clone the latest row's manifest with a fresh ts
/// and save_type=keep -- a permanent retention point (design.md).
pub async fn keep(State(app): State<AppState>, Query(q): Query<KeepQuery>) -> Result<Response> {
    let path = resolve_id(&app, &q.id)?;
    let manifest = history::latest_manifest(&path).ok_or(Error::NotFound)?;
    let files = manifest.files;
    tokio::task::spawn_blocking(move || {
        let ts = history::record(&path, Some(SaveType::Keep), None, files, &[])?;
        // Best-effort retention after the row lands (design.md history). A
        // `keep` row is never pruned, but decayed `edit` rows around it are.
        if let Err(e) = history::prune(&path, crate::util::now_ms()) {
            tracing::warn!("history prune({path}): {e}");
        }
        Ok::<_, Error>(ts)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;
    Ok((StatusCode::OK, "OK").into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolver::Resolver;
    use crate::state::{AppState, Boundary};
    use arc_swap::ArcSwap;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn test_app() -> AppState {
        AppState {
            client_bundle: crate::space::ClientBundle::new(),
            boundary: Arc::new(ArcSwap::from_pointee(Boundary::default())),
            resolver: Arc::new(Resolver::new(vec![])),
            auth_token: String::new(),
            build_time: String::new(),
            started_at: String::new(),
            pid: 0,
            config_path: None,
            watcher: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn abs(d: &TempDir, name: &str) -> String {
        d.path().join(name).to_string_lossy().into_owned()
    }

    /// Create an md file with a known id and index it so handlers can resolve.
    fn seed(app: &AppState, d: &TempDir, name: &str, id: &str) -> String {
        let p = abs(d, name);
        std::fs::write(&p, format!("---\nid: {id}\ntitle: {name}\n---\nbody\n")).unwrap();
        app.resolver.index_path(id, &p);
        p
    }

    #[tokio::test]
    async fn list_returns_rows_newest_first() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "note.md", "listid0000000000");
        history::record_single(&p, Some(SaveType::Create), "note.md", b"v1").unwrap();
        history::record_single(&p, Some(SaveType::Edit), "note.md", b"v2").unwrap();
        let r = list_or_preview(
            State(app),
            Query(ListQuery { id: "listid0000000000".into(), ts: None, peer: None }),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_id_is_not_found() {
        let app = test_app();
        let err = list_or_preview(
            State(app),
            Query(ListQuery { id: "missingid0000000".into(), ts: None, peer: None }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::NotFound));
    }

    #[tokio::test]
    async fn preview_unknown_ts_is_not_found() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "note.md", "previewid0000000");
        history::record_single(&p, Some(SaveType::Create), "note.md", b"v1").unwrap();
        let err = list_or_preview(
            State(app),
            Query(ListQuery { id: "previewid0000000".into(), ts: Some(999), peer: None }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::NotFound));
    }

    #[tokio::test]
    async fn merge_base_endpoint_returns_peer_content() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "note.md", "mergeid000000000");
        // Record a push row for a peer.
        let hash = crate::util::blake3_hex(b"synced");
        let mut files = indexmap::IndexMap::new();
        files.insert("note.md".to_string(), hash.clone());
        history::record(
            &p,
            Some(SaveType::Push),
            Some("https://peer.example".into()),
            files,
            &[(hash, b"synced".to_vec())],
        )
        .unwrap();
        let r = list_or_preview(
            State(app),
            Query(ListQuery {
                id: "mergeid000000000".into(),
                ts: None,
                peer: Some("https://peer.example".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let body = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"synced");
    }

    #[tokio::test]
    async fn delete_then_404_on_repeat() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "note.md", "deleteid00000000");
        let ts = history::record_single(&p, Some(SaveType::Create), "note.md", b"x").unwrap();
        let r = delete_at(
            State(app.clone()),
            Query(DeleteQuery { id: "deleteid00000000".into(), ts: Some(ts) }),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let err = delete_at(
            State(app),
            Query(DeleteQuery { id: "deleteid00000000".into(), ts: Some(ts) }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::NotFound));
    }

    #[tokio::test]
    async fn delete_without_ts_is_bad_request() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        seed(&app, &d, "note.md", "nodeletets000000");
        let err = delete_at(
            State(app),
            Query(DeleteQuery { id: "nodeletets000000".into(), ts: None }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, Error::BadRequest(_)));
    }

    #[tokio::test]
    async fn restore_writes_main_and_asset_back_and_appends_edit() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "page.md", "restoreid0000000");
        // Record a snapshot with a main file and an asset.
        let mut files = indexmap::IndexMap::new();
        let main_bytes = b"---\nid: restoreid0000000\ntitle: page\n---\nrestored body";
        let asset_bytes = b"PNGDATA";
        files.insert("page.md".to_string(), crate::util::blake3_hex(main_bytes));
        files.insert(
            ".page.assets/img.png".to_string(),
            crate::util::blake3_hex(asset_bytes),
        );
        let blobs = vec![
            (crate::util::blake3_hex(main_bytes), main_bytes.to_vec()),
            (crate::util::blake3_hex(asset_bytes), asset_bytes.to_vec()),
        ];
        let ts = history::record(&p, Some(SaveType::Edit), None, files, &blobs).unwrap();
        let r = restore(
            State(app.clone()),
            Query(RestoreQuery { id: "restoreid0000000".into(), ts }),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let (main, _) = app.space().read_file(&p).await.unwrap();
        assert_eq!(main, b"---\nid: restoreid0000000\ntitle: page\n---\nrestored body");
        let (asset, _) = app
            .space()
            .read_file(&abs(&d, ".page.assets/img.png"))
            .await
            .unwrap();
        assert_eq!(asset, b"PNGDATA");
        // create row + restored edit row = 2.
        assert_eq!(history::list(&p).len(), 2);
    }

    #[tokio::test]
    async fn pdf_restore_writes_sidecar_back_not_binary() {
        // A pdf id's history versions its sidecar json (spec L90). Restore must
        // write the sidecar snapshot back to the sidecar path, leaving the
        // immutable binary untouched, and append an edit row.
        let d = TempDir::new().unwrap();
        let app = test_app();
        let pdf = abs(&d, "paper.pdf");
        std::fs::write(&pdf, b"%PDF binary").unwrap();
        let sidecar = crate::util::pdf_sidecar_for(&pdf);
        let rel = crate::util::pdf_sidecar_rel_key(&pdf);
        std::fs::create_dir_all(std::path::Path::new(&sidecar).parent().unwrap()).unwrap();
        // Current sidecar on disk (v2).
        std::fs::write(&sidecar, br#"{"metadata":{"id":"pdfrestore000000"},"highlights":[{"id":"v2"}]}"#).unwrap();
        app.resolver.index_path("pdfrestore000000", &pdf);
        // Record a v1 snapshot of the sidecar under the pdf's history dir.
        let v1 = br#"{"metadata":{"id":"pdfrestore000000"},"highlights":[{"id":"v1"}]}"#;
        let mut files = indexmap::IndexMap::new();
        files.insert(rel.clone(), crate::util::blake3_hex(v1));
        let ts = history::record(
            &pdf,
            Some(SaveType::Create),
            None,
            files,
            &[(crate::util::blake3_hex(v1), v1.to_vec())],
        )
        .unwrap();
        // The snapshot's main file is the sidecar key; preview is the sidecar.
        assert_eq!(history::manifest_at(&pdf, ts).unwrap().main_file(), rel);
        assert_eq!(history::preview_at(&pdf, ts).unwrap(), v1);
        // Restore the v1 sidecar.
        let r = restore(
            State(app.clone()),
            Query(RestoreQuery { id: "pdfrestore000000".into(), ts }),
        )
        .await
        .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let (side, _) = app.space().read_file(&sidecar).await.unwrap();
        assert_eq!(side, v1.to_vec(), "restore wrote the v1 sidecar back");
        assert_eq!(std::fs::read(&pdf).unwrap(), b"%PDF binary", "binary pdf untouched");
        assert_eq!(history::list(&pdf).len(), 2, "create + restored edit row");
    }

    #[tokio::test]
    async fn keep_clones_latest() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        let p = seed(&app, &d, "note.md", "keepid0000000000");
        history::record_single(&p, Some(SaveType::Create), "note.md", b"v1").unwrap();
        history::record_single(&p, Some(SaveType::Edit), "note.md", b"v2").unwrap();
        let r = keep(State(app), Query(KeepQuery { id: "keepid0000000000".into() }))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let rows = history::list(&p);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].save_type, SaveType::Keep);
        assert_eq!(history::preview_at(&p, rows[0].ts).unwrap(), b"v2");
    }

    #[tokio::test]
    async fn keep_with_no_rows_is_not_found() {
        let d = TempDir::new().unwrap();
        let app = test_app();
        seed(&app, &d, "ghost.md", "ghostid000000000");
        let err = keep(State(app), Query(KeepQuery { id: "ghostid000000000".into() }))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::NotFound));
    }
}
