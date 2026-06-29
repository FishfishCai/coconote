use super::headers::{
    perm_str, set_meta_headers, X_CONTENT_HASH, X_ID, X_IF_UNMODIFIED_SINCE, X_PERMISSION,
};
use super::*;
use crate::error::{Error, Result};
use crate::history::SaveType;
use crate::resolver::Resolver;
use crate::state::{AppState, Boundary};
use crate::types::{Entry, Perm};
use crate::util::is_valid_id;
use arc_swap::ArcSwap;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use std::sync::Arc;
use tempfile::TempDir;

#[test]
fn perm_str_maps_both_variants() {
    assert_eq!(perm_str(Perm::Ro), "ro");
    assert_eq!(perm_str(Perm::Rw), "rw");
}

#[test]
fn meta_headers_emit_content_hash_only_when_present() {
    let mut full = Entry::default();
    full.content_hash = "abc123".into();
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, &full);
    assert_eq!(h.get(&X_CONTENT_HASH).unwrap(), "abc123");
    let meta_only = Entry::default();
    let mut h2 = HeaderMap::new();
    set_meta_headers(&mut h2, &meta_only);
    assert!(h2.get(&X_CONTENT_HASH).is_none());
}

#[test]
fn save_type_query_parsing() {
    assert_eq!(SaveType::from_put_query("edit"), Some(SaveType::Edit));
    assert_eq!(SaveType::from_put_query("push"), Some(SaveType::Push));
    assert_eq!(SaveType::from_put_query("pull"), Some(SaveType::Pull));
    assert_eq!(SaveType::from_put_query("create"), None);
    assert_eq!(SaveType::from_put_query("keep"), None);
    assert_eq!(SaveType::from_put_query("garbage"), None);
}

#[test]
fn sanitize_asset_rejects_paths() {
    assert!(sanitize_asset("img.png").is_ok());
    assert!(sanitize_asset("a/b.png").is_err());
    assert!(sanitize_asset("../escape").is_err());
    assert!(sanitize_asset("").is_err());
}

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

fn into_resp(r: Result<Response>) -> Response {
    r.unwrap_or_else(|e| e.into_response())
}

async fn body_bytes(r: Response) -> Vec<u8> {
    axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()
}

fn x_id(r: &Response) -> Option<String> {
    r.headers().get(&X_ID).and_then(|v| v.to_str().ok()).map(str::to_string)
}

fn abs(d: &TempDir, name: &str) -> String {
    d.path().join(name).to_string_lossy().into_owned()
}

/// Loopback path PUT (create) returning the response.
async fn put_path(app: &AppState, path: &str, body: &'static [u8]) -> Response {
    into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery { path: Some(path.into()), ..Default::default() }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(body),
        )
        .await,
    )
}

#[tokio::test]
async fn loopback_path_put_creates_file_and_mints_id() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let r = put_path(&app, &p, b"hello").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers().get(&X_PERMISSION).unwrap(), "rw");
    let id = x_id(&r).expect("PUT returns X-Id");
    assert!(is_valid_id(&id), "minted a valid id: {id}");
    // The id resolves back to the same path (indexed on write).
    assert_eq!(app.resolver.resolve(&id).as_deref(), Some(p.as_str()));
}

#[tokio::test]
async fn get_by_id_after_create_returns_body_and_id() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let id = x_id(&put_path(&app, &p, b"hello body").await).unwrap();

    let r = into_resp(
        get_or_head(
            State(app.clone()),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery { id: Some(id.clone()), ..Default::default() }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(x_id(&r).as_deref(), Some(id.as_str()));
    assert!(r.headers().get(&X_CONTENT_HASH).is_some());
    let body = body_bytes(r).await;
    let s = String::from_utf8(body).unwrap();
    assert!(s.contains("hello body"), "body served: {s:?}");
    assert!(s.contains(&format!("id: {id}")), "stamped frontmatter id: {s:?}");
}

#[tokio::test]
async fn id_is_stable_across_writes() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let id1 = x_id(&put_path(&app, &p, b"v1").await).unwrap();
    let id2 = x_id(&put_path(&app, &p, b"v2").await).unwrap();
    assert_eq!(id1, id2, "id persists across writes");
}

