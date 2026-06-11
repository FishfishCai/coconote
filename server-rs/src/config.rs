// coconote.yaml, the only on-disk config (welcome.md): port (default 40704),
// auth (bearer token, default "coconote", loopback bypasses), root ({name ->
// path}, absolute local roots), url (remote coconote URLs mounted into the
// vault). Lives in the per-user config dir (see effective_config_dir).
// IndexMap preserves the user's yaml ordering on round-trip.

use crate::error::{Error, Result};
use crate::space::RootConfig;

use indexmap::IndexMap;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Default bearer token when `auth:` is absent in coconote.yaml.
pub const DEFAULT_AUTH: &str = "coconote";

/// Default HTTP listen port (welcome.md).
pub const DEFAULT_PORT: u16 = 40704;

/// Dangerous mount points rejected at config parse time (welcome.md).
const FORBIDDEN_ROOTS: &[&str] = &[
    "/", "/etc", "/var", "/usr", "/bin", "/sbin",
    "/boot", "/proc", "/sys", "/dev", "/System", "/Library",
];

// No deny_unknown_fields: a stray key (e.g. a `roots:` typo) must not make
// the file unparseable, or ensure_default_config would replace the user's
// config wholesale.
#[derive(Debug, Default, Deserialize)]
pub struct FileConfig {
    /// `None` -> built-in default. `Some(0)` -> explicit ephemeral port
    /// (test harnesses).
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub root: IndexMap<String, String>,
    #[serde(default)]
    pub url: Vec<String>,
}

impl FileConfig {
    /// Ok(None) when the file is absent, parse errors bubble up.
    pub fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(data) => {
                let cfg: FileConfig = serde_yaml::from_slice(&data)
                    .map_err(|e| Error::Other(format!("parse {}: {e}", path.display())))?;
                Ok(Some(cfg))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    /// Bearer token for handlers. Defaults to "coconote" when the field
    /// is absent: spec says auth is required.
    pub fn auth_token(&self) -> String {
        self.auth
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_AUTH)
            .to_string()
    }

    /// Resolve the YAML `root:` map into RootConfigs. Forbidden-list check
    /// runs on BOTH raw and canonical forms so macOS symlinks (`/etc` ->
    /// `/private/etc`) can't smuggle a system path through (welcome.md).
    pub fn root_configs(&self) -> Result<Vec<RootConfig>> {
        self.root
            .iter()
            .map(|(name, path)| {
                let expanded = expand_user(path)?;
                // welcome.md: "Local roots must be absolute paths" - a
                // relative entry would silently resolve against the CWD.
                // Single validation point for PATCH /.config and
                // hand-edited yaml.
                if !expanded.is_absolute() {
                    return Err(Error::BadRequest(format!(
                        "root '{name}' must be an absolute path (got '{}')",
                        path
                    )));
                }
                check_forbidden(&expanded, name)?;
                let canonical = std::fs::canonicalize(&expanded).unwrap_or(expanded.clone());
                check_forbidden(&canonical, name)?;
                Ok(RootConfig {
                    name: name.clone(),
                    path: canonical,
                })
            })
            .collect()
    }
}

fn check_forbidden(path: &Path, name: &str) -> Result<()> {
    let p = path.to_string_lossy();
    for bad in FORBIDDEN_ROOTS {
        if p == *bad {
            return Err(Error::Other(format!(
                "root {name:?}: refusing to mount system path {p}"
            )));
        }
        // Subtree: `/etc/whatever` is also rejected (e.g. a symlink
        // resolved into the system tree). `/` would catch everything,
        // skip it for the subtree check.
        if *bad != "/" {
            let prefix = format!("{bad}/");
            if p.starts_with(&prefix) {
                return Err(Error::Other(format!(
                    "root {name:?}: refusing to mount path inside system tree {bad}: {p}"
                )));
            }
        }
        // macOS symlinks `/etc -> /private/etc`, `/var -> /private/var`:
        // canonicalize() lands at the private/ form, which the welcome.md
        // list doesn't enumerate verbatim. Treat it as the underlying
        // system path so a symlink can't smuggle a forbidden root past
        // (welcome.md: "Symlinks are resolved before validation").
        let private_form = format!("/private{bad}");
        if p == private_form {
            return Err(Error::Other(format!(
                "root {name:?}: refusing to mount system path {p} (symlink -> {bad})"
            )));
        }
        let private_subtree = format!("/private{bad}/");
        if p.starts_with(&private_subtree) {
            return Err(Error::Other(format!(
                "root {name:?}: refusing to mount path inside system tree {bad}: {p}"
            )));
        }
    }
    Ok(())
}

