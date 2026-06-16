// On-disk writes for /.config: the snippet.json sidecar, the atomic
// (tmp + rename) yaml writer, and yaml serialization with proper quoting.

use crate::config::FileConfig;
use crate::error::{Error, Result};
use indexmap::IndexMap;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Read the snippet.json sidecar (editor.md Snippet, same lookup path
/// as coconote.yaml). Missing file -> empty string.
pub(super) fn read_snippets_file(yaml_path: Option<&Path>) -> Result<String> {
    let p = snippets_path_for(yaml_path);
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(Error::Io(e)),
    }
}

/// Atomically replace the snippet.json sidecar. Empty string removes it.
pub(super) fn write_snippets_file(yaml_path: Option<&Path>, content: &str) -> Result<()> {
    let p = snippets_path_for(yaml_path);
    if content.is_empty() {
        if p.exists() {
            std::fs::remove_file(&p)?;
        }
        return Ok(());
    }
    write_atomically(&p, content.as_bytes())
}

/// snippet.json lives next to coconote.yaml. With no yaml on disk it
/// lives in CWD too, matching the yaml fallback.
fn snippets_path_for(yaml_path: Option<&Path>) -> PathBuf {
    match yaml_path {
        Some(p) => p.with_file_name("snippet.json"),
        None => PathBuf::from("snippet.json"),
    }
}

pub(super) fn write_yaml_atomically(target: Option<&Path>, cfg: &FileConfig) -> Result<()> {
    // `None` = booted without a yaml (--folder mode, which bypasses
    // config resolution). Persisting a ./coconote.yaml no later boot
    // would read just litters the CWD: mutations stay in-process only.
    let Some(path) = target else {
        return Ok(());
    };
    let body = serialize_config(cfg)?;
    write_atomically(path, body.as_bytes())
}

/// tmp + rename in the destination dir so readers never observe a torn
/// file. pid + 64-bit random suffix so two simultaneous PATCHes in one
/// process don't truncate each other's tmp file.
fn write_atomically(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{:x}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("coconote"),
        std::process::id(),
        rand::random::<u64>(),
    ));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// Round-trip through serde_yaml so scalars with `:`, `#`, leading
// `*&@`, or whitespace are quoted. Hand-rolled string emit lost those.
fn serialize_config(cfg: &FileConfig) -> Result<String> {
    #[derive(Serialize)]
    struct Wire<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth: Option<&'a str>,
        #[serde(skip_serializing_if = "IndexMap::is_empty")]
        root: &'a IndexMap<String, String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        url: &'a Vec<String>,
    }
    let wire = Wire {
        port: cfg.port,
        auth: cfg.auth.as_deref().filter(|s| !s.is_empty()),
        root: &cfg.root,
        url: &cfg.url,
    };
    serde_yaml::to_string(&wire).map_err(|e| Error::Other(format!("yaml emit: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_round_trips_scalars_needing_quotes() {
        let mut cfg = FileConfig::default();
        cfg.port = Some(40704);
        cfg.auth = Some("p@ss: word".into());
        cfg.root.insert("notes".into(), "/has: colon # hash".into());
        let yaml = serialize_config(&cfg).unwrap();
        let back: FileConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.port, Some(40704));
        assert_eq!(back.auth.as_deref(), Some("p@ss: word"));
        assert_eq!(back.root["notes"], "/has: colon # hash");
    }

    #[test]
    fn serialize_omits_empty_sections() {
        let yaml = serialize_config(&FileConfig::default()).unwrap();
        assert!(!yaml.contains("root:"));
        assert!(!yaml.contains("url:"));
        assert!(!yaml.contains("port:"));
    }
}
