// coconote.yaml, the only on-disk config (design.md "config file"). Decided
// PAIRS schema:
//
//   port: 40704                 # HTTP / WS port
//   auth: coconote              # THIS instance's own bearer token
//   recent_limit: 1024          # recent-list cap N
//   url:                        # remote instances = (url, auth) pairs
//     - url: https://...
//       auth: their-token
//   watch:                      # optional dir roots to scan / track
//     - /Users/me/notes
//   recent:                     # (id, path) pairs, MRU, capped
//     - id: xsx7pgxrgx7zkc67
//       path: /Users/me/notes/foo.md
//   pin:                        # (id, path) pairs, never evicted
//     - id: k3p9m2qr8tdw1xfa
//       path: /Users/me/notes/bar.md
//
// The (id, path) pair powers id-relocation: path is the hint, id is identity.
// recent / pin entries are dropped only when the file is gone AND cannot be
// relocated by id (handled by `reconcile_entries` once the resolver exists).
// UI prefs do not live here -> browser localStorage.
//
// This module holds the FileConfig schema. Path resolution (config dir, `~`
// expansion) lives in paths, first-boot provisioning in defaults.

mod defaults;
mod paths;

pub use defaults::ensure_default_config;
pub use paths::standard_config_dir;

use crate::error::{Error, Result};
use crate::meta;
use crate::resolver::Resolver;
use crate::util::is_valid_id;
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Default bearer token when `auth:` is absent.
pub const DEFAULT_AUTH: &str = "coconote";

/// Default HTTP listen port.
pub const DEFAULT_PORT: u16 = 40704;

/// Default recent-list cap when `recent_limit:` is absent.
pub const DEFAULT_RECENT_LIMIT: usize = 1024;

/// A remote coconote instance: its url and the bearer token to reach it.
/// Deserializes from either a `{url, auth}` map or a bare url string (legacy
/// / shorthand), serializes as a map (with `auth` omitted when empty).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct UrlEntry {
    pub url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub auth: String,
}

impl<'de> Deserialize<'de> for UrlEntry {
    fn deserialize<D>(d: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Bare(String),
            Pair {
                #[serde(default)]
                url: String,
                #[serde(default)]
                auth: String,
            },
        }
        match Repr::deserialize(d)? {
            Repr::Bare(url) => Ok(UrlEntry { url, auth: String::new() }),
            Repr::Pair { url, auth } => Ok(UrlEntry { url, auth }),
        }
    }
}

/// A tracked file: its id (identity) and last-known path (relocation hint).
/// Deserializes from either an `{id, path}` map or a bare path string (legacy
/// path-only entry, whose id is filled from disk during reconciliation).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FileRef {
    pub id: String,
    pub path: String,
}

impl<'de> Deserialize<'de> for FileRef {
    fn deserialize<D>(d: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Bare(String),
            Pair {
                #[serde(default)]
                id: String,
                #[serde(default)]
                path: String,
            },
        }
        match Repr::deserialize(d)? {
            Repr::Bare(path) => Ok(FileRef { id: String::new(), path }),
            Repr::Pair { id, path } => Ok(FileRef { id, path }),
        }
    }
}

// No deny_unknown_fields: a stray key must not make the file unparseable, or
// ensure_default_config would replace the user's config wholesale.
#[derive(Debug, Default, Deserialize)]
pub struct FileConfig {
    /// `None` -> built-in default. `Some(0)` -> explicit ephemeral port.
    #[serde(default)]
    pub port: Option<u16>,
    /// THIS instance's own bearer token.
    #[serde(default)]
    pub auth: Option<String>,
    /// Remote instances as (url, auth) pairs.
    #[serde(default)]
    pub url: Vec<UrlEntry>,
    /// Optional dir roots the server scans at boot and relocates within.
    #[serde(default)]
    pub watch: Vec<String>,
    /// Most-recently-used files as (id, path) pairs, newest first.
    #[serde(default)]
    pub recent: Vec<FileRef>,
    /// Recent-list cap N. None -> DEFAULT_RECENT_LIMIT.
    #[serde(default)]
    pub recent_limit: Option<usize>,
    /// Pinned files as (id, path) pairs (also remote entry points).
    #[serde(default)]
    pub pin: Vec<FileRef>,
}

