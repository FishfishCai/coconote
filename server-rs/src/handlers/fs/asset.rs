// The `?asset=<name>` sidecar / image path: an asset is a flat filename inside
// the owner's `.<name>.assets/` companion dir. Most assets are opaque md images
// (no history); the exception is a PDF's sidecar json, which IS the pdf's
// versioned content -- remote-write protected and versioned under the pdf.
use super::headers::{set_id_header, set_meta_headers};
use super::write::record_history;
use super::{owner_id, FileQuery, Target};
use crate::error::{Error, Result};
use crate::meta;
use crate::state::AppState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

/// Reject an asset name that is anything other than a single flat filename.
pub(super) fn sanitize_asset(name: &str) -> Result<String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
    {
        return Err(Error::BadRequest("asset must be a plain filename".into()));
    }
    Ok(name.to_string())
}

/// PUT of an `?asset=`: write the companion file, versioning it only when it is
/// a PDF's sidecar json. The 409 stale-write guard already ran in `put`.
pub(super) async fn put_asset(
    app: &AppState,
    target: &Target,
    q: &FileQuery,
    loopback: bool,
    body: &[u8],
) -> Result<Response> {
    let file_path = target.file_path();
    let sp = app.space();

    // An asset is usually opaque bytes (md images): no frontmatter, no
    // per-asset history -- the owning md's snapshot bundles it on the md's own
    // save. The one exception is a PDF's sidecar json: that IS the pdf's
    // editable / versioned content, so it gets remote-write protection and an
    // in-place history row keyed under the pdf (design.md L90 / L318).
    let is_pdf_sidecar = meta::is_pdf(&target.owner_path)
        && file_path == crate::util::pdf_sidecar_for(&target.owner_path);
    // Remote sidecar writes may change only the annotation data; the identity
    // fields (id/title/tags/backrefs) are kept from disk. Loopback writes are
    // unrestricted.
    let to_write: Vec<u8> = if is_pdf_sidecar && !loopback {
        match sp.read_file(&file_path).await {
            Ok((disk, _)) => crate::meta::merge_remote_sidecar(&disk, body),
            Err(_) => body.to_vec(),
        }
    } else {
        body.to_vec()
    };
    let written = sp.write_file(&file_path, &to_write, None).await?;
    if is_pdf_sidecar {
        // Version the sidecar in the pdf's `.history/` (manifest keyed by the
        // sidecar path relative to the pdf's directory).
        record_history(
            &target.owner_path,
            &written,
            &to_write,
            q.save_type.as_deref(),
            q.peer.clone(),
        );
    }
    let id = owner_id(app, target);
    let mut h = HeaderMap::new();
    set_meta_headers(&mut h, &written);
    set_id_header(&mut h, &id);
    let mut r = (StatusCode::OK, "OK").into_response();
    r.headers_mut().extend(h);
    Ok(r)
}
