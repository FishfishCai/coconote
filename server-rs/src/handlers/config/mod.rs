// /.config: read + mutate coconote.yaml (setting.md Local/Remote/Config file).
// GET -> {port, hasAuth, root, url, snippets, configDir, readOnly}. PATCH ->
// one of addRoot/removeRoot/addUrl/removeUrl/snippets/configDir (the last
// redirects the yaml + restarts).
//
// This module is the HTTP surface (wire types + handlers). The patch state
// machine and live-space swap live in apply; atomic yaml/snippet writes and
// yaml serialization in persist.

mod apply;
mod persist;

use crate::config::{effective_config_dir, write_config_pointer, FileConfig};
use crate::error::{Error, Result};
use crate::state::AppState;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::Path;

// The token is never returned: a leak via XSS would compromise the vault,
// the Settings UI only needs `hasAuth`. `snippets` is the raw text of the
// on-disk snippet.json sidecar (editor.md Snippet): same lookup path as
// coconote.yaml, JSON array of `{trigger, replacement, options}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    port: Option<u16>,
    has_auth: bool,
    root: IndexMap<String, String>,
    url: Vec<String>,
    snippets: String,
    /// Directory holding the yaml currently in use (setting.md Config
    /// file). Shown pre-filled in Setting -> Config file, PATCH
    /// `configDir` to change it.
    config_dir: String,
    /// Vault rejects writes (CLI --read-only). The client uses this to
    /// make the editor read-only up front instead of waiting for a 405.
    read_only: bool,
}

pub async fn get_config(State(app): State<AppState>) -> Response {
    let cfg = match load_current(&app) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("read config: {e}")).into_response();
        }
    };
    let snippets = persist::read_snippets_file(app.config_path.as_deref()).unwrap_or_default();
    let config_dir = effective_config_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let body = ConfigBody {
        port: cfg.port,
        has_auth: cfg.auth.as_deref().is_some_and(|s| !s.is_empty()),
        root: cfg.root.clone(),
        url: cfg.url.clone(),
        snippets,
        config_dir,
        read_only: app.read_only,
    };
    Json(body).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBody {
    add_root: Option<NewRoot>,
    remove_root: Option<String>,
    add_url: Option<String>,
    remove_url: Option<String>,
    /// Replace the snippet.json sidecar with this raw JSON string.
    /// Empty string removes the file.
    snippets: Option<String>,
    /// Redirect yaml lookup to a new directory (setting.md Config file).
    /// Server writes the pointer, returns 200, then re-execs.
    config_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct NewRoot {
    name: String,
    path: String,
}

pub async fn patch_config(State(app): State<AppState>, Json(patch): Json<PatchBody>) -> Response {
    // configDir changes the LOCATION of the yaml, not its content: it
    // doesn't compose with the field-level patches and a self-restart
    // follows. Handle it standalone and short-circuit.
    if let Some(dir) = patch.config_dir.as_deref() {
        return redirect_config_dir(&app, dir);
    }
    match apply::apply_patch(&app, patch).await {
        Ok(()) => get_config(State(app)).await,
        Err(Error::BadRequest(msg)) => (StatusCode::BAD_REQUEST, msg).into_response(),
        Err(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("patch config: {e}")).into_response()
        }
    }
}

/// Repoint the yaml directory and schedule a self-restart so the next boot
/// reads from there (setting.md Config file). The dir is proven usable
/// BEFORE the pointer is persisted: a pointer at an unwritable location
/// would brick the next boot after this handler already returned 200. An
/// empty value clears the pointer (back to the standard dir).
fn redirect_config_dir(app: &AppState, dir: &str) -> Response {
    let trimmed = dir.trim();
    if !trimmed.is_empty() {
        if let Err(e) = validate_config_dir(Path::new(trimmed)) {
            return (
                StatusCode::BAD_REQUEST,
                format!("config dir {trimmed:?} is not usable: {e}"),
            )
                .into_response();
        }
    }
    if let Err(e) = write_config_pointer(dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("write pointer: {e}")).into_response();
    }
    let notify = app.restart_notify.clone();
    tokio::spawn(async move {
        // Brief grace so the 200 reaches the client before re-exec.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        notify.notify_waiters();
    });
    StatusCode::OK.into_response()
}

/// Create `dir` if missing and prove it writable (probe file write +
/// remove) so a `{configDir}` patch can't point boot at a dead end.
fn validate_config_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".coconote.probe.{}", std::process::id()));
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)
}

pub(super) fn load_current(app: &AppState) -> Result<FileConfig> {
    match &app.config_path {
        Some(p) => Ok(FileConfig::load(p)?.unwrap_or_default()),
        None => Ok(FileConfig::default()),
    }
}