#[tokio::test]
async fn get_unknown_id_is_not_found() {
    let app = test_app();
    let r = into_resp(
        get_or_head(
            State(app),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery { id: Some("abcd1234efgh5678".into()), ..Default::default() }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn malformed_id_is_bad_request() {
    let app = test_app();
    let r = into_resp(
        get_or_head(
            State(app),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery { id: Some("NOPE".into()), ..Default::default() }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn remote_put_by_id_cannot_change_frontmatter() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    // Seed with real frontmatter (loopback write), then index the id.
    app.space()
        .write_file(&p, b"---\nid: realreal00000000\ntitle: real\nrefs: [a1]\n---\nbody\n", None)
        .await
        .unwrap();
    app.resolver.index_path("realreal00000000", &p);
    // Remote write by id tries to rewrite the frontmatter.
    into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(false)),
            Query(FileQuery { id: Some("realreal00000000".into()), ..Default::default() }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(
                b"---\nid: hackhack00000000\ntitle: HACK\nrefs: [evil]\n---\nnew body\n",
            ),
        )
        .await,
    );
    let (data, _) = app.space().read_file(&p).await.unwrap();
    let fm = crate::frontmatter::scan_frontmatter(&data);
    assert_eq!(fm.title, "real", "remote cannot change title");
    assert_eq!(fm.id, "realreal00000000", "remote cannot change id");
    assert_eq!(fm.refs, vec!["a1"], "remote cannot change refs");
    let s = String::from_utf8(data).unwrap();
    assert!(s.ends_with("new body\n"), "body accepted: {s:?}");
}

#[tokio::test]
async fn remote_put_by_path_is_rejected() {
    // A remote caller may not address by path (loopback-only). resolve_target
    // returns BadRequest when no id is given and the request is not loopback.
    let d = TempDir::new().unwrap();
    let app = test_app();
    let r = into_resp(
        put(
            State(app),
            Extension(Loopback(false)),
            Query(FileQuery { path: Some(abs(&d, "x.md")), ..Default::default() }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(b"x"),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn put_traversal_is_bad_request() {
    let app = test_app();
    let r = into_resp(
        put(
            State(app),
            Extension(Loopback(true)),
            Query(FileQuery { path: Some("/tmp/../escape.md".into()), ..Default::default() }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(b"x"),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn put_stale_write_conflicts_409() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.txt");
    let e = app.space().write_file(&p, b"server-newer", None).await.unwrap();
    let mut h = HeaderMap::new();
    h.insert(X_IF_UNMODIFIED_SINCE, HeaderValue::from_str(&(e.mtime - 1).to_string()).unwrap());
    let r = into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery { path: Some(p.clone()), ..Default::default() }),
            h,
            axum::body::Bytes::from_static(b"client-stale"),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let (data, _) = app.space().read_file(&p).await.unwrap();
    assert_eq!(data, b"server-newer");
}

#[tokio::test]
async fn delete_by_id_removes_file_and_forgets_id() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let id = x_id(&put_path(&app, &p, b"x").await).unwrap();
    let r = into_resp(
        delete(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery { id: Some(id.clone()), ..Default::default() }),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::OK);
    assert!(matches!(app.space().read_file(&p).await.unwrap_err(), Error::NotFound));
    assert!(app.resolver.resolve(&id).is_none(), "id forgotten after delete");
}

#[tokio::test]
async fn asset_put_then_get_by_owner_id() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let id = x_id(&put_path(&app, &p, b"body").await).unwrap();
    // PUT an image under the owner's assets dir.
    let put_r = into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery {
                id: Some(id.clone()),
                asset: Some("pic.png".into()),
                ..Default::default()
            }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(b"PNGDATA"),
        )
        .await,
    );
    assert_eq!(put_r.status(), StatusCode::OK);
    assert_eq!(x_id(&put_r).as_deref(), Some(id.as_str()), "asset write echoes owner id");
    // It landed in the companion dir.
    assert!(d.path().join(".note.assets/pic.png").exists());
    // GET it back by (owner id, asset).
    let get_r = into_resp(
        get_or_head(
            State(app),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery { id: Some(id), asset: Some("pic.png".into()), ..Default::default() }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(get_r.status(), StatusCode::OK);
    assert_eq!(body_bytes(get_r).await, b"PNGDATA");
}

// --- PDF as a sidecar document (collab/history target = the sidecar json) ---

/// Create a pdf + its sidecar json and index the pdf id so handlers resolve it.
async fn seed_pdf(app: &AppState, d: &TempDir, stem: &str, id: &str) -> (String, String) {
    let pdf = abs(d, &format!("{stem}.pdf"));
    app.space().write_file(&pdf, b"%PDF-1.4 binary\xff\xfe", None).await.unwrap();
    let sidecar = crate::util::pdf_sidecar_for(&pdf);
    let body = format!(r#"{{"metadata":{{"id":"{id}","title":"{stem}","tags":[],"backrefs":[]}},"highlights":[]}}"#);
    app.space().write_file(&sidecar, body.as_bytes(), None).await.unwrap();
    app.resolver.index_path(id, &pdf);
    (pdf, sidecar)
}

async fn wait_history(pdf: &str, want: usize) -> Vec<crate::history::VersionMeta> {
    // record_history runs fire-and-forget on a blocking thread; poll briefly.
    for _ in 0..100 {
        let rows = crate::history::list(pdf);
        if rows.len() >= want {
            return rows;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    crate::history::list(pdf)
}

#[tokio::test]
async fn pdf_sidecar_put_records_history_in_pdf_history_dir() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let (pdf, _sidecar) = seed_pdf(&app, &d, "paper", "paperid000000000").await;
    let put_sidecar = |bytes: &'static [u8]| {
        let app = app.clone();
        async move {
            into_resp(
                put(
                    State(app),
                    Extension(Loopback(true)),
                    Query(FileQuery {
                        id: Some("paperid000000000".into()),
                        asset: Some("paper.json".into()),
                        ..Default::default()
                    }),
                    HeaderMap::new(),
                    axum::body::Bytes::from_static(bytes),
                )
                .await,
            )
        }
    };
    // First sidecar write -> create row; second -> edit row.
    assert_eq!(put_sidecar(br#"{"metadata":{"id":"paperid000000000"},"highlights":[{"id":"h1"}]}"#).await.status(), StatusCode::OK);
    let rows = wait_history(&pdf, 1).await;
    assert_eq!(rows.len(), 1, "first sidecar PUT records a row");
    assert_eq!(rows[0].save_type, crate::history::SaveType::Create, "first row is create");
    assert_eq!(put_sidecar(br#"{"metadata":{"id":"paperid000000000"},"highlights":[{"id":"h1"},{"id":"h2"}]}"#).await.status(), StatusCode::OK);
    let rows = wait_history(&pdf, 2).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].save_type, crate::history::SaveType::Edit);
    // The history lives in the pdf's own `.paper.assets/.history/` (spec L90).
    assert!(d.path().join(".paper.assets/.history/versions.json").exists(), "history under the pdf's assets dir");
    // The newest snapshot's main file is the sidecar (keyed relative to the
    // pdf dir), and previewing it returns the sidecar bytes, not the binary.
    let preview = crate::history::preview_at(&pdf, rows[0].ts).unwrap();
    let s = String::from_utf8(preview).unwrap();
    assert!(s.contains("\"h2\""), "preview is the sidecar json: {s}");
}

#[tokio::test]
async fn remote_sidecar_put_cannot_change_identity() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let (_pdf, sidecar) = seed_pdf(&app, &d, "paper", "realpdf000000000").await;
    // Overwrite the seeded sidecar with identity worth protecting.
    app.space()
        .write_file(
            &sidecar,
            br#"{"metadata":{"id":"realpdf000000000","title":"Real","tags":["t"],"backrefs":["b1"]},"highlights":[]}"#,
            None,
        )
        .await
        .unwrap();
    // A REMOTE write tries to hijack identity while adding a highlight.
    into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(false)),
            Query(FileQuery {
                id: Some("realpdf000000000".into()),
                asset: Some("paper.json".into()),
                ..Default::default()
            }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(
                br#"{"metadata":{"id":"hackhack00000000","title":"HACK","tags":["evil"],"backrefs":["evil"]},"highlights":[{"id":"h1"}]}"#,
            ),
        )
        .await,
    );
    let (data, _) = app.space().read_file(&sidecar).await.unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&data).unwrap();
    assert_eq!(doc["metadata"]["id"], "realpdf000000000", "remote cannot change sidecar id");
    assert_eq!(doc["metadata"]["title"], "Real", "remote cannot change title");
    assert_eq!(doc["metadata"]["tags"][0], "t", "remote cannot change tags");
    assert_eq!(doc["metadata"]["backrefs"][0], "b1", "remote cannot change backrefs");
    assert_eq!(doc["highlights"][0]["id"], "h1", "remote annotation accepted");
}

#[tokio::test]
async fn loopback_sidecar_put_is_unrestricted() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let (_pdf, sidecar) = seed_pdf(&app, &d, "paper", "localpdf00000000").await;
    // A LOOPBACK write may change anything, including identity (the desktop
    // metadata panel writes the full sidecar).
    into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery {
                id: Some("localpdf00000000".into()),
                asset: Some("paper.json".into()),
                ..Default::default()
            }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(
                br#"{"metadata":{"id":"localpdf00000000","title":"Renamed"},"highlights":[]}"#,
            ),
        )
        .await,
    );
    let (data, _) = app.space().read_file(&sidecar).await.unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&data).unwrap();
    assert_eq!(doc["metadata"]["title"], "Renamed", "loopback may rename");
}

#[tokio::test]
async fn per_file_readonly_get_reports_ro_and_put_405() {
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "locked.md");
    let id = x_id(&put_path(&app, &p, b"body").await).unwrap();
    // Flip the on-disk read-only bit (an rw server, per-file ro).
    let mut perms = std::fs::metadata(&p).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&p, perms).unwrap();
    // GET reports X-Permission: ro.
    let get_r = into_resp(
        get_or_head(
            State(app.clone()),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery { id: Some(id.clone()), ..Default::default() }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(get_r.headers().get(&X_PERMISSION).unwrap(), "ro", "on-disk ro file reports ro");
    // A write to it returns 405 even though the server is rw.
    let put_r = into_resp(
        put(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(FileQuery { id: Some(id.clone()), ..Default::default() }),
            HeaderMap::new(),
            axum::body::Bytes::from_static(b"new body"),
        )
        .await,
    );
    assert_eq!(put_r.status(), StatusCode::METHOD_NOT_ALLOWED, "write to ro file -> 405");
    // Restore writability so TempDir cleanup works.
    let mut perms = std::fs::metadata(&p).unwrap().permissions();
    perms.set_readonly(false);
    std::fs::set_permissions(&p, perms).unwrap();
}

#[tokio::test]
async fn sidecar_sentinel_resolves_to_pdf_sidecar_by_id() {
    // A bare-id pdf open has no path. The client reads/writes the annotation
    // sidecar with the @sidecar sentinel, which the server resolves to the
    // pdf's real <stem>.json from the id alone (the same file the explicit
    // name addresses).
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "doc.pdf");
    let id = x_id(&put_path(&app, &p, b"%PDF-1.4 fake").await).unwrap();

    let get = |asset: &str| {
        get_or_head(
            State(app.clone()),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery {
                id: Some(id.clone()),
                asset: Some(asset.to_string()),
                ..Default::default()
            }),
            HeaderMap::new(),
        )
    };
    let via_sentinel = into_resp(get("@sidecar").await);
    let via_name = into_resp(get("doc.json").await);
    assert_eq!(via_sentinel.status(), StatusCode::OK);
    assert_eq!(via_name.status(), StatusCode::OK);
    assert_eq!(body_bytes(via_sentinel).await, body_bytes(via_name).await);
}

#[tokio::test]
async fn sidecar_sentinel_rejected_for_non_pdf() {
    // @sidecar only means anything for a pdf. A non-pdf owner must be a 400,
    // not a silent read/write of a literal "@sidecar" file in its assets dir.
    let d = TempDir::new().unwrap();
    let app = test_app();
    let p = abs(&d, "note.md");
    let id = x_id(&put_path(&app, &p, b"hello").await).unwrap();

    let r = into_resp(
        get_or_head(
            State(app.clone()),
            Extension(Loopback(true)),
            Method::GET,
            Query(FileQuery {
                id: Some(id),
                asset: Some("@sidecar".into()),
                ..Default::default()
            }),
            HeaderMap::new(),
        )
        .await,
    );
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}
