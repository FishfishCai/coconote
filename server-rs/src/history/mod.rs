// In-place version history (SPEC-redesign history): each file's history
// lives beside it in `.<name>.assets/.history/` -- a content-addressable
// blob pool (files named by their lowercase-hex BLAKE3) plus a
// `versions.json` manifest. It moves, renames, and deletes with the file
// because it sits inside its companion folder.
//
//   versions.json: [ { "ts", "save_type", "manifest": {"<filename>": "<hash>"} } ]
//   push / pull rows also carry `peer` (the remote url), so a 3-way merge can
//   pick the base = the latest push/pull row content for that same peer.
//
// save_type is one of create / edit / push / pull / keep. ts is strictly
// increasing per file. Retention decays plain `edit` rows (newest per time
// bucket); create / keep / push / pull are never pruned. There is no central
// DB and no page_id: the file's own path is the key. This file owns the
// record / list / restore-support orchestration; the blob pool is in
// `blobs.rs`, the versions.json model in `versions.rs`, retention in `prune.rs`.

mod blobs;
mod prune;
mod versions;

pub use blobs::read_blob;
pub use prune::prune;
pub use versions::{Manifest, SaveType, VersionMeta};

use blobs::{blob_path, gc_blobs};
use versions::{history_dir, load_versions, next_ts, save_versions, Version};

use crate::error::{Error, Result};
#[cfg(test)]
use crate::util::blake3_hex;

/// Record one version of `main_path`. `manifest` maps filenames to hashes
/// and `blobs` carries their bytes (already-pooled blobs may be omitted).
/// `save_type = None` means "create if this is the first row, else edit".
/// `peer` is the remote url stamped onto a push / pull row (None otherwise).
/// Blocking fs work: call from a blocking context or spawn it.
pub fn record(
    main_path: &str,
    save_type: Option<SaveType>,
    peer: Option<String>,
    manifest: indexmap::IndexMap<String, String>,
    blobs: &[(String, Vec<u8>)],
) -> Result<i64> {
    let dir = history_dir(main_path);
    std::fs::create_dir_all(&dir).map_err(Error::Io)?;
    for (hash, bytes) in blobs {
        let bp = blob_path(&dir, hash);
        if !bp.exists() {
            crate::util::write_atomic(&bp, bytes)?;
        }
    }
    let mut versions = load_versions(main_path);
    // The first row of a file is always `create` (design.md L271: create =
    // "first record"), even when the caller passed save_type=edit. A first-
    // ever push/pull/keep keeps its type: those carry sync-peer / retention
    // semantics that `create` would erase.
    let st = if versions.is_empty()
        && !matches!(
            save_type,
            Some(SaveType::Push) | Some(SaveType::Pull) | Some(SaveType::Keep)
        ) {
        SaveType::Create
    } else {
        save_type.unwrap_or(SaveType::Edit)
    };
    // Only push / pull rows keep a peer.
    let peer = peer.filter(|_| matches!(st, SaveType::Push | SaveType::Pull));
    let ts = next_ts(&versions);
    versions.push(Version {
        ts,
        save_type: st,
        peer,
        manifest: Manifest { files: manifest },
    });
    save_versions(main_path, &versions)?;
    Ok(ts)
}

/// Single-file convenience (1-entry manifest). Test-only: production writes
/// go through `record` with a full manifest.
#[cfg(test)]
pub fn record_single(
    main_path: &str,
    save_type: Option<SaveType>,
    filename: &str,
    bytes: &[u8],
) -> Result<i64> {
    let hash = blake3_hex(bytes);
    let mut files = indexmap::IndexMap::new();
    files.insert(filename.to_string(), hash.clone());
    record(main_path, save_type, None, files, &[(hash, bytes.to_vec())])
}

/// Version list, newest first.
pub fn list(main_path: &str) -> Vec<VersionMeta> {
    let mut versions = load_versions(main_path);
    versions.sort_by(|a, b| b.ts.cmp(&a.ts));
    versions
        .into_iter()
        .map(|v| VersionMeta {
            ts: v.ts,
            save_type: v.save_type,
            peer: v.peer,
        })
        .collect()
}

/// 3-way merge base for syncing with `peer`: the content of the latest
/// push / pull row whose `peer` matches, or empty when this file has never
/// synced with that peer (design.md push/pull: "with no such base row, the
/// base is empty content").
pub fn merge_base_for_peer(main_path: &str, peer: &str) -> Vec<u8> {
    let base = load_versions(main_path)
        .into_iter()
        .filter(|v| {
            matches!(v.save_type, SaveType::Push | SaveType::Pull)
                && v.peer.as_deref() == Some(peer)
        })
        .max_by_key(|v| v.ts);
    let Some(version) = base else {
        return Vec::new();
    };
    let manifest = version.manifest;
    manifest
        .files
        .get(manifest.main_file())
        .and_then(|hash| read_blob(main_path, hash))
        .unwrap_or_default()
}

/// Manifest at a given ts.
pub fn manifest_at(main_path: &str, ts: i64) -> Option<Manifest> {
    load_versions(main_path)
        .into_iter()
        .find(|v| v.ts == ts)
        .map(|v| v.manifest)
}

/// Most recent row's manifest (for /keep).
pub fn latest_manifest(main_path: &str) -> Option<Manifest> {
    load_versions(main_path)
        .into_iter()
        .max_by_key(|v| v.ts)
        .map(|v| v.manifest)
}

/// `?ts=` preview: the main-file bytes of that snapshot.
pub fn preview_at(main_path: &str, ts: i64) -> Option<Vec<u8>> {
    let manifest = manifest_at(main_path, ts)?;
    let hash = manifest.files.get(manifest.main_file())?;
    read_blob(main_path, hash)
}

