use super::*;
use crate::resolver::Resolver;
use std::path::Path;
use tempfile::TempDir;

#[test]
fn load_minimal() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("coconote.yaml");
    std::fs::write(&p, "port: 40704\n").unwrap();
    let cfg = FileConfig::load(&p).unwrap().unwrap();
    assert_eq!(cfg.port, Some(40704));
}

#[test]
fn auth_defaults_when_absent() {
    let cfg: FileConfig = serde_yaml::from_str("port: 1\n").unwrap();
    assert_eq!(cfg.auth_token(), "coconote");
}

#[test]
fn auth_explicit_wins() {
    let cfg: FileConfig = serde_yaml::from_str("auth: hunter2\n").unwrap();
    assert_eq!(cfg.auth_token(), "hunter2");
}

#[test]
fn port_zero_is_explicit_ephemeral() {
    let cfg: FileConfig = serde_yaml::from_str("port: 0\n").unwrap();
    assert_eq!(cfg.port, Some(0));
}

#[test]
fn url_pairs_parsed() {
    let yaml = "url:\n  - url: https://a.example\n    auth: tok-a\n  - url: https://b.example\n";
    let cfg: FileConfig = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(cfg.url.len(), 2);
    assert_eq!(cfg.url[0].url, "https://a.example");
    assert_eq!(cfg.url[0].auth, "tok-a");
    assert_eq!(cfg.url[1].url, "https://b.example");
    assert_eq!(cfg.url[1].auth, "", "auth omitted -> empty");
}

#[test]
fn url_bare_string_migrates() {
    // A legacy `url: [https://...]` (bare strings) still parses.
    let cfg: FileConfig = serde_yaml::from_str("url:\n  - https://legacy.example\n").unwrap();
    assert_eq!(cfg.url.len(), 1);
    assert_eq!(cfg.url[0].url, "https://legacy.example");
    assert_eq!(cfg.url[0].auth, "");
}

#[test]
fn watch_roots_parsed() {
    let cfg: FileConfig =
        serde_yaml::from_str("watch:\n  - /Users/me/notes\n  - /Users/me/papers\n").unwrap();
    assert_eq!(cfg.watch, vec!["/Users/me/notes", "/Users/me/papers"]);
}

#[test]
fn unknown_keys_are_tolerated() {
    // A typo'd key must not nuke the whole config.
    let cfg: FileConfig = serde_yaml::from_str("auth: hunter2\nroot:\n  main: /x\n").unwrap();
    assert_eq!(cfg.auth_token(), "hunter2");
}

#[test]
fn load_missing_returns_none() {
    let cfg = FileConfig::load(Path::new("/nonexistent/coconote.yaml")).unwrap();
    assert!(cfg.is_none());
}

#[test]
fn recent_limit_defaults_to_1024() {
    let cfg: FileConfig = serde_yaml::from_str("port: 1\n").unwrap();
    assert_eq!(cfg.recent_limit(), 1024);
    let cfg: FileConfig = serde_yaml::from_str("recent_limit: 25\n").unwrap();
    assert_eq!(cfg.recent_limit(), 25);
}

#[test]
fn recent_and_pin_pairs_parsed() {
    let yaml = "recent:\n  - id: aaaa1111aaaa1111\n    path: /a.md\n  - id: bbbb2222bbbb2222\n    path: /b.md\npin:\n  - id: cccc3333cccc3333\n    path: /c.md\n";
    let cfg: FileConfig = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(cfg.recent.len(), 2);
    assert_eq!(cfg.recent[0].id, "aaaa1111aaaa1111");
    assert_eq!(cfg.recent[0].path, "/a.md");
    assert_eq!(cfg.pin[0].id, "cccc3333cccc3333");
    assert_eq!(cfg.recent_ids(), vec!["aaaa1111aaaa1111", "bbbb2222bbbb2222"]);
    assert_eq!(cfg.pin_ids(), vec!["cccc3333cccc3333"]);
}

#[test]
fn recent_bare_path_migrates_with_empty_id() {
    // Legacy `recent: [/a.md]` parses as a path-only FileRef.
    let cfg: FileConfig = serde_yaml::from_str("recent:\n  - /a.md\n").unwrap();
    assert_eq!(cfg.recent.len(), 1);
    assert_eq!(cfg.recent[0].id, "");
    assert_eq!(cfg.recent[0].path, "/a.md");
    // An empty id is not a valid boundary entry.
    assert!(cfg.recent_ids().is_empty());
}

