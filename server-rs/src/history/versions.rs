// The versions.json model and its load/save. A manifest is a flat
// {filename: blake3-hash} map; a Version row stamps it with a ts (strictly
// increasing per file), a save_type, and (for push/pull) the peer it synced.
use crate::error::{Error, Result};
use crate::util::{assets_prefix_for, now_ms};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What triggered a version row.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveType {
    Create,
    Edit,
    Push,
    Pull,
    Keep,
}

impl SaveType {
    /// Parse `?save_type=` on PUT /.file. `create` is server-decided (first
    /// row of a file) and never accepted from the wire; `keep` is a
    /// history-only op.
    pub fn from_put_query(s: &str) -> Option<Self> {
        match s {
            "edit" => Some(SaveType::Edit),
            "push" => Some(SaveType::Push),
            "pull" => Some(SaveType::Pull),
            _ => None,
        }
    }
}

/// One row of the `/.history?id=` list. `peer` appears only on push / pull
/// rows (the remote url they synced with).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionMeta {
    pub ts: i64,
    pub save_type: SaveType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
}

/// A file's full file set at one ts: flat {filename: hash}. For a markdown
/// page the filenames are the md basename plus any `.<name>.assets/<f>`
/// images; for a PDF page it is the annotations json under the assets dir.
/// Transparent over the map so a Version row serializes as
/// `{ts, save_type, manifest: {<filename>: <hash>}}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Manifest {
    pub files: indexmap::IndexMap<String, String>,
}

impl Manifest {
    /// The entry whose body the preview endpoint returns: a top-level
    /// `*.md`, else the first entry (the PDF annotations json for a pdf
    /// page, which lives under the assets dir).
    pub fn main_file(&self) -> &str {
        self.files
            .keys()
            .find(|k| !k.contains('/') && k.to_ascii_lowercase().ends_with(".md"))
            .or_else(|| self.files.keys().next())
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Version {
    pub(super) ts: i64,
    pub(super) save_type: SaveType,
    /// Remote url for push / pull rows; absent otherwise. Drives per-peer
    /// merge-base selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) peer: Option<String>,
    pub(super) manifest: Manifest,
}

/// `.history/` directory for a main file (md or pdf): `<dir>/.<name>.assets/.history/`.
pub(super) fn history_dir(main_path: &str) -> PathBuf {
    let assets = assets_prefix_for(main_path); // ends with `/`
    PathBuf::from(format!("{assets}.history"))
}

fn versions_path(main_path: &str) -> PathBuf {
    history_dir(main_path).join("versions.json")
}

pub(super) fn load_versions(main_path: &str) -> Vec<Version> {
    let p = versions_path(main_path);
    let Ok(bytes) = std::fs::read(&p) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub(super) fn save_versions(main_path: &str, versions: &[Version]) -> Result<()> {
    let body = serde_json::to_vec_pretty(versions)
        .map_err(|e| Error::Other(format!("serialize versions: {e}")))?;
    crate::util::write_atomic(&versions_path(main_path), &body)
}

/// Next ts: strictly greater than every existing row, and not behind the
/// wall clock.
pub(super) fn next_ts(versions: &[Version]) -> i64 {
    let max = versions.iter().map(|v| v.ts).max().unwrap_or(0);
    now_ms().max(max + 1)
}
