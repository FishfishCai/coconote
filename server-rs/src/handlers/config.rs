// /.config — read + mutate coconote.yaml (setting.md §Local + §Remote +
// §Config file).
//
// GET  /.config  → { port, hasAuth, root: {name→path}, url: [...],
//                    snippets, configDir, readOnly }
// PATCH /.config → one of:
//                    { addRoot:    { name, path } }
//                    { removeRoot: "name" }
//                    { addUrl:     "url" }
//                    { removeUrl:  "url" }
//                    { snippets:   "<raw snippet.json>" }
//                    { configDir:  "<dir>" }   (redirects yaml + restarts)
//
// On any mutation the yaml is atomically rewritten (tmp + rename) and,
// when roots change, the LiveSpace inside AppState is swapped so the
// file index reloads without a process restart.

use crate::config::{effective_config_dir, write_config_pointer, FileConfig};
use crate::error::{Error, Result};
use crate::space::MultiRootSpacePrimitives;
use crate::state::{AppState, DynSpace, LiveSpace};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

// The token is never returned: a leaked token via XSS would compromise
// the vault. Settings UI only needs to know whether a non-default
// token is configured, hence `hasAuth`. `snippets` is the raw text of
// the on-disk snippet.json sidecar (editor.md §Snippet): same lookup
// path as coconote.yaml, JSON array of `{trigger, replacement, options}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    port: Option<u16>,
    has_auth: bool,
    root: IndexMap<String, String>,
    url: Vec<String>,
    snippets: String,
    /// Directory holding the yaml the server is currently using.
    /// setting.md §Config file. Shown pre-filled in Setting →
    /// Config file; PATCH `configDir` to change it.
    config_dir: String,
    /// Vault rejects writes (CLI --read-only). The client reads this to
    /// make the editor read-only up front instead of waiting for a 405.
    read_only: bool,
}

pub async fn get_config(State(app): State<AppState>) -> Response {
    let cfg = match load_current(&app) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("read config: {e}"))
                .into_response();
        }
    };
    let snippets = read_snippets_file(app.config_path.as_deref()).unwrap_or_default();
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
    /// Redirect yaml lookup to a new directory (setting.md §Config
    /// file). Server writes the pointer, returns 200, then re-execs.
    config_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct NewRoot {
    name: String,
    path: String,
}

pub async fn patch_config(
    State(app): State<AppState>,
    Json(patch): Json<PatchBody>,
) -> Response {
    // configDir changes the LOCATION of the yaml, not its content —
    // they don't compose with the other field-level patches, and a
    // self-restart follows. Handle it standalone and short-circuit.
    if let Some(dir) = patch.config_dir.as_deref() {
        // Prove the dir usable BEFORE persisting the pointer: a pointer
        // at an unwritable location would brick the next boot after
        // this handler has already returned 200. Empty value clears
        // the pointer (back to the standard dir) — nothing to probe.
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
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("write pointer: {e}"))
                .into_response();
        }
        let notify = app.restart_notify.clone();
        tokio::spawn(async move {
            // Brief grace so the 200 reaches the client before re-exec.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            notify.notify_waiters();
        });
        return StatusCode::OK.into_response();
    }
    match apply_patch(&app, patch).await {
        Ok(()) => get_config(State(app)).await,
        Err(Error::BadRequest(msg)) => (StatusCode::BAD_REQUEST, msg).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("patch config: {e}"))
            .into_response(),
    }
}

/// Create `dir` if missing and prove it writable (probe file write +
/// remove) so a `{configDir}` patch can't point boot at a dead end.
fn validate_config_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".coconote.probe.{}", std::process::id()));
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)
}

fn load_current(app: &AppState) -> Result<FileConfig> {
    match &app.config_path {
        Some(p) => Ok(FileConfig::load(p)?.unwrap_or_default()),
        None => Ok(FileConfig::default()),
    }
}

async fn apply_patch(app: &AppState, patch: PatchBody) -> Result<()> {
    let mut cfg = load_current(app)?;
    let mut roots_changed = false;

    if let Some(new) = patch.add_root {
        let name = new.name.trim().to_string();
        if name.is_empty() || name.contains('/') {
            return Err(Error::BadRequest("root name cannot be empty or contain '/'".into()));
        }
        if cfg.root.contains_key(&name) {
            return Err(Error::BadRequest(format!("root '{name}' already exists")));
        }
        let path_str = new.path.trim();
        if !path_str.starts_with('/') && !path_str.starts_with('~') {
            return Err(Error::BadRequest("root path must be absolute".into()));
        }
        cfg.root.insert(name, path_str.to_string());
        roots_changed = true;
    }
    if let Some(name) = patch.remove_root.as_deref() {
        if cfg.root.shift_remove(name).is_none() {
            return Err(Error::BadRequest(format!("root '{name}' not found")));
        }
        roots_changed = true;
    }
    if let Some(url) = patch.add_url {
        let u = url.trim().trim_end_matches('/').to_string();
        if u.is_empty() || !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err(Error::BadRequest("url must be http(s)://host[:port]".into()));
        }
        if !cfg.url.iter().any(|x| x == &u) {
            cfg.url.push(u);
        }
    }
    if let Some(url) = patch.remove_url.as_deref() {
        let trimmed = url.trim().trim_end_matches('/');
        let before = cfg.url.len();
        cfg.url.retain(|x| x != trimmed);
        if cfg.url.len() == before {
            return Err(Error::BadRequest(format!("url '{trimmed}' not found")));
        }
    }

    // Validate roots BEFORE writing yaml so a rebuild failure can't leave
    // disk inconsistent with the live space. Empty roots is fine — the
    // server happily boots with no roots (welcome.md §coconote.yaml), so
    // a user can remove every root and reconfigure from scratch via
    // Setting → Local. The resolved list feeds rebuild_live_space
    // directly — no second resolution pass.
    let resolved = if roots_changed {
        Some(
            cfg.root_configs()
                .map_err(|e| Error::BadRequest(e.to_string()))?,
        )
    } else {
        None
    };

    write_yaml_atomically(app.config_path.as_deref(), &cfg)?;

    if let Some(snippets) = patch.snippets {
        write_snippets_file(app.config_path.as_deref(), &snippets)?;
    }

    if let Some(resolved) = resolved {
        rebuild_live_space(app, resolved)?;
    }
    Ok(())
}

