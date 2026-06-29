// Embedded client bundle. include_dir! bakes everything under
// $CARGO_MANIFEST_DIR/embed/client at compile time. Read-only by
// construction, and the SSR fallback is the only consumer.

use crate::error::{Error, Result};

use include_dir::{include_dir, Dir};

static CLIENT_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/embed/client");

/// Reader over the compiled-in client bundle. Holds nothing: lookups go
/// straight to the static `include_dir` tree.
#[derive(Clone, Copy, Default)]
pub struct ClientBundle;

impl ClientBundle {
    pub fn new() -> Self {
        Self
    }

    /// Bytes of an embedded asset, NotFound when absent. A leading `/` is
    /// trimmed so both `/index.html` and `index.html` resolve.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let key = path.trim_start_matches('/');
        let f = CLIENT_DIR.get_file(key).ok_or(Error::NotFound)?;
        Ok(f.contents().to_vec())
    }
}
