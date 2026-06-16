// coconote.yaml, the only on-disk config (welcome.md): port (default 40704),
// auth (bearer token, default "coconote", loopback bypasses), root ({name ->
// path}, absolute local roots), url (remote coconote URLs mounted into the
// vault). IndexMap preserves the user's yaml ordering on round-trip.
//
// This module holds the FileConfig schema and its root validation. Path
// resolution (config dir, pointer file, `~` expansion) lives in paths, and
// first-boot provisioning in defaults.

mod defaults;
mod paths;

pub use defaults::ensure_default_config;
pub use paths::{effective_config_dir, expand_user, standard_config_dir, write_config_pointer};

use crate::error::{Error, Result};
use crate::space::RootConfig;
use indexmap::IndexMap;
use serde::Deserialize;
use std::path::Path;

/// Default bearer token when `auth:` is absent in coconote.yaml.
pub const DEFAULT_AUTH: &str = "coconote";

/// Default HTTP listen port (welcome.md).
pub const DEFAULT_PORT: u16 = 40704;

/// Dangerous mount points rejected at config parse time (welcome.md).
const FORBIDDEN_ROOTS: &[&str] = &[
    "/", "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/System",
    "/Library",
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
                        "root '{name}' must be an absolute path (got '{path}')"
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

/// Reject system mount points and their subtrees (welcome.md). macOS
/// canonicalizes `/etc` to `/private/etc`, so a leading `/private` is folded
/// away before matching; the caller checks both raw and canonical forms so a
/// symlink into a system tree is caught either way.
fn check_forbidden(path: &Path, name: &str) -> Result<()> {
    let p = path.to_string_lossy();
    let p: &str = &p;
    let norm = p
        .strip_prefix("/private")
        .filter(|rest| rest.starts_with('/'))
        .unwrap_or(p);
    for bad in FORBIDDEN_ROOTS {
        // `/` matches only itself (its subtree is everything); the rest
        // also reject any path inside the tree.
        if norm == *bad || (*bad != "/" && norm.starts_with(&format!("{bad}/"))) {
            return Err(Error::Other(format!(
                "root {name:?}: refusing to mount system path {bad} (got {p})"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
