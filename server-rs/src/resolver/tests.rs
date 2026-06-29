use super::*;
use tempfile::TempDir;

fn write_md(dir: &Path, name: &str, id: &str, title: &str, refs: &[&str]) -> String {
    let refs_yaml = if refs.is_empty() {
        String::new()
    } else {
        format!("refs: [{}]\n", refs.join(", "))
    };
    let body = format!("---\nid: {id}\ntitle: {title}\n{refs_yaml}---\nbody\n");
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&p, body).unwrap();
    p.to_string_lossy().into_owned()
}

fn resolver_over(root: &Path) -> Resolver {
    let r = Resolver::new(vec![root.to_string_lossy().into_owned()]);
    r.boot_scan(&[]);
    r
}

#[test]
fn add_root_indexes_new_watch_dir() {
    // A watch root added at runtime is scanned immediately: its files are
    // indexed (and resolvable) without a restart.
    let watched = TempDir::new().unwrap();
    let added = TempDir::new().unwrap();
    let r = resolver_over(watched.path());
    let p = write_md(added.path(), "n.md", "addedroot0000000", "Added", &[]);
    assert!(r.resolve("addedroot0000000").is_none(), "not indexed before add_root");
    r.add_root(&added.path().to_string_lossy());
    assert_eq!(r.resolve("addedroot0000000").as_deref(), Some(p.as_str()));
}

#[test]
fn add_and_remove_root_update_the_root_set() {
    let base = TempDir::new().unwrap();
    let extra = TempDir::new().unwrap();
    let r = resolver_over(base.path());
    assert_eq!(r.root_count(), 1);
    let extra_path = extra.path().to_string_lossy().into_owned();
    r.add_root(&extra_path);
    assert_eq!(r.root_count(), 2, "add_root records the new root");
    // Idempotent: re-adding an existing root does not duplicate it.
    r.add_root(&extra_path);
    assert_eq!(r.root_count(), 2, "re-adding an existing root is a no-op for the set");
    r.remove_root(&extra_path);
    assert_eq!(r.root_count(), 1, "remove_root drops it");
}

#[test]
fn boot_scan_indexes_and_resolves() {
    let d = TempDir::new().unwrap();
    let p = write_md(d.path(), "a.md", "aaaa1111aaaa1111", "Alpha", &[]);
    let r = resolver_over(d.path());
    assert_eq!(r.resolve("aaaa1111aaaa1111").as_deref(), Some(p.as_str()));
    assert!(r.resolve("nosuchid00000000").is_none());
}

#[test]
fn boot_scan_stamps_id_on_idless_file() {
    let d = TempDir::new().unwrap();
    std::fs::write(d.path().join("fresh.md"), b"---\ntitle: Fresh\n---\nbody").unwrap();
    let r = resolver_over(d.path());
    // The scan minted an id and indexed it.
    let ids = r.known_ids();
    assert_eq!(ids.len(), 1);
    assert!(crate::util::is_valid_id(&ids[0]));
    assert!(r.resolve(&ids[0]).unwrap().ends_with("fresh.md"));
}

#[test]
fn relocates_a_renamed_file() {
    let d = TempDir::new().unwrap();
    let old = write_md(d.path(), "old.md", "moveme0000000000", "Moved", &[]);
    let r = resolver_over(d.path());
    assert_eq!(r.resolve("moveme0000000000").as_deref(), Some(old.as_str()));
    // Rename on disk while "closed": the cached path is now stale.
    let new = d.path().join("sub/new.md");
    std::fs::create_dir_all(new.parent().unwrap()).unwrap();
    std::fs::rename(&old, &new).unwrap();
    let resolved = r.resolve("moveme0000000000").unwrap();
    assert_eq!(resolved, new.to_string_lossy());
    // The index now points at the new path (no second search needed).
    assert_eq!(
        r.index.read().unwrap().get("moveme0000000000").unwrap().path,
        new
    );
}

#[test]
fn deleted_file_resolves_to_none() {
    let d = TempDir::new().unwrap();
    let p = write_md(d.path(), "gone.md", "deletethis000000", "Gone", &[]);
    let r = resolver_over(d.path());
    std::fs::remove_file(&p).unwrap();
    assert!(r.resolve("deletethis000000").is_none());
}

#[test]
fn handle_path_event_indexes_a_new_file() {
    // A file created after boot (live watch event) is indexed proactively,
    // so index-only resolution (resolve_title, no fs search) sees it
    // without waiting for a lazy resolve().
    let d = TempDir::new().unwrap();
    let r = resolver_over(d.path()); // empty dir scanned at boot
    assert!(r.known_ids().is_empty(), "nothing indexed before the event");
    let p = write_md(d.path(), "fresh.md", "freshid000000000", "Fresh", &[]);
    r.handle_path_event(Path::new(&p));
    assert!(r.known_ids().contains(&"freshid000000000".to_string()), "indexed by the event");
    assert!(
        matches!(r.resolve_title("Fresh", None), TitleResolution::Single(ref id) if id == "freshid000000000"),
        "resolve_title finds the freshly watched file"
    );
}

