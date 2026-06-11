// Read-only wrapper: forwards reads, stamps `Perm::Ro`, rejects writes.

use crate::error::{Error, Result};
use crate::types::{Entry, Perm, SpacePrimitives};
use async_trait::async_trait;
use std::sync::Arc;

pub struct ReadOnlySpacePrimitives {
    inner: Arc<dyn SpacePrimitives>,
}

impl ReadOnlySpacePrimitives {
    pub fn new(inner: Arc<dyn SpacePrimitives>) -> Self {
        Self { inner }
    }
}

fn downgrade(mut e: Entry) -> Entry {
    e.perm = Perm::Ro;
    e
}

#[async_trait]
impl SpacePrimitives for ReadOnlySpacePrimitives {
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>> {
        let list = self.inner.fetch_file_list_all(include_excluded).await?;
        Ok(list.into_iter().map(downgrade).collect())
    }
    async fn get_file_meta(&self, path: &str) -> Result<Entry> {
        self.inner.get_file_meta(path).await.map(downgrade)
    }
    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let (data, e) = self.inner.read_file(path).await?;
        Ok((data, downgrade(e)))
    }
    async fn list_under_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        // Reads are allowed: without this forward the empty default
        // impl would hide assets from read-only vaults.
        self.inner.list_under_prefix(prefix).await
    }
    async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<Entry> {
        Err(Error::NotAllowed)
    }
    async fn delete_file(&self, _path: &str) -> Result<()> {
        Err(Error::NotAllowed)
    }
    async fn create_dir(&self, _path: &str) -> Result<Entry> {
        Err(Error::NotAllowed)
    }
}
