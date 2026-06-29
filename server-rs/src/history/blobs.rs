// The content-addressed blob pool: every versioned byte string is stored once
// under its lowercase-hex BLAKE3 in the file's `.history/` dir. Reads fetch by
// hash; GC drops blobs no surviving version row references.
use super::versions::{history_dir, Version};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(super) fn blob_path(dir: &Path, hash: &str) -> PathBuf {
    dir.join(hash)
}

/// Read one pooled blob by hash.
pub fn read_blob(main_path: &str, hash: &str) -> Option<Vec<u8>> {
    std::fs::read(blob_path(&history_dir(main_path), hash)).ok()
}

/// Remove blob files no surviving version references.
pub(super) fn gc_blobs(main_path: &str, versions: &[Version]) {
    let dir = history_dir(main_path);
    let live: HashSet<&String> = versions
        .iter()
        .flat_map(|v| v.manifest.files.values())
        .collect();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Only touch blob files (64-hex), never versions.json or tmp files.
        if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
            if !live.contains(&name.to_string()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
