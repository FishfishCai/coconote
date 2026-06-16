// History value types and (de)serialization (history.md Storage model):
// SaveType, the VersionMeta list row, and Manifest, the flat {filename: hash}
// JSON of a page's full file set at one moment.

use serde::de::Deserializer;
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

/// What triggered this version row. CHECK-constrained in the DB.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveType {
    Create,
    Edit,
    Push,
    Pull,
    Pin,
}

impl SaveType {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveType::Create => "create",
            SaveType::Edit => "edit",
            SaveType::Push => "push",
            SaveType::Pull => "pull",
            SaveType::Pin => "pin",
        }
    }

    /// Parse `?save_type=` on PUT /.file/<path>. `create` is server-decided
    /// (first row for a page_id) and never accepted from the wire.
    pub fn from_put_query(s: &str) -> Option<Self> {
        match s {
            "edit" => Some(SaveType::Edit),
            "push" => Some(SaveType::Push),
            "pull" => Some(SaveType::Pull),
            _ => None,
        }
    }
}

pub(crate) fn save_type_from_str(s: &str) -> SaveType {
    match s {
        "create" => SaveType::Create,
        "push" => SaveType::Push,
        "pull" => SaveType::Pull,
        "pin" => SaveType::Pin,
        _ => SaveType::Edit,
    }
}

/// One row of the `/.history/<page_id>` list (server.md: `[{ts, save_type}, ...]`).
#[derive(Debug, Serialize)]
pub struct VersionMeta {
    pub ts: i64,
    pub save_type: SaveType,
}

/// A page's full file set at one ts: the flat {filename: hash} JSON
/// history.md specifies, relative to the page's directory (page basename
/// for the main file, `.<stem>.assets/<f>` for images). The main file is
/// derived from filename shape on demand, never stored.
#[derive(Debug)]
pub struct Manifest {
    pub files: indexmap::IndexMap<String, String>,
}

impl Manifest {
    /// The entry whose body the preview endpoint returns (server.md: "?ts=<ms>
    /// returns the main md text"): top-level `*.md` for md pages, the
    /// `.<name>.json` sidecar for pdf pages, else the first entry.
    pub fn main_file(&self) -> &str {
        self.files
            .keys()
            .find(|k| !k.contains('/') && k.to_ascii_lowercase().ends_with(".md"))
            .or_else(|| self.files.keys().find(|k| is_sidecar_name(k)))
            .or_else(|| self.files.keys().next())
            .map(String::as_str)
            .unwrap_or("")
    }
}

impl Serialize for Manifest {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        // history.md: manifest JSON is flat {filename: hash}.
        self.files.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            /// Pre-flat rows {main_file, files}: the wrapper is dropped and
            /// main_file recomputed, so existing DBs still read.
            Legacy { files: indexmap::IndexMap<String, String> },
            Flat(indexmap::IndexMap<String, String>),
        }
        let (Wire::Legacy { files } | Wire::Flat(files)) = Wire::deserialize(d)?;
        Ok(Manifest { files })
    }
}

/// `.{stem}.json` with no directory part: the pdf sidecar shape.
pub fn is_sidecar_name(name: &str) -> bool {
    !name.contains('/')
        && name
            .strip_prefix('.')
            .and_then(|r| r.strip_suffix(".json"))
            .is_some_and(|stem| !stem.is_empty())
}