#[test]
fn empty_lists_parse_to_empty() {
    // The default yaml has bare `url:` / `watch:` / `recent:` / `pin:` lines.
    let yaml = "port: 40704\nauth: coconote\nrecent_limit: 1024\nurl:\nwatch:\nrecent:\npin:\n";
    let cfg: FileConfig = serde_yaml::from_str(yaml).unwrap();
    assert!(cfg.url.is_empty());
    assert!(cfg.watch.is_empty());
    assert!(cfg.recent.is_empty());
    assert!(cfg.pin.is_empty());
    assert_eq!(cfg.port, Some(40704));
    assert_eq!(cfg.auth_token(), "coconote");
}

// --- reconcile_entries (file tracking: relocate / drop / id backfill) ---

fn write_md(dir: &Path, name: &str, id: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, format!("---\nid: {id}\ntitle: {name}\n---\nbody\n")).unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn reconcile_relocates_updates_path() {
    let d = TempDir::new().unwrap();
    let old = write_md(d.path(), "a.md", "relocate00000000");
    let r = Resolver::new(vec![d.path().to_string_lossy().into_owned()]);
    r.boot_scan(&[]);
    // The recorded path is stale: the file was renamed while closed.
    std::fs::rename(&old, d.path().join("b.md")).unwrap();
    let mut entries = vec![FileRef { id: "relocate00000000".into(), path: old.clone() }];
    let changed = reconcile_entries(&r, &mut entries);
    assert!(changed);
    assert_eq!(entries.len(), 1);
    assert!(entries[0].path.ends_with("b.md"), "path updated to new location");
}

#[test]
fn reconcile_drops_deleted_unrelocatable() {
    let d = TempDir::new().unwrap();
    let p = write_md(d.path(), "gone.md", "deleteme00000000");
    let r = Resolver::new(vec![d.path().to_string_lossy().into_owned()]);
    r.boot_scan(&[]);
    std::fs::remove_file(&p).unwrap();
    let mut entries = vec![FileRef { id: "deleteme00000000".into(), path: p }];
    let changed = reconcile_entries(&r, &mut entries);
    assert!(changed);
    assert!(entries.is_empty(), "deleted + unrelocatable entry dropped");
}

// --- to_yaml round-trips (the canonical serializer) ---

#[test]
fn yaml_round_trips_scalars_needing_quotes() {
    let mut cfg = FileConfig::default();
    cfg.port = Some(40704);
    cfg.auth = Some("p@ss: word".into());
    cfg.recent.push(FileRef {
        id: "abcd1234efgh5678".into(),
        path: "/has: colon # hash.md".into(),
    });
    let yaml = cfg.to_yaml().unwrap();
    let back: FileConfig = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(back.port, Some(40704));
    assert_eq!(back.auth.as_deref(), Some("p@ss: word"));
    assert_eq!(back.recent[0].path, "/has: colon # hash.md");
    assert_eq!(back.recent[0].id, "abcd1234efgh5678");
}

#[test]
fn yaml_round_trips_pairs() {
    let mut cfg = FileConfig::default();
    cfg.url = vec![UrlEntry { url: "https://a.example".into(), auth: "tok".into() }];
    cfg.watch = vec!["/notes".into()];
    cfg.recent = vec![FileRef { id: "aaaa1111aaaa1111".into(), path: "/a.md".into() }];
    cfg.pin = vec![FileRef { id: "bbbb2222bbbb2222".into(), path: "/b.md".into() }];
    cfg.recent_limit = Some(50);
    let yaml = cfg.to_yaml().unwrap();
    let back: FileConfig = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(back.url, cfg.url);
    assert_eq!(back.watch, vec!["/notes"]);
    assert_eq!(back.recent, cfg.recent);
    assert_eq!(back.pin, cfg.pin);
    assert_eq!(back.recent_limit, Some(50));
}

#[test]
fn yaml_omits_empty_sections() {
    let yaml = FileConfig::default().to_yaml().unwrap();
    assert!(!yaml.contains("url:"));
    assert!(!yaml.contains("watch:"));
    assert!(!yaml.contains("recent:"));
    assert!(!yaml.contains("pin:"));
    assert!(!yaml.contains("port:"));
}

#[test]
fn reconcile_backfills_id_from_disk() {
    let d = TempDir::new().unwrap();
    let p = write_md(d.path(), "legacy.md", "backfill00000000");
    let r = Resolver::new(vec![d.path().to_string_lossy().into_owned()]);
    r.boot_scan(&[]);
    // Path-only legacy entry (empty id).
    let mut entries = vec![FileRef { id: String::new(), path: p }];
    let changed = reconcile_entries(&r, &mut entries);
    assert!(changed);
    assert_eq!(entries[0].id, "backfill00000000", "id read from the file");
}
