// Apply a PATCH /.config field mutation (setting.md Local/Remote/Snippet):
// add/remove a root or url, replace the snippet sidecar, then persist the
// yaml and hot-swap the live space when roots changed.

use super::persist::{write_snippets_file, write_yaml_atomically};
use super::{load_current, PatchBody};
use crate::error::{Error, Result};
use crate::space::{MultiRootSpacePrimitives, RootConfig};
use crate::state::{AppState, DynSpace, LiveSpace};
use indexmap::IndexMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(super) async fn apply_patch(app: &AppState, patch: PatchBody) -> Result<()> {
    let mut cfg = load_current(app)?;
    let mut roots_changed = false;

    if let Some(new) = patch.add_root {
        let name = new.name.trim().to_string();
        if name.is_empty() || name.contains('/') {
            return Err(Error::BadRequest(
                "root name cannot be empty or contain '/'".into(),
            ));
        }
        if cfg.root.contains_key(&name) {
            return Err(Error::BadRequest(format!("root '{name}' already exists")));
        }
        cfg.root.insert(name, new.path.trim().to_string());
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
    // disk inconsistent with the live space. Empty roots is fine: the
    // server boots with no roots (welcome.md coconote.yaml), so a user
    // can remove every root and reconfigure via Setting -> Local. The
    // resolved list feeds rebuild_live_space directly, no second
    // resolution pass.
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

/// Swap the live space to `resolved` (already validated by the caller,
/// root_configs() is not re-run here).
fn rebuild_live_space(app: &AppState, resolved: Vec<RootConfig>) -> Result<()> {
    let pretty: IndexMap<String, String> = resolved
        .iter()
        .map(|r| (r.name.clone(), r.path.to_string_lossy().into_owned()))
        .collect();
    // Empty roots is valid (mirrors bin/coconote.rs's boot behavior).
    let base: DynSpace = Arc::new(
        MultiRootSpacePrimitives::new(resolved.clone())
            .map_err(|e| Error::Other(format!("multiroot: {e}")))?,
    );
    let space: DynSpace = if app.read_only {
        Arc::new(crate::space::ReadOnlySpacePrimitives::new(base))
    } else {
        base
    };
    // Orphan sweep only on roots NEW to this swap: surviving roots were
    // already swept at boot or when they were added, and the sweep is a
    // full recursive walk that takes seconds on large or iCloud-backed
    // folders. It is pure cleanup of dot-hidden sidecars, so it runs on
    // a blocking thread after the swap instead of stalling the PATCH
    // response (a remove sweeps nothing and returns immediately).
    let prev = app.live.load();
    let added: Vec<PathBuf> = resolved
        .iter()
        .filter(|r| !prev.roots.values().any(|p| Path::new(p) == r.path))
        .map(|r| r.path.clone())
        .collect();
    app.live.store(Arc::new(LiveSpace { roots: pretty, space }));
    for path in added {
        tokio::task::spawn_blocking(move || {
            let (j, a) = crate::orphan::sweep_root(&path);
            if j + a > 0 {
                tracing::info!(
                    "orphan sweep at {}: {j} sidecar, {a} assets removed (live reload)",
                    path.display()
                );
            }
        });
    }
    Ok(())
}