/// Delete one version row by ts. Returns the number removed (0 or 1), then
/// GCs blobs no surviving row references.
pub fn delete_at(main_path: &str, ts: i64) -> Result<u64> {
    let mut versions = load_versions(main_path);
    let before = versions.len();
    versions.retain(|v| v.ts != ts);
    let removed = (before - versions.len()) as u64;
    if removed > 0 {
        save_versions(main_path, &versions)?;
        gc_blobs(main_path, &versions);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn md(d: &TempDir, name: &str) -> String {
        d.path().join(name).to_string_lossy().into_owned()
    }

    /// Record a push/pull row carrying `peer` and its blob.
    fn record_pp(main_path: &str, st: SaveType, peer: &str, bytes: &[u8]) {
        let hash = blake3_hex(bytes);
        let mut files = indexmap::IndexMap::new();
        files.insert("n.md".to_string(), hash.clone());
        record(main_path, Some(st), Some(peer.to_string()), files, &[(hash, bytes.to_vec())])
            .unwrap();
    }

    #[test]
    fn record_list_preview_roundtrip() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "note.md");
        record_single(&p, Some(SaveType::Create), "note.md", b"v1").unwrap();
        record_single(&p, Some(SaveType::Edit), "note.md", b"v2").unwrap();
        let rows = list(&p);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].save_type, SaveType::Edit);
        assert_eq!(rows[1].save_type, SaveType::Create);
        // Preview of the oldest returns v1.
        assert_eq!(preview_at(&p, rows[1].ts).unwrap(), b"v1");
    }

    #[test]
    fn history_dir_sits_beside_file() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "sub/note.md");
        record_single(&p, Some(SaveType::Create), "note.md", b"x").unwrap();
        assert!(d.path().join("sub/.note.assets/.history/versions.json").exists());
    }

    #[test]
    fn ts_strictly_increases() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        let t1 = record_single(&p, Some(SaveType::Edit), "n.md", b"a").unwrap();
        let t2 = record_single(&p, Some(SaveType::Edit), "n.md", b"b").unwrap();
        let t3 = record_single(&p, Some(SaveType::Edit), "n.md", b"c").unwrap();
        assert!(t1 < t2 && t2 < t3);
    }

    #[test]
    fn default_save_type_create_then_edit() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        record_single(&p, None, "n.md", b"a").unwrap();
        record_single(&p, None, "n.md", b"b").unwrap();
        let rows = list(&p);
        assert_eq!(rows[1].save_type, SaveType::Create);
        assert_eq!(rows[0].save_type, SaveType::Edit);
    }

    #[test]
    fn first_row_is_create_even_when_edit_requested() {
        // design.md L271: the first record is `create` regardless of an
        // explicit save_type=edit.
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        record_single(&p, Some(SaveType::Edit), "n.md", b"a").unwrap();
        record_single(&p, Some(SaveType::Edit), "n.md", b"b").unwrap();
        let rows = list(&p);
        assert_eq!(rows[1].save_type, SaveType::Create, "forced create on first row");
        assert_eq!(rows[0].save_type, SaveType::Edit);
    }

    #[test]
    fn first_row_push_keeps_its_type() {
        // A first-ever push/pull keeps its type and peer (merge-base needs it).
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        record_pp(&p, SaveType::Push, "https://peer.example", b"v1");
        let rows = list(&p);
        assert_eq!(rows[0].save_type, SaveType::Push, "first push stays push");
        assert_eq!(rows[0].peer.as_deref(), Some("https://peer.example"));
    }

    #[test]
    fn delete_removes_row_and_gcs_blob() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        record_single(&p, Some(SaveType::Create), "n.md", b"keep").unwrap();
        let ts = record_single(&p, Some(SaveType::Edit), "n.md", b"drop").unwrap();
        let drop_hash = blake3_hex(b"drop");
        assert!(read_blob(&p, &drop_hash).is_some());
        assert_eq!(delete_at(&p, ts).unwrap(), 1);
        assert_eq!(list(&p).len(), 1);
        // Its blob is collected; the kept blob survives.
        assert!(read_blob(&p, &drop_hash).is_none());
        assert!(read_blob(&p, &blake3_hex(b"keep")).is_some());
    }

    #[test]
    fn delete_unknown_ts_is_zero() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        record_single(&p, Some(SaveType::Create), "n.md", b"x").unwrap();
        assert_eq!(delete_at(&p, 999999).unwrap(), 0);
        assert_eq!(list(&p).len(), 1);
    }

    #[test]
    fn merge_base_picks_latest_row_for_that_peer() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        // No sync yet -> empty base.
        assert!(merge_base_for_peer(&p, "https://a.example").is_empty());
        // Two peers, multiple syncs: base is the latest row for the peer.
        record_pp(&p, SaveType::Push, "https://a.example", b"a-v1");
        record_pp(&p, SaveType::Pull, "https://b.example", b"b-v1");
        record_pp(&p, SaveType::Pull, "https://a.example", b"a-v2");
        assert_eq!(merge_base_for_peer(&p, "https://a.example"), b"a-v2");
        assert_eq!(merge_base_for_peer(&p, "https://b.example"), b"b-v1");
        // Unknown peer -> empty base.
        assert!(merge_base_for_peer(&p, "https://c.example").is_empty());
    }

    #[test]
    fn pdf_main_file_falls_to_first_entry() {
        let mut files = indexmap::IndexMap::new();
        files.insert(".paper.assets/annots.json".to_string(), "h".to_string());
        let man = Manifest { files };
        assert_eq!(man.main_file(), ".paper.assets/annots.json");
    }
}
