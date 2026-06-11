// Wire types. Spec endpoint shape (server.md):
//
//   GET /.file        → array of `{type, path, ...}`
//                       file entries also carry: page_id, title, tag, size, mtime
//
//   GET /.file/<path> → body + X-* headers:
//                       X-Permission   (ro/rw)
//                       X-Last-Modified (ms epoch integer)
//                       X-Content-Hash  (lowercase hex BLAKE3, GET only — absent on HEAD)
//
// `Entry` covers both list rows and per-file metadata; consumers ignore
// fields they don't need.

use crate::error::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Dir,
}

impl Default for EntryType {
    fn default() -> Self {
        EntryType::File
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Perm {
    Ro,
    Rw,
}

/// One listing row OR one per-file metadata snapshot. Field names match
/// the spec (server.md): `type`, `path`, `page_id`, `title`, `tag`,
/// `size`, `mtime`. We never put body, hash, or content_type on the
/// listing — clients fetch those via GET /.file/<path>.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    #[serde(rename = "type")]
    pub kind: EntryType,
    pub path: String,
    /// Frontmatter / sidecar `id:`. Empty for non-md, non-pdf, or for
    /// md/pdf without an id yet.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub page_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag: Vec<String>,
    /// `prereq:` from frontmatter — the Graph view needs it to build the
    /// prereq DAG without re-reading every file (content.md).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prereq: Vec<String>,
    /// Heading texts (H1-H4) inside a md file. Surfaced on listings so
    /// content.md filter ("match scope covers ... headings inside
    /// files") doesn't have to re-read every body.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<String>,
    /// `[[wikilink]]` targets inside a md body (raw spec strings,
    /// pre-resolution). Surfaced on listings so the Graph view can
    /// build edges from wikilinks without re-reading every file
    /// (content.md §Graph view: "driven by both the `prereq:` field
    /// in frontmatter and wikilinks").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wikilinks: Vec<String>,
    /// Bytes; 0 for dirs.
    #[serde(default)]
    pub size: i64,
    /// Millisecond epoch. 0 for dirs.
    #[serde(default)]
    pub mtime: i64,
    /// Per-file permission. Listing rows from a read-only space report
    /// `ro`; per-file GET responses also use this to drive the editor's
    /// edit affordance (`X-Permission`).
    pub perm: Perm,
    /// Lowercase hex BLAKE3 of the body. Populated only on per-file
    /// reads (GET /.file/<path>); empty on listing rows and on HEAD.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content_hash: String,
    /// Admission flag, meaningful only for md/pdf page rows: false when
    /// the frontmatter / sidecar does NOT carry `coconote: true`. Dirs
    /// and non-page files (images, ...) keep the default `true`, which
    /// here just means "not an excluded page" — admission doesn't apply
    /// to them. Serialized only when false, i.e. on `?all=1` listings'
    /// excluded rows; admitted rows omit it.
    #[serde(default, skip_serializing_if = "is_default_coconote")]
    pub coconote: bool,
}

fn is_default_coconote(v: &bool) -> bool {
    // Default to true: the normal listing only contains rows that are
    // not excluded, and emitting the field on every row would be noise.
    *v
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            kind: EntryType::File,
            path: String::new(),
            page_id: String::new(),
            title: String::new(),
            tag: Vec::new(),
            prereq: Vec::new(),
            headings: Vec::new(),
            wikilinks: Vec::new(),
            size: 0,
            mtime: 0,
            perm: Perm::Ro,
            content_hash: String::new(),
            coconote: true,
        }
    }
}

/// Backend abstraction. Disk-, embed-, or composite-backed. Returns
/// owned bytes so implementations are free to mmap, decompress, or
/// stream as they see fit.
#[async_trait::async_trait]
pub trait SpacePrimitives: Send + Sync {
    /// Default listing: every entry in the vault (server.md "lists
    /// every entry") EXCEPT md/pdf rows not admitted by Coconote and
    /// dot-prefixed sidecars / assets dirs. Dirs and non-page files are
    /// always included.
    async fn fetch_file_list(&self) -> Result<Vec<Entry>> {
        self.fetch_file_list_all(false).await
    }
    /// `include_excluded = true` returns every supported md/pdf in the
    /// space, with `coconote: false` set on rows that aren't admitted
    /// (file.md "show all supported files" content-browser mode).
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>>;
    async fn get_file_meta(&self, path: &str) -> Result<Entry>;
    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)>;
    /// `mtime_hint`: client-supplied millisecond epoch from a sync flow
    /// that wants to round-trip mtime across machines. Ignored when 0.
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mtime_hint: Option<i64>,
    ) -> Result<Entry>;
    async fn delete_file(&self, path: &str) -> Result<()>;
    /// Create an empty directory (server.md PUT `?type=dir`).
    async fn create_dir(&self, path: &str) -> Result<Entry>;
    /// Raw recursive list of FILES under `prefix` (no dot-file filtering,
    /// no md/pdf restriction). Used for capturing `.<name>.assets/`
    /// contents in history snapshots (file.md: md page's full file
    /// set includes every image under the assets folder). Default impl
    /// returns empty; backends that physically host files should
    /// override.
    async fn list_under_prefix(&self, _prefix: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }
}
