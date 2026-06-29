// /.file CRUD (design.md "server API"): GET/PUT/DELETE addressed by `?id=`.
// The server resolves the id to a path, then reads/writes it. GET returns the
// body + X-Permission / X-Last-Modified / X-Content-Hash + X-Id (HEAD has no
// body and no X-Content-Hash). PUT takes ?save_type=edit|push|pull (default
// edit) and an optional ?peer=<url> on push/pull, body cap 64 MB.
// If-Modified-Since -> 304, X-If-Unmodified-Since mismatch -> 409. A remote
// PUT keeps the on-disk frontmatter and accepts only the body. Every PUT
// records an in-place history row.
//
// Two loopback-only conveniences keep the desktop app usable while remote
// stays strictly id-addressed:
//   - `?path=<abs>` addresses a file directly (open an arbitrary local file or
//     create a new one). The server mints/persists the file's id and returns
//     it in X-Id. Remote `?path=` is rejected by the auth boundary.
//   - `?asset=<name>` reads/writes an image inside the addressed file's
//     `.<name>.assets/` companion dir (id of the owning md/pdf gates remote
//     access; the asset is a flat filename, never a path).
//
// This file owns target resolution + the shared request types; GET/HEAD read
// is in `read.rs`, PUT/DELETE + history recording in `write.rs`, the `?asset=`
// path in `asset.rs`, the X-* header building in `headers.rs`.

mod asset;
mod headers;
mod read;
mod write;
#[cfg(test)]
mod tests;

pub use read::get_or_head;
pub use write::{delete, put};
pub(crate) use write::record_history;

use asset::sanitize_asset;
use crate::error::{Error, Result};
use crate::meta;
use crate::state::AppState;
use crate::util::{assets_prefix_for, is_valid_id, pdf_sidecar_asset};
use serde::Deserialize;

/// `?asset=` sentinel meaning "this pdf's annotation sidecar". Resolved to the
/// real `<stem>.json` once the owner path is known, so the client can address
/// the sidecar by the pdf's id alone (a bare-id open has no path). Mirrored by
/// SIDECAR_ASSET in client pdf/sidecar/session.ts.
const SIDECAR_SENTINEL: &str = "@sidecar";

/// Request-scoped marker set by the boundary middleware: true when the
/// request came from loopback (127.0.0.1). Remote requests get
/// frontmatter-read-only treatment on PUT and may not use `?path=`.
#[derive(Clone, Copy)]
pub struct Loopback(pub bool);

/// Shared query for GET / HEAD / PUT / DELETE on /.file. `id` is canonical;
/// `path` is the loopback-only direct address; `asset` selects a companion
/// image; `save_type` / `peer` apply to PUT only.
#[derive(Deserialize, Default)]
pub struct FileQuery {
    pub id: Option<String>,
    pub path: Option<String>,
    pub asset: Option<String>,
    pub save_type: Option<String>,
    pub peer: Option<String>,
}

/// A resolved /.file target: the owning markdown/pdf path, the id it was
/// addressed by (None when path-addressed), and an optional companion asset.
struct Target {
    owner_path: String,
    resolved_id: Option<String>,
    asset: Option<String>,
}

impl Target {
    /// The actual file to read/write: the asset inside the owner's companion
    /// dir, or the owner itself.
    fn file_path(&self) -> String {
        match &self.asset {
            Some(a) => format!("{}{}", assets_prefix_for(&self.owner_path), a),
            None => self.owner_path.clone(),
        }
    }
    fn is_asset(&self) -> bool {
        self.asset.is_some()
    }
}

/// Turn the query into a concrete target. `allow_create` (PUT) lets a
/// loopback caller bind a not-yet-known id to a supplied path.
fn resolve_target(
    app: &AppState,
    q: &FileQuery,
    loopback: bool,
    allow_create: bool,
) -> Result<Target> {
    let asset = match q.asset.as_deref() {
        Some(a) => Some(sanitize_asset(a)?),
        None => None,
    };
    let id = q.id.as_deref().filter(|s| !s.is_empty());
    let path = q.path.as_deref().filter(|s| !s.is_empty());

    let (owner_path, resolved_id) = if let Some(id) = id {
        if !is_valid_id(id) {
            return Err(Error::BadRequest("malformed id".into()));
        }
        match app.resolver.resolve(id) {
            Some(p) => (p, Some(id.to_string())),
            None => match (loopback && allow_create, path) {
                (true, Some(p)) => (p.to_string(), Some(id.to_string())),
                _ => return Err(Error::NotFound),
            },
        }
    } else if loopback {
        match path {
            Some(p) => (p.to_string(), None),
            None => return Err(Error::BadRequest("id required".into())),
        }
    } else {
        return Err(Error::BadRequest("id required".into()));
    };
    // Resolve the @sidecar sentinel to the pdf's real `<stem>.json` now that
    // the owner path is known (everything downstream - read, write, history -
    // then treats it as the normal sidecar asset). Only pdfs have a sidecar:
    // reject the sentinel elsewhere rather than letting it fall through as a
    // literal asset filename "@sidecar".
    let asset = match asset {
        Some(a) if a == SIDECAR_SENTINEL => {
            if !meta::is_pdf(&owner_path) {
                return Err(Error::BadRequest("@sidecar is only valid for a pdf".into()));
            }
            Some(pdf_sidecar_asset(&owner_path))
        }
        other => other,
    };
    Ok(Target { owner_path, resolved_id, asset })
}

/// The owner file's id for the X-Id header: the id it was addressed by, else
/// the file's stamped id (minted + persisted + indexed on first sight). None
/// for a non-addressable file (e.g. a raw .txt opened by loopback path).
fn owner_id(app: &AppState, target: &Target) -> Option<String> {
    if let Some(id) = &target.resolved_id {
        return Some(id.clone());
    }
    if !meta::is_addressable(&target.owner_path) {
        return None;
    }
    match meta::ensure_id(&target.owner_path, None) {
        Ok(id) => {
            app.resolver.index_path(&id, &target.owner_path);
            Some(id)
        }
        Err(_) => None,
    }
}
