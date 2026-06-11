// Embedded client bundle. include_dir! bakes everything under
// $CARGO_MANIFEST_DIR/embed/client at compile time. Reads route through
// SpacePrimitives; writes always fail.

use crate::error::{Error, Result};
use crate::types::{Entry, EntryType, Perm, SpacePrimitives};

use async_trait::async_trait;
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

    fn collect(dir: &Dir<'_>, out: &mut Vec<(String, usize)>) {
        for file in dir.files() {
            let p = file.path().to_string_lossy().replace('\\', "/");
            if p.ends_with(".placeholder") {
                continue;
            }
            out.push((p, file.contents().len()));
        }
        for sub in dir.dirs() {
            Self::collect(sub, out);
        }
    }
}

#[async_trait]
impl SpacePrimitives for EmbeddedReadOnlySpacePrimitives {
    async fn fetch_file_list_all(&self, _include_excluded: bool) -> Result<Vec<Entry>> {
        let mut all = Vec::new();
        Self::collect(&CLIENT_DIR, &mut all);
        Ok(all
            .into_iter()
            .map(|(p, sz)| self.entry(&p, sz as i64))
            .collect())
    }

    async fn get_file_meta(&self, path: &str) -> Result<Entry> {
        let key = path.trim_start_matches('/');
        match CLIENT_DIR.get_file(key) {
            Some(f) => Ok(self.entry(key, f.contents().len() as i64)),
            None => Err(Error::NotFound),
        }
    }

    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let key = path.trim_start_matches('/');
        let f = CLIENT_DIR.get_file(key).ok_or(Error::NotFound)?;
        let data = f.contents().to_vec();
        let e = self.entry(key, data.len() as i64);
        Ok((data, e))
    }

    async fn write_file(
        &self,
        _path: &str,
        _data: &[u8],
        _mtime: Option<i64>,
    ) -> Result<Entry> {
        Err(Error::NotAllowed)
    }

    async fn delete_file(&self, _path: &str) -> Result<()> {
        Err(Error::NotAllowed)
    }

    async fn create_dir(&self, _path: &str) -> Result<Entry> {
        Err(Error::NotAllowed)
    }
}
