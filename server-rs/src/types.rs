// Wire types (server.md): GET /.file -> array of {type, path, ...} rows
// (file rows add page_id, title, tag, size, mtime). GET /.file/<path> ->
// body + X-Permission (ro/rw), X-Last-Modified (ms epoch), X-Content-Hash
// (lowercase hex BLAKE3, GET only, absent on HEAD). Entry covers both.

use crate::error::Result;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Dir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Perm {
    Ro,
    Rw,
}

/// One listing row OR one per-file metadata snapshot. Field names match
/// server.md. Body, hash, and content_type never appear on the listing:
/// clients fetch those via GET /.file/<path>.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    #[serde(rename = "type")]
    pub kind: EntryType,
    pub path: String,
    /// Frontmatter / sidecar `id:`. Empty for non-md/pdf or pages
    /// without an id yet.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub page_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tag: Vec<String>,
    /// `prereq:` frontmatter. The Graph view builds the prereq DAG from
    /// it without re-reading every file (content.md).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prereq: Vec<String>,
    /// H1-H4 heading texts of a md file. On listings so the content.md
    /// filter ("match scope covers ... headings inside files") needn't
    /// re-read every body.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<String>,
    /// Raw `[[wikilink]]` targets (pre-resolution). On listings so the
    /// Graph view can build edges without re-reading files (content.md
    /// Graph view: "driven by both the `prereq:` field in frontmatter
    /// and wikilinks").
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub wikilinks: Vec<String>,
    /// Bytes, 0 for dirs.
    pub size: i64,
    /// Millisecond epoch. 0 for dirs.
    pub mtime: i64,
    /// Read-only spaces report `ro`. Per-file GETs use it to drive the
    /// editor's edit affordance (`X-Permission`).
    pub perm: Perm,
    /// Lowercase hex BLAKE3 of the body. Only on per-file GETs, empty on
    /// listing rows and HEAD.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content_hash: String,
    /// Admission flag for md/pdf page rows: false when frontmatter /
    /// sidecar lacks `coconote: true`. Dirs and non-page files keep the
    /// default true (admission doesn't apply). Serialized only when
    /// false, i.e. on the excluded rows of `?all=1` listings.
    #[serde(skip_serializing_if = "is_default_coconote")]
    pub coconote: bool,
}

fn is_default_coconote(v: &bool) -> bool {
    // Normal listings only contain non-excluded rows: emitting the
    // field on every row would be noise.
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

/// Backend abstraction (disk, embed, composite). Returns owned bytes so
/// implementations may mmap, decompress, or stream.
#[async_trait::async_trait]
pub trait SpacePrimitives: Send + Sync {
    /// Default listing: every entry (server.md "lists every entry")
    /// EXCEPT unadmitted md/pdf rows and dot-prefixed sidecars / assets
    /// dirs. Dirs and non-page files always included.
    async fn fetch_file_list(&self) -> Result<Vec<Entry>> {
        self.fetch_file_list_all(false).await
    }
    /// `include_excluded = true` returns every supported md/pdf, with
    /// `coconote: false` on unadmitted rows (file.md "show all supported
    /// files" content-browser mode).
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>>;
    async fn get_file_meta(&self, path: &str) -> Result<Entry>;
    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)>;
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<Entry>;
    async fn delete_file(&self, path: &str) -> Result<()>;
    /// Create an empty directory (server.md PUT `?type=dir`).
    async fn create_dir(&self, path: &str) -> Result<Entry>;
    /// Raw recursive FILE list under `prefix` (no dot filtering, no
    /// md/pdf restriction), for capturing `.<name>.assets/` contents in
    /// history snapshots (file.md: md page's file set includes every
    /// assets image). Default impl returns empty, physical backends override.
    async fn list_under_prefix(&self, _prefix: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }
}