impl FileConfig {
    /// Ok(None) when the file is absent, parse errors bubble up. No on-load
    /// pruning: relocation needs the resolver, so dead-entry cleanup happens
    /// in `reconcile_entries` during boot.
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

    /// Bearer token for handlers. Defaults to "coconote" when absent.
    pub fn auth_token(&self) -> String {
        self.auth
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_AUTH)
            .to_string()
    }

    /// Effective recent-list cap.
    pub fn recent_limit(&self) -> usize {
        self.recent_limit.unwrap_or(DEFAULT_RECENT_LIMIT)
    }

    /// Valid recent ids (for the boundary entry set).
    pub fn recent_ids(&self) -> Vec<String> {
        self.recent.iter().filter(|r| is_valid_id(&r.id)).map(|r| r.id.clone()).collect()
    }

    /// Valid pin ids (for the boundary entry set).
    pub fn pin_ids(&self) -> Vec<String> {
        self.pin.iter().filter(|r| is_valid_id(&r.id)).map(|r| r.id.clone()).collect()
    }

    /// (id, path) seeds the resolver indexes at boot (recent then pin).
    pub fn seeds(&self) -> Vec<(String, String)> {
        self.recent
            .iter()
            .chain(self.pin.iter())
            .map(|r| (r.id.clone(), r.path.clone()))
            .collect()
    }

    /// Serialize to yaml. Round-trips through serde so scalars needing quotes
    /// (`:`, `#`, leading `*&@`, whitespace) are escaped, and empty sections
    /// are omitted. The single serializer for both boot's reconcile-persist
    /// and PATCH /.config.
    pub fn to_yaml(&self) -> Result<String> {
        #[derive(Serialize)]
        struct Wire<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            port: Option<u16>,
            #[serde(skip_serializing_if = "Option::is_none")]
            auth: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            recent_limit: Option<usize>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            url: &'a Vec<UrlEntry>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            watch: &'a Vec<String>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            recent: &'a Vec<FileRef>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            pin: &'a Vec<FileRef>,
        }
        let wire = Wire {
            port: self.port,
            auth: self.auth.as_deref().filter(|s| !s.is_empty()),
            recent_limit: self.recent_limit,
            url: &self.url,
            watch: &self.watch,
            recent: &self.recent,
            pin: &self.pin,
        };
        serde_yaml::to_string(&wire).map_err(|e| Error::Other(format!("yaml emit: {e}")))
    }

    /// Atomically write the config to `path`.
    pub fn save(&self, path: &Path) -> Result<()> {
        crate::util::write_atomic(path, self.to_yaml()?.as_bytes())
    }
}

/// Reconcile a recent/pin list against the resolver (design.md file
/// tracking): fill a missing id from disk (legacy path-only entries), update
/// a relocated path, and drop an entry whose file is gone and unrelocatable.
/// Returns true when anything changed (so boot can persist the cleaned list).
pub fn reconcile_entries(resolver: &Resolver, entries: &mut Vec<FileRef>) -> bool {
    let mut changed = false;
    entries.retain_mut(|e| {
        if !is_valid_id(&e.id) {
            match meta::read_id(&e.path) {
                Some(id) => {
                    e.id = id;
                    changed = true;
                }
                None => {
                    changed = true;
                    return false; // no id, no file -> unusable
                }
            }
        }
        match resolver.resolve(&e.id) {
            Some(p) if p != e.path => {
                e.path = p;
                changed = true;
                true
            }
            Some(_) => true,
            None => {
                changed = true;
                false // deleted and unrelocatable -> drop
            }
        }
    });
    changed
}

#[cfg(test)]
mod tests;
