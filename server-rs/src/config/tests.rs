use super::*;
use std::path::{Path, PathBuf};

#[test]
fn load_minimal() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("coconote.yaml");
    std::fs::write(&p, "port: 40704\nroot:\n  main: /tmp\n").unwrap();
    let cfg = FileConfig::load(&p).unwrap().unwrap();
    assert_eq!(cfg.port, Some(40704));
    assert_eq!(cfg.root["main"], "/tmp");
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
fn url_list_parsed() {
    let cfg: FileConfig =
        serde_yaml::from_str("url:\n  - https://a.example\n  - https://b.example\n").unwrap();
    assert_eq!(cfg.url.len(), 2);
}

#[test]
fn unknown_keys_are_tolerated() {
    // A typo'd key must not nuke the whole config (the boot path
    // replaces unparseable yamls with the default).
    let cfg: FileConfig = serde_yaml::from_str("auth: hunter2\nroots:\n  main: /x\n").unwrap();
    assert_eq!(cfg.auth_token(), "hunter2");
    assert!(cfg.root.is_empty());
}

#[test]
fn load_missing_returns_none() {
    let cfg = FileConfig::load(Path::new("/nonexistent/coconote.yaml")).unwrap();
    assert!(cfg.is_none());
}

#[test]
fn expand_home() {
    std::env::set_var("HOME", "/h");
    assert_eq!(expand_user("~/x").unwrap(), PathBuf::from("/h/x"));
    assert_eq!(expand_user("/abs").unwrap(), PathBuf::from("/abs"));
}

#[test]
fn root_preserve_insertion_order() {
    let yaml = "root:\n  b: /b\n  a: /a\n  c: /c\n";
    let cfg: FileConfig = serde_yaml::from_str(yaml).unwrap();
    let names: Vec<&str> = cfg.root.keys().map(|s| s.as_str()).collect();
    assert_eq!(names, vec!["b", "a", "c"]);
}

#[test]
fn empty_root_section_parses_to_zero_roots() {
    // The default yaml from ensure_default_config has an empty
    // `root:` line: must parse to an empty IndexMap, not error.
    let yaml = "port: 40704\nauth: coconote\nroot:\n";
    let cfg: FileConfig = serde_yaml::from_str(yaml).unwrap();
    assert!(cfg.root.is_empty());
    assert_eq!(cfg.port, Some(40704));
    assert_eq!(cfg.auth_token(), "coconote");
    // Resolves to zero roots with no filesystem poking, no errors.
    let resolved = cfg.root_configs().unwrap();
    assert!(resolved.is_empty());
}

#[test]
fn forbidden_roots_rejected() {
    // welcome.md: refuse system trees, raw or as a subtree, even when
    // canonicalize folds a macOS symlink to its /private form.
    let mut sys = FileConfig::default();
    sys.root.insert("sys".into(), "/etc".into());
    assert!(sys.root_configs().is_err());

    let mut subtree = FileConfig::default();
    subtree.root.insert("sub".into(), "/usr/local/share".into());
    assert!(subtree.root_configs().is_err());

    // A normal absolute path outside the system trees is accepted.
    std::env::set_var("HOME", "/h");
    let mut ok = FileConfig::default();
    ok.root.insert("notes".into(), "~/notes".into());
    assert!(ok.root_configs().is_ok());
}
