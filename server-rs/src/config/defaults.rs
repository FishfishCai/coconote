// First-boot provisioning: guarantee a parseable coconote.yaml in the
// effective config dir so the server always starts (welcome.md, setting.md
// Config file).

use super::{effective_config_dir, FileConfig, DEFAULT_AUTH, DEFAULT_PORT};
use crate::error::{Error, Result};
use std::path::PathBuf;

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
         # Add local roots via Setting -> Local, or list them under `root:` here.\n\
         port: {DEFAULT_PORT}\n\
         auth: {DEFAULT_AUTH}\n\
         root:\n"
    );
    std::fs::write(&yaml_path, body)
        .map_err(|e| Error::Other(format!("write {}: {e}", yaml_path.display())))?;
    Ok(yaml_path)
}
