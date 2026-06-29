// /.config: read + mutate coconote.yaml (design.md config + recent/pin/url +
// watch). GET -> {port, hasAuth, url[(url,auth)], recent[(id,path)],
// recentLimit, pin[(id,path)], watch[], configDir}. PATCH -> add/remove a url,
// recent, pin, or watch root. The token itself is never returned, only
// `hasAuth`. The Settings server section shows port (read-only) and edits the
// watch roots (design.md L105). There is no whole-instance read-only mode, so
// no `readOnly` field: per-file read-only is reported per file via
// `X-Permission`.
//
// The config-dir switch (redirect + self-restart) and the snippet sidecar
// were removed: neither is in design.md (snippets live in browser
// localStorage). This module is the HTTP surface (wire types + handlers); the
// patch state machine lives in apply, atomic yaml writes in persist.

mod apply;
mod persist;

use crate::config::{standard_config_dir, FileConfig, FileRef, UrlEntry};
use crate::error::{Error, Result};
use crate::state::{AppState, Boundary};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// The token is never returned (a leak would compromise the server). The UI
// only needs `hasAuth`. Remote url `auth` tokens ARE returned: the client
// needs them to push/pull to those peers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    port: Option<u16>,
    has_auth: bool,
    url: Vec<UrlEntry>,
    recent: Vec<FileRef>,
    recent_limit: usize,
    pin: Vec<FileRef>,
    watch: Vec<String>,
    config_dir: String,
}

pub async fn get_config(State(app): State<AppState>) -> Response {
    let cfg = match load_current(&app) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("read config: {e}")).into_response();
        }
    };
    let config_dir = standard_config_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let body = ConfigBody {
        port: cfg.port,
        has_auth: cfg.auth.as_deref().is_some_and(|s| !s.is_empty()),
        url: cfg.url.clone(),
        recent: cfg.recent.clone(),
        recent_limit: cfg.recent_limit(),
        pin: cfg.pin.clone(),
        watch: cfg.watch.clone(),
        config_dir,
    };
    Json(body).into_response()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PatchBody {
    /// Add a remote instance: `{url, auth}`.
    add_url: Option<UrlEntry>,
    /// Remove a remote instance by url.
    remove_url: Option<String>,
    /// Push a file onto the recent list (MRU): `{id, path}`. Trimmed to
    /// recent_limit.
    add_recent: Option<FileRef>,
    /// Remove a recent entry by id.
    remove_recent: Option<String>,
    /// Pin a file: `{id, path}`.
    add_pin: Option<FileRef>,
    /// Remove a pin by id.
    remove_pin: Option<String>,
    /// Add a `watch` dir root (absolute path): persist it, index its files
    /// now, and start live-watching it (design.md L105).
    add_watch: Option<String>,
    /// Remove a `watch` dir root and stop watching it.
    remove_watch: Option<String>,
}

pub async fn patch_config(State(app): State<AppState>, Json(patch): Json<PatchBody>) -> Response {
    match apply::apply_patch(&app, patch).await {
        Ok(()) => get_config(State(app)).await,
        Err(Error::BadRequest(msg)) => (StatusCode::BAD_REQUEST, msg).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("patch config: {e}")).into_response(),
    }
}

pub(super) fn load_current(app: &AppState) -> Result<FileConfig> {
    match &app.config_path {
        Some(p) => Ok(FileConfig::load(p)?.unwrap_or_default()),
        None => Ok(FileConfig::default()),
    }
}

/// Publish the (recent, pin) id entry set to the live boundary so remote
/// reachability reflects the new config without a restart.
pub(super) fn refresh_boundary(app: &AppState, cfg: &FileConfig) {
    app.boundary.store(Arc::new(Boundary {
        recent: cfg.recent_ids(),
        pin: cfg.pin_ids(),
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolver::Resolver;
    use arc_swap::ArcSwap;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// AppState backed by a real coconote.yaml so PATCH can persist + reload.
    fn app_with_config(dir: &std::path::Path) -> AppState {
        let cfg_path = dir.join("coconote.yaml");
        std::fs::write(&cfg_path, "port: 40704\n").unwrap();
        AppState {
            client_bundle: crate::space::ClientBundle::new(),
            boundary: Arc::new(ArcSwap::from_pointee(Boundary::default())),
            resolver: Arc::new(Resolver::new(vec![])),
            auth_token: String::new(),
            build_time: String::new(),
            started_at: String::new(),
            pid: 0,
            config_path: Some(cfg_path),
            watcher: Arc::new(Mutex::new(None)),
        }
    }

    async fn body_json(r: Response) -> serde_json::Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    #[tokio::test]
    async fn get_config_omits_read_only_keeps_port_and_watch() {
        let d = TempDir::new().unwrap();
        let app = app_with_config(d.path());
        let v = body_json(get_config(State(app)).await).await;
        assert!(v.get("readOnly").is_none(), "global readOnly field is gone");
        assert_eq!(v["port"].as_u64(), Some(40704), "port still reported");
        assert!(v.get("watch").is_some(), "watch still reported");
    }

    #[tokio::test]
    async fn patch_add_and_remove_watch_root() {
        let d = TempDir::new().unwrap();
        let watched = TempDir::new().unwrap();
        // A markdown file in the dir to be watched: addWatch should index it.
        let note = watched.path().join("n.md");
        std::fs::write(&note, "---\nid: watchnote0000000\ntitle: N\n---\nbody\n").unwrap();
        let app = app_with_config(d.path());
        let dir = watched.path().to_string_lossy().into_owned();

        // addWatch -> persisted in returned config + file indexed/resolvable.
        let patch = PatchBody { add_watch: Some(dir.clone()), ..Default::default() };
        let v = body_json(patch_config(State(app.clone()), Json(patch)).await).await;
        let watch = v["watch"].as_array().unwrap();
        assert!(
            watch.iter().any(|w| w.as_str() == Some(dir.as_str())),
            "added watch root present in returned config"
        );
        // Compare canonical paths: addWatch's live watcher may asynchronously
        // re-index the file under a canonicalized path (the tempdir's /var is a
        // symlink to /private/var on macOS), so the synchronous scan path and a
        // watcher-event path differ only by symlink resolution. Canonicalizing
        // both sides makes the assertion deterministic regardless of that race.
        assert_eq!(
            app.resolver
                .resolve("watchnote0000000")
                .as_deref()
                .map(|p| std::fs::canonicalize(p).unwrap()),
            Some(std::fs::canonicalize(&note).unwrap()),
            "addWatch scanned + indexed the root's files immediately"
        );

        // removeWatch -> gone from config.
        let patch = PatchBody { remove_watch: Some(dir.clone()), ..Default::default() };
        let v = body_json(patch_config(State(app.clone()), Json(patch)).await).await;
        assert!(v["watch"].as_array().unwrap().is_empty(), "watch root removed");

        // The live notify watcher addWatch created joins its event-loop thread
        // on Drop, which can wedge on a Linux CI sandbox (inotify backend; the
        // local macOS FSEvents backend does not). This test asserts config
        // persistence + indexing, not OS watching, so take the watcher out and
        // leak it - the process exit reclaims it without a blocking join.
        std::mem::forget(app.watcher.lock().unwrap().take());
    }

    #[tokio::test]
    async fn patch_add_watch_rejects_relative_path() {
        let d = TempDir::new().unwrap();
        let app = app_with_config(d.path());
        let patch = PatchBody { add_watch: Some("relative/dir".into()), ..Default::default() };
        let r = patch_config(State(app), Json(patch)).await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }
}
