// GET /.resolve (design.md "server API"): turn a title into an id so callers
// can navigate by id. `?title=<title>` (or `?title=<tag>/<title>` to
// disambiguate by a frontmatter tag) returns either a single id or, when the
// title is shared by several known files, a candidate list. A remote caller
// only sees ids inside its refs-closure.
//
// A loopback-only `?path=<abs>` is the desktop's "open an arbitrary local
// file" entry point: it reads the file, mints + persists an id if it has none,
// indexes it, and returns the id. (Creating a brand-new file uses PUT
// /.file?path=.)

use crate::boundary;
use crate::error::{Error, Result};
use crate::handlers::fs::Loopback;
use crate::meta;
use crate::resolver::{Candidate, TitleResolution};
use crate::state::AppState;

use axum::extract::{Extension, Query, State};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize)]
pub struct ResolveQuery {
    title: Option<String>,
    /// Loopback-only path -> id.
    path: Option<String>,
}

/// Exactly one match.
#[derive(Serialize)]
struct SingleId {
    id: String,
}

/// Zero (missing) or many (ambiguous) matches.
#[derive(Serialize)]
struct CandidateList {
    candidates: Vec<Candidate>,
}

pub async fn resolve(
    State(app): State<AppState>,
    Extension(Loopback(loopback)): Extension<Loopback>,
    Query(q): Query<ResolveQuery>,
) -> Result<Response> {
    if let Some(title) = q.title.as_deref().filter(|s| !s.is_empty()) {
        // A remote caller is limited to titles inside its refs-closure so it
        // cannot enumerate files it could not open anyway.
        let allowed: Option<HashSet<String>> = if loopback {
            None
        } else {
            let b = app.boundary();
            Some(boundary::id_closure(&b.recent, &b.pin, &app.resolver))
        };
        return Ok(match app.resolver.resolve_title(title, allowed.as_ref()) {
            TitleResolution::Single(id) => Json(SingleId { id }).into_response(),
            TitleResolution::Candidates(candidates) => {
                Json(CandidateList { candidates }).into_response()
            }
        });
    }

    if loopback {
        if let Some(path) = q.path.as_deref().filter(|s| !s.is_empty()) {
            let id = meta::ensure_id(path, None)?;
            app.resolver.index_path(&id, path);
            return Ok(Json(SingleId { id }).into_response());
        }
    }
    Err(Error::BadRequest("title (or loopback path) required".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolver::Resolver;
    use crate::state::{AppState, Boundary};
    use arc_swap::ArcSwap;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn app_over(root: &std::path::Path) -> AppState {
        let resolver = Resolver::new(vec![root.to_string_lossy().into_owned()]);
        resolver.boot_scan(&[]);
        AppState {
            client_bundle: crate::space::ClientBundle::new(),
            boundary: Arc::new(ArcSwap::from_pointee(Boundary::default())),
            resolver: Arc::new(resolver),
            auth_token: String::new(),
            build_time: String::new(),
            started_at: String::new(),
            pid: 0,
            config_path: None,
            watcher: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn write_md(dir: &std::path::Path, name: &str, id: &str, title: &str, tags: &str) {
        let tags_line = if tags.is_empty() {
            String::new()
        } else {
            format!("tags: [{tags}]\n")
        };
        std::fs::write(
            dir.join(name),
            format!("---\nid: {id}\ntitle: {title}\n{tags_line}---\nbody\n"),
        )
        .unwrap();
    }

    async fn body_json(r: Response) -> serde_json::Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    async fn resolve_title(app: &AppState, title: &str, loopback: bool) -> serde_json::Value {
        let r = resolve(
            State(app.clone()),
            Extension(Loopback(loopback)),
            Query(ResolveQuery { title: Some(title.into()), path: None }),
        )
        .await
        .unwrap();
        body_json(r).await
    }

    #[tokio::test]
    async fn single_title_returns_id() {
        let d = TempDir::new().unwrap();
        write_md(d.path(), "u.md", "uniqueid00000000", "Unique", "");
        let app = app_over(d.path());
        let v = resolve_title(&app, "Unique", true).await;
        assert_eq!(v["id"], "uniqueid00000000");
        assert!(v.get("candidates").is_none());
    }

    #[tokio::test]
    async fn ambiguous_title_returns_candidates() {
        let d = TempDir::new().unwrap();
        write_md(d.path(), "a.md", "dupida0000000000", "Dup", "note");
        write_md(d.path(), "b.md", "dupidb0000000000", "Dup", "paper");
        let app = app_over(d.path());
        let v = resolve_title(&app, "Dup", true).await;
        assert!(v.get("id").is_none(), "ambiguous has no single id");
        let cands = v["candidates"].as_array().unwrap();
        assert_eq!(cands.len(), 2);
        // tag/title disambiguates to one.
        let v = resolve_title(&app, "paper/Dup", true).await;
        assert_eq!(v["id"], "dupidb0000000000");
    }

    #[tokio::test]
    async fn missing_title_returns_empty_candidates() {
        let d = TempDir::new().unwrap();
        write_md(d.path(), "u.md", "uniqueid00000000", "Unique", "");
        let app = app_over(d.path());
        let v = resolve_title(&app, "Nope", true).await;
        assert!(v.get("id").is_none());
        assert_eq!(v["candidates"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn loopback_path_returns_id() {
        let d = TempDir::new().unwrap();
        let p = d.path().join("fresh.md").to_string_lossy().into_owned();
        std::fs::write(&p, b"---\ntitle: Fresh\n---\nbody").unwrap();
        let app = app_over(d.path());
        let r = resolve(
            State(app.clone()),
            Extension(Loopback(true)),
            Query(ResolveQuery { title: None, path: Some(p.clone()) }),
        )
        .await
        .unwrap();
        let v = body_json(r).await;
        let id = v["id"].as_str().unwrap();
        assert!(crate::util::is_valid_id(id));
        assert_eq!(app.resolver.resolve(id).as_deref(), Some(p.as_str()));
    }
}
