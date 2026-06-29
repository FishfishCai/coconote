// Wire metadata types (SPEC-redesign API). A per-file GET/PUT returns the
// body plus X-Permission (ro/rw), X-Last-Modified (ms epoch), and
// X-Content-Hash (lowercase hex BLAKE3, full-body reads/writes only).
// `Entry` is the in-process metadata snapshot those headers come from.
//
// The file-centric redesign has no directory listing and no vault, so there
// is no SpacePrimitives abstraction: files are addressed by absolute path
// and read/written by the free functions in `space::disk`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Perm {
    Ro,
    Rw,
}

/// One per-file metadata snapshot. Body, path, and content_type never live
/// here: the GET handler addresses the file by path, streams the body
/// separately, and derives the type.
#[derive(Debug, Clone)]
pub struct Entry {
    /// Millisecond epoch of last modification (0 when unavailable).
    pub mtime: i64,
    /// `ro` when the file is on-disk read-only, or a remote write is denied.
    /// Drives the editor's edit affordance via `X-Permission`.
    pub perm: Perm,
    /// Lowercase hex BLAKE3 of the body. Only on full-body GET/PUT, empty
    /// on HEAD / 304 / conflict snapshots.
    pub content_hash: String,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            mtime: 0,
            perm: Perm::Rw,
            content_hash: String::new(),
        }
    }
}