/// Leading `~` expands to $HOME.
pub fn expand_user(p: &str) -> Result<PathBuf> {
    if p == "~" {
        return home_dir().ok_or_else(|| Error::Other("no $HOME".into()));
    }
    if let Some(rest) = p.strip_prefix("~/") {
        let home = home_dir().ok_or_else(|| Error::Other("no $HOME".into()))?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(p))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Directory where `coconote.yaml` lives. The pointer file `<standard
/// config dir>/config-path` (set by Setting -> Config file) redirects the
/// lookup, otherwise the standard per-user config dir (welcome.md).
pub fn effective_config_dir() -> Option<PathBuf> {
    read_config_pointer().or_else(standard_config_dir)
}

/// Pointer file lives at the standard dir so it stays discoverable even
/// after a redirect.
fn config_pointer_path() -> Option<PathBuf> {
    standard_config_dir().map(|d| d.join("config-path"))
}

/// Pointer file as a directory path. Empty / missing / unreadable -> None.
fn read_config_pointer() -> Option<PathBuf> {
    let p = config_pointer_path()?;
    let raw = std::fs::read_to_string(&p).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }
    Some(PathBuf::from(trimmed))
}

/// Write the pointer file, clearing it when the value is empty or equals
/// the standard config dir. Creates the standard dir if missing so the
/// write doesn't fail on a fresh machine.
pub fn write_config_pointer(dir: &str) -> Result<()> {
    let p = config_pointer_path()
        .ok_or_else(|| Error::Other("no $HOME / %APPDATA% to host config pointer".into()))?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let trimmed = dir.trim();
    let clear = trimmed.is_empty()
        || standard_config_dir().map_or(false, |d| d == PathBuf::from(trimmed));
    if clear {
        if p.exists() { std::fs::remove_file(&p)?; }
    } else {
        std::fs::write(&p, trimmed)?;
    }
    Ok(())
}

/// Per-user config dir: `~/.config/coconote/` on macOS/Linux (XDG-style
/// even on macOS, respects `$XDG_CONFIG_HOME`), `%APPDATA%\coconote\` on
/// Windows.
pub fn standard_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("coconote"))
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Some(PathBuf::from(xdg).join("coconote"));
            }
        }
        home_dir().map(|h| h.join(".config").join("coconote"))
    }
}

/// Ensure a usable `coconote.yaml` in the effective config dir (first
/// launch, or a Setting -> Config file redirect to a dir with no or broken
/// yaml) so the server always boots. An unparseable yaml is first renamed
/// to `coconote.yaml.bak` (best-effort) so user content is never silently
/// destroyed. The default has NO roots: the user adds them via Setting ->
/// Local at runtime, so we don't guess where notes live or create a
/// throwaway folder. The server starts fine with an empty space.
pub fn ensure_default_config() -> Result<PathBuf> {
    let dir = effective_config_dir()
        .ok_or_else(|| Error::Other("no $HOME / %APPDATA% to host default config".into()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Other(format!("mkdir {}: {e}", dir.display())))?;
    let yaml_path = dir.join("coconote.yaml");
    if let Ok(bytes) = std::fs::read(&yaml_path) {
        // Exists and parses: leave it alone.
        if serde_yaml::from_slice::<FileConfig>(&bytes).is_ok() {
            return Ok(yaml_path);
        }
        // Present but broken: keep the bytes around as .bak.
        let bak = yaml_path.with_extension("yaml.bak");
        match std::fs::rename(&yaml_path, &bak) {
            Ok(()) => tracing::warn!(
                "coconote.yaml is unparseable; kept as {} and recreated with defaults",
                bak.display()
            ),
            Err(e) => tracing::warn!("could not back up broken coconote.yaml: {e}"),
        }
    }
    let body = format!(
        "# Auto-created. Edit freely; restart to apply.\n\
         # Add local roots via Setting \u{2192} Local, or list them under `root:` here.\n\
         port: {DEFAULT_PORT}\n\
         auth: {DEFAULT_AUTH}\n\
         root:\n"
    );
    std::fs::write(&yaml_path, body)
        .map_err(|e| Error::Other(format!("write {}: {e}", yaml_path.display())))?;
    Ok(yaml_path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let cfg: FileConfig =
            serde_yaml::from_str("auth: hunter2\nroots:\n  main: /x\n").unwrap();
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
}
