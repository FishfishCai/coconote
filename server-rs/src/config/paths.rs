// Where coconote.yaml lives: the standard per-user config dir, an optional
// redirect via the `config-path` pointer file (Setting -> Config file), and
// `~` expansion for root paths (welcome.md).

use crate::error::{Error, Result};
use std::path::PathBuf;

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
    if trimmed.is_empty() {
        return None;
    }
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
        if p.exists() {
            std::fs::remove_file(&p)?;
        }
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