/// Read the snippet.json sidecar (editor.md §Snippet — same lookup
/// path as coconote.yaml). Missing file → empty string.
fn read_snippets_file(yaml_path: Option<&Path>) -> Result<String> {
    let p = snippets_path_for(yaml_path);
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(Error::Io(e)),
    }
}

/// Atomically replace the snippet.json sidecar; empty string removes
/// the file.
fn write_snippets_file(yaml_path: Option<&Path>, content: &str) -> Result<()> {
    let p = snippets_path_for(yaml_path);
    if content.is_empty() {
        if p.exists() {
            std::fs::remove_file(&p)?;
        }
        return Ok(());
    }
    write_atomically(&p, content.as_bytes())
}

/// snippet.json lives next to coconote.yaml. When no yaml is on disk
/// the snippet file lives in CWD too — matches the yaml fallback.
fn snippets_path_for(yaml_path: Option<&Path>) -> PathBuf {
    match yaml_path {
        Some(p) => p.with_file_name("snippet.json"),
        None => PathBuf::from("snippet.json"),
    }
}

/// Swap the live space to `resolved` (already validated by the caller —
/// root_configs() is not re-run here).
fn rebuild_live_space(app: &AppState, resolved: Vec<crate::space::RootConfig>) -> Result<()> {
    let pretty: IndexMap<String, String> = resolved
        .iter()
        .map(|r| (r.name.clone(), r.path.to_string_lossy().into_owned()))
        .collect();
    // Empty roots is valid (mirrors bin/coconote.rs's boot behavior).
    let base: DynSpace = Arc::new(
        MultiRootSpacePrimitives::new(resolved.clone())
            .map_err(|e| Error::Other(format!("multiroot: {e}")))?,
    );
    // Wrap in read-only if the server started that way.
    let space: DynSpace = if app.read_only {
        Arc::new(crate::space::ReadOnlySpacePrimitives::new(base))
    } else {
        base
    };
    // Orphan sweep on every (possibly-new) root, just like boot does.
    for r in &resolved {
        let (j, a) = crate::orphan::sweep_root(&r.path);
        if j + a > 0 {
            tracing::info!(
                "orphan sweep at {}: {j} sidecar, {a} assets removed (live reload)",
                r.path.display()
            );
        }
    }
    app.live.store(Arc::new(LiveSpace { roots: pretty, space }));
    Ok(())
}

fn write_yaml_atomically(target: Option<&Path>, cfg: &FileConfig) -> Result<()> {
    // `None` means the server booted without a yaml (--folder mode,
    // which bypasses config resolution entirely). Persisting to a
    // ./coconote.yaml that no later boot would read just litters the
    // CWD — mutations stay in-process only.
    let Some(path) = target else {
        return Ok(());
    };
    let body = serialize_config(cfg)?;
    write_atomically(path, body.as_bytes())
}

/// tmp + rename in the destination dir so readers never observe a torn
/// file. pid + 64-bit random suffix so two simultaneous PATCH requests
/// in the same process don't truncate each other's tmp file.
fn write_atomically(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{:x}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("coconote"),
        std::process::id(),
        rand::random::<u64>(),
    ));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// Round-trip through serde_yaml so scalars with `:`, `#`, leading
// `*&@`, or whitespace are quoted. Hand-rolled string emit lost those.
fn serialize_config(cfg: &FileConfig) -> Result<String> {
    #[derive(Serialize)]
    struct Wire<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth: Option<&'a str>,
        #[serde(skip_serializing_if = "IndexMap::is_empty")]
        root: &'a IndexMap<String, String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        url: &'a Vec<String>,
    }
    let wire = Wire {
        port: cfg.port,
        auth: cfg.auth.as_deref().filter(|s| !s.is_empty()),
        root: &cfg.root,
        url: &cfg.url,
    };
    serde_yaml::to_string(&wire)
        .map_err(|e| Error::Other(format!("yaml emit: {e}")))
}
