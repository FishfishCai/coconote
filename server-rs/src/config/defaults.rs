// First-boot provisioning: guarantee a parseable coconote.yaml in the
// effective config dir so the server always starts (SPEC-redesign config).

use super::{standard_config_dir, FileConfig, DEFAULT_AUTH, DEFAULT_PORT, DEFAULT_RECENT_LIMIT};
use crate::error::{Error, Result};
use std::path::PathBuf;

/// Ensure a usable `coconote.yaml` in the effective config dir (first
/// launch, or a Config-file redirect to a dir with no or broken yaml) so the
/// server always boots. An unparseable yaml is first renamed to
/// `coconote.yaml.bak` (best-effort) so user content is never silently
/// destroyed. The file-centric model has no roots: a fresh config starts
/// with empty recent / pin lists.
pub fn ensure_default_config() -> Result<PathBuf> {
    let dir = standard_config_dir()
        .ok_or_else(|| Error::Other("no $HOME / %APPDATA% to host default config".into()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Other(format!("mkdir {}: {e}", dir.display())))?;
    let yaml_path = dir.join("coconote.yaml");
    if let Ok(bytes) = std::fs::read(&yaml_path) {
        if serde_yaml::from_slice::<FileConfig>(&bytes).is_ok() {
            return Ok(yaml_path);
        }
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
         port: {DEFAULT_PORT}\n\
         auth: {DEFAULT_AUTH}\n\
         recent_limit: {DEFAULT_RECENT_LIMIT}\n\
         url:\n\
         watch:\n\
         recent:\n\
         pin:\n"
    );
    std::fs::write(&yaml_path, body)
        .map_err(|e| Error::Other(format!("write {}: {e}", yaml_path.display())))?;
    Ok(yaml_path)
}