#[test]
fn handle_path_event_forgets_a_deleted_file() {
    // A delete event drops the mapping (resolve_title no longer offers it).
    let d = TempDir::new().unwrap();
    let p = write_md(d.path(), "doomed.md", "doomedid00000000", "Doomed", &[]);
    let r = resolver_over(d.path());
    assert!(r.known_ids().contains(&"doomedid00000000".to_string()));
    std::fs::remove_file(&p).unwrap();
    r.handle_path_event(Path::new(&p));
    assert!(!r.known_ids().contains(&"doomedid00000000".to_string()), "forgotten on delete");
}

#[test]
fn handle_path_event_tracks_a_rename() {
    // A rename fires remove(old)+create(new); either order converges on
    // the new path for the same id.
    let d = TempDir::new().unwrap();
    let old = write_md(d.path(), "old.md", "renameid00000000", "Renamed", &[]);
    let r = resolver_over(d.path());
    let new = d.path().join("new.md");
    std::fs::rename(&old, &new).unwrap();
    r.handle_path_event(Path::new(&old)); // remove(old)
    r.handle_path_event(&new); // create(new)
    assert_eq!(
        r.resolve("renameid00000000").as_deref(),
        Some(new.to_string_lossy().as_ref())
    );
}

#[test]
fn handle_path_event_scans_a_moved_in_dir() {
    // A directory appearing under a watch root indexes its files.
    let d = TempDir::new().unwrap();
    let r = resolver_over(d.path());
    let sub = d.path().join("incoming");
    write_md(&sub, "note.md", "movedindir000000", "MovedIn", &[]);
    r.handle_path_event(&sub);
    assert!(r.resolve("movedindir000000").is_some(), "files under a new dir are indexed");
}

#[test]
fn seed_hint_outside_watch_root_resolves() {
    // A recent file outside any watch root is still resolvable via its
    // (id, path) seed.
    let watch = TempDir::new().unwrap();
    let elsewhere = TempDir::new().unwrap();
    let p = write_md(elsewhere.path(), "outside.md", "outsideid0000000", "Outside", &[]);
    let r = Resolver::new(vec![watch.path().to_string_lossy().into_owned()]);
    r.boot_scan(&[("outsideid0000000".to_string(), p.clone())]);
    assert_eq!(r.resolve("outsideid0000000").as_deref(), Some(p.as_str()));
}

#[test]
fn title_resolves_single_and_ambiguous() {
    let d = TempDir::new().unwrap();
    write_md(d.path(), "u.md", "uniqueid00000000", "Unique", &[]);
    write_md(d.path(), "d1.md", "dupid10000000000", "Dup", &["x"]);
    // Two files share the title "Dup" but differ by tag.
    let dup2 = d.path().join("d2.md");
    std::fs::write(
        &dup2,
        "---\nid: dupid20000000000\ntitle: Dup\ntags: [paper]\n---\nb",
    )
    .unwrap();
    let d1 = d.path().join("d1.md");
    std::fs::write(
        &d1,
        "---\nid: dupid10000000000\ntitle: Dup\ntags: [note]\n---\nb",
    )
    .unwrap();
    let r = resolver_over(d.path());

    match r.resolve_title("Unique", None) {
        TitleResolution::Single(id) => assert_eq!(id, "uniqueid00000000"),
        _ => panic!("Unique must resolve to a single id"),
    }
    match r.resolve_title("Dup", None) {
        TitleResolution::Candidates(c) => assert_eq!(c.len(), 2, "Dup is ambiguous"),
        _ => panic!("Dup must be ambiguous"),
    }
    // tag/title disambiguates to one.
    match r.resolve_title("paper/Dup", None) {
        TitleResolution::Single(id) => assert_eq!(id, "dupid20000000000"),
        _ => panic!("paper/Dup must resolve to a single id"),
    }
    // Missing title -> empty candidate list.
    match r.resolve_title("Nope", None) {
        TitleResolution::Candidates(c) => assert!(c.is_empty()),
        _ => panic!("missing title must be empty candidates"),
    }
}

#[test]
fn title_respects_allowed_filter() {
    let d = TempDir::new().unwrap();
    write_md(d.path(), "a.md", "allowedid0000000", "Same", &[]);
    let b = d.path().join("b.md");
    std::fs::write(&b, "---\nid: blockedid0000000\ntitle: Same\n---\nb").unwrap();
    let r = resolver_over(d.path());
    // Without a filter, "Same" is ambiguous (2 files).
    assert!(matches!(
        r.resolve_title("Same", None),
        TitleResolution::Candidates(c) if c.len() == 2
    ));
    // Restricting to one allowed id makes it a single hit.
    let allowed: HashSet<String> = ["allowedid0000000".to_string()].into_iter().collect();
    match r.resolve_title("Same", Some(&allowed)) {
        TitleResolution::Single(id) => assert_eq!(id, "allowedid0000000"),
        _ => panic!("allowed filter must narrow to a single id"),
    }
}

#[test]
fn refs_of_reads_markdown_links() {
    let d = TempDir::new().unwrap();
    write_md(d.path(), "a.md", "aaaa0000aaaa0000", "A", &["bbbb0000bbbb0000"]);
    write_md(d.path(), "b.md", "bbbb0000bbbb0000", "B", &[]);
    let r = resolver_over(d.path());
    assert_eq!(r.refs_of("aaaa0000aaaa0000"), vec!["bbbb0000bbbb0000"]);
    assert!(r.refs_of("bbbb0000bbbb0000").is_empty());
}
