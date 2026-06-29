// Access boundary (design.md "server API" / "push & remote access"). Files
// are addressed by id; remote reachability is decided per request over IDS:
//
//   - Loopback (127.0.0.1): every id (and path) is reachable. The desktop app
//     and same-host scripts open anything. (Path addressing is loopback-only;
//     the auth middleware rejects a remote `?path=`.)
//   - Remote: an id is reachable only when it lies in the transitive closure
//     of the entry set (recent + pin ids) following each file's `refs` (which
//     are ids). pin is the act of publishing a starting point to remote
//     viewers.
//
// The closure walks `refs` through the resolver: starting from the entry ids,
// resolve each id to its file, read its `refs` (ids), and follow them until no
// new id appears. The request id passes iff it lands in that set.

use crate::resolver::Resolver;
use std::collections::HashSet;

/// Decide whether `req_id` is reachable. `loopback` short-circuits to allow,
/// otherwise the (recent + pin) refs closure gates it.
pub fn is_allowed(
    req_id: &str,
    loopback: bool,
    recent: &[String],
    pin: &[String],
    resolver: &Resolver,
) -> bool {
    if loopback {
        return true;
    }
    id_closure(recent, pin, resolver).contains(req_id)
}

/// Transitive closure of the entry ids over `refs`. The entry ids are always
/// included (even if currently unresolvable); a dangling id simply 404s at the
/// file layer.
pub fn id_closure(recent: &[String], pin: &[String], resolver: &Resolver) -> HashSet<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    for id in recent.iter().chain(pin.iter()) {
        if seen.insert(id.clone()) {
            stack.push(id.clone());
        }
    }
    while let Some(cur) = stack.pop() {
        for r in resolver.refs_of(&cur) {
            if seen.insert(r.clone()) {
                stack.push(r);
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_md(d: &TempDir, name: &str, id: &str, refs: &[&str]) {
        let refs_yaml = if refs.is_empty() {
            String::new()
        } else {
            format!("refs: [{}]\n", refs.join(", "))
        };
        fs::write(
            d.path().join(name),
            format!("---\nid: {id}\ntitle: {name}\n{refs_yaml}---\nbody\n"),
        )
        .unwrap();
    }

    fn resolver_over(d: &TempDir) -> Resolver {
        let r = Resolver::new(vec![d.path().to_string_lossy().into_owned()]);
        r.boot_scan(&[]);
        r
    }

    #[test]
    fn loopback_allows_anything() {
        let d = TempDir::new().unwrap();
        let r = resolver_over(&d);
        assert!(is_allowed("anyid00000000000", true, &[], &[], &r));
    }

    #[test]
    fn remote_denies_outside_closure() {
        let d = TempDir::new().unwrap();
        write_md(&d, "entry.md", "entry00000000000", &[]);
        write_md(&d, "secret.md", "secret0000000000", &[]);
        let r = resolver_over(&d);
        let recent = vec!["entry00000000000".to_string()];
        assert!(is_allowed("entry00000000000", false, &recent, &[], &r));
        assert!(!is_allowed("secret0000000000", false, &recent, &[], &r));
    }

    #[test]
    fn remote_follows_refs_transitively() {
        let d = TempDir::new().unwrap();
        write_md(&d, "a.md", "aaaa0000aaaa0000", &["bbbb0000bbbb0000"]);
        write_md(&d, "b.md", "bbbb0000bbbb0000", &["cccc0000cccc0000"]);
        write_md(&d, "c.md", "cccc0000cccc0000", &[]);
        let r = resolver_over(&d);
        let recent = vec!["aaaa0000aaaa0000".to_string()];
        for id in ["aaaa0000aaaa0000", "bbbb0000bbbb0000", "cccc0000cccc0000"] {
            assert!(is_allowed(id, false, &recent, &[], &r), "{id} reachable");
        }
    }

    #[test]
    fn pin_is_an_entry_point() {
        let d = TempDir::new().unwrap();
        write_md(&d, "pinned.md", "pinned0000000000", &[]);
        let r = resolver_over(&d);
        let pin = vec!["pinned0000000000".to_string()];
        assert!(is_allowed("pinned0000000000", false, &[], &pin, &r));
    }

    #[test]
    fn pdf_in_closure_has_no_outgoing_refs() {
        // A pinned md links to a pdf; the pdf is reachable, but a pdf carries
        // no refs, so the closure does not expand past it.
        let d = TempDir::new().unwrap();
        write_md(&d, "note.md", "note000000000000", &["paper0000000000a"]);
        fs::write(d.path().join("paper.pdf"), b"%PDF").unwrap();
        fs::create_dir_all(d.path().join(".paper.assets")).unwrap();
        fs::write(
            d.path().join(".paper.assets/paper.json"),
            r#"{"metadata":{"id":"paper0000000000a","title":"Paper"}}"#,
        )
        .unwrap();
        write_md(&d, "unrelated.md", "unrelated0000000", &[]);
        let r = resolver_over(&d);
        let pin = vec!["note000000000000".to_string()];
        assert!(is_allowed("note000000000000", false, &[], &pin, &r));
        assert!(is_allowed("paper0000000000a", false, &[], &pin, &r), "pdf reachable via md ref");
        assert!(!is_allowed("unrelated0000000", false, &[], &pin, &r), "no path to unrelated");
    }
}
