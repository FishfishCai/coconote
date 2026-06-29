// Retention by time bucket: thin plain `edit` rows, then GC orphan blobs.
use super::blobs::gc_blobs;
use super::versions::{load_versions, save_versions, SaveType};
use crate::error::Result;
use std::collections::HashSet;

/// Retention (SPEC-redesign): plain `edit` rows decay -- newest in each
/// bucket survives (<1h all, 1h-1d 1/hr, 1d-7d 1/day, 7d-30d 1/wk, >30d
/// 1/mo). create / pin / push / pull are always kept. Then GC orphan blobs.
pub fn prune(main_path: &str, now: i64) -> Result<u64> {
    let mut versions = load_versions(main_path);
    versions.sort_by(|a, b| b.ts.cmp(&a.ts)); // newest first
    let h = 60 * 60 * 1000_i64;
    let d = 24 * h;
    let w = 7 * d;
    let mo = 30 * d;
    let mut keep = HashSet::<i64>::new();
    let (mut last_hour, mut last_day, mut last_week, mut last_month) =
        (i64::MIN, i64::MIN, i64::MIN, i64::MIN);
    for v in &versions {
        if v.save_type != SaveType::Edit {
            keep.insert(v.ts);
            continue;
        }
        let age = now - v.ts;
        let (bucket, last) = if age < h {
            keep.insert(v.ts);
            continue;
        } else if age < d {
            (v.ts / h, &mut last_hour)
        } else if age < w {
            (v.ts / d, &mut last_day)
        } else if age < mo {
            (v.ts / w, &mut last_week)
        } else {
            (v.ts / mo, &mut last_month)
        };
        if bucket != *last {
            keep.insert(v.ts);
            *last = bucket;
        }
    }
    let before = versions.len();
    versions.retain(|v| keep.contains(&v.ts));
    let deleted = (before - versions.len()) as u64;
    if deleted > 0 {
        save_versions(main_path, &versions)?;
        gc_blobs(main_path, &versions);
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::blobs::blob_path;
    use crate::history::versions::{history_dir, Version};
    use crate::history::{list, Manifest};
    use crate::util::blake3_hex;
    use tempfile::TempDir;

    const H: i64 = 60 * 60 * 1000;
    const D: i64 = 24 * H;

    fn md(d: &TempDir, name: &str) -> String {
        d.path().join(name).to_string_lossy().into_owned()
    }

    fn m(tag: &str) -> Manifest {
        let mut files = indexmap::IndexMap::new();
        files.insert("n.md".to_string(), blake3_hex(tag.as_bytes()));
        Manifest { files }
    }

    #[test]
    fn prune_keeps_non_edit_decays_edit() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        // Build versions.json directly with controlled ts.
        let now = 100 * D;
        let versions = vec![
            Version { ts: now - 3 * D, save_type: SaveType::Keep, peer: None, manifest: m("keep") },
            Version { ts: now - 3 * D + H, save_type: SaveType::Edit, peer: None, manifest: m("e_old") },
            Version { ts: now - 3 * D + 2 * H, save_type: SaveType::Edit, peer: None, manifest: m("e_new") },
        ];
        // Seed blobs + versions.
        std::fs::create_dir_all(history_dir(&p)).unwrap();
        for v in &versions {
            for h in v.manifest.files.values() {
                std::fs::write(blob_path(&history_dir(&p), h), b"x").unwrap();
            }
        }
        save_versions(&p, &versions).unwrap();
        prune(&p, now).unwrap();
        let kept: HashSet<i64> = list(&p).iter().map(|v| v.ts).collect();
        assert!(kept.contains(&(now - 3 * D)), "keep kept");
        assert!(kept.contains(&(now - 3 * D + 2 * H)), "newest edit kept");
        assert!(!kept.contains(&(now - 3 * D + H)), "older edit pruned");
    }

    #[test]
    fn prune_keeps_one_per_window() {
        let d = TempDir::new().unwrap();
        let p = md(&d, "n.md");
        let now = 1000 * 30 * D;
        let versions = vec![
            Version { ts: now - 10 * 60 * 1000, save_type: SaveType::Edit, peer: None, manifest: m("fresh") },
            Version { ts: now - 5 * H, save_type: SaveType::Edit, peer: None, manifest: m("hourly") },
            Version { ts: now - 3 * D, save_type: SaveType::Edit, peer: None, manifest: m("daily") },
            Version { ts: now - 2 * 7 * D, save_type: SaveType::Edit, peer: None, manifest: m("weekly") },
            Version { ts: now - 5 * 30 * D, save_type: SaveType::Edit, peer: None, manifest: m("monthly") },
        ];
        std::fs::create_dir_all(history_dir(&p)).unwrap();
        save_versions(&p, &versions).unwrap();
        assert_eq!(prune(&p, now).unwrap(), 0, "lone occupant per window kept");
        assert_eq!(list(&p).len(), 5);
    }
}
