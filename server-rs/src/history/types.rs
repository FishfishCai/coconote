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

/// A page's full file set at one ts, stored as the flat {filename: hash}
/// JSON history.md specifies. `main_file` is derived from filename shapes
/// on read and never serialized.
#[derive(Debug)]
pub struct Manifest {
    /// Filename whose body the preview endpoint returns (server.md: "?ts=<ms>
    /// returns the main md text"): the .md file for md pages, the
    /// `.<name>.json` sidecar for pdf pages.
    pub main_file: String,
    /// {filename -> blake3 hex hash}, relative to the page's directory:
    /// page basename for the main file, `.<stem>.assets/<f>` for images.
    pub files: indexmap::IndexMap<String, String>,
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
            /// Pre-flat rows, kept readable so existing DBs survive.
            Legacy {
                main_file: String,
                files: indexmap::IndexMap<String, String>,
            },
            Flat(indexmap::IndexMap<String, String>),
        }
        Ok(match Wire::deserialize(d)? {
            Wire::Legacy { main_file, files } => Manifest { main_file, files },
            Wire::Flat(files) => {
                let main_file = derive_main_file(&files);
                Manifest { main_file, files }
            }
        })
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

/// Pick the main entry by filename shape: top-level `*.md` = md body,
/// top-level `.{stem}.json` = pdf sidecar, rest (`.{stem}.assets/<f>`) = assets.
pub(crate) fn derive_main_file(files: &indexmap::IndexMap<String, String>) -> String {
    for k in files.keys() {
        if !k.contains('/') && k.to_ascii_lowercase().ends_with(".md") {
            return k.clone();
        }
    }
    for k in files.keys() {
        if is_sidecar_name(k) {
            return k.clone();
        }
    }
    files.keys().next().cloned().unwrap_or_default()
}
