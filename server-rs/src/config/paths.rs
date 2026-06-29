// Where coconote.yaml lives: the standard per-user config dir. The Setting
// -> Config-file redirect (pointer file + self-restart) was removed: it is
// not in design.md.

use std::path::PathBuf;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Directory where `coconote.yaml` lives: the per-user config dir,
/// `~/.config/coconote/` on macOS/Linux (XDG-style even on macOS, respects
/// `$XDG_CONFIG_HOME`), `%APPDATA%\coconote\` on Windows.
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
