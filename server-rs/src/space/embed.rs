// Embedded client bundle. include_dir! bakes everything under
// $CARGO_MANIFEST_DIR/embed/client at compile time. Read-only by
// construction, and the SSR fallback is the only consumer.

use crate::error::{Error, Result};
use crate::types::{Entry, EntryType, Perm};

use include_dir::{include_dir, Dir};

static CLIENT_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/embed/client");

pub struct EmbeddedReadOnlySpacePrimitives {
    timestamp_ms: i64,
}

impl EmbeddedReadOnlySpacePrimitives {
    pub fn new(timestamp_ms: i64) -> Self {
        Self { timestamp_ms }
    }

    fn entry(&self, path: &str, size: i64) -> Entry {
        Entry {
            kind: EntryType::File,
            path: path.to_string(),
            size,
            mtime: self.timestamp_ms,
            perm: Perm::Ro,
            ..Default::default()
        }
    }

    pub async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let key = path.trim_start_matches('/');
        let f = CLIENT_DIR.get_file(key).ok_or(Error::NotFound)?;
        let data = f.contents().to_vec();
        let e = self.entry(key, data.len() as i64);
        Ok((data, e))
    }
}
