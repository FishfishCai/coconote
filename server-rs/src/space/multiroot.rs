// Composes multiple DiskSpacePrimitives under named prefixes. Each
// file's logical path is `<rootname>/<rel inside root>` (welcome.md).
// All operations route by stripping the leading rootname segment.

use crate::error::{Error, Result};
use crate::space::DiskSpacePrimitives;
use crate::types::{Entry, EntryType, SpacePrimitives};

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct RootConfig {
    pub name: String,
    pub path: PathBuf,
}

pub struct MultiRootSpacePrimitives {
    root_names: Vec<String>,
    roots: HashMap<String, Arc<DiskSpacePrimitives>>,
}

impl MultiRootSpacePrimitives {
    pub fn new(roots: Vec<RootConfig>) -> Result<Self> {
        let mut root_names = Vec::with_capacity(roots.len());
        let mut map = HashMap::with_capacity(roots.len());
        for r in roots {
            if r.name.is_empty() {
                return Err(Error::Other("root name empty".into()));
            }
            if r.name.contains('/') || r.name.contains('\\') {
                return Err(Error::Other(format!(
                    "root name {:?} cannot contain path separators",
                    r.name
                )));
            }
            if map.contains_key(&r.name) {
                return Err(Error::Other(format!("duplicate root {:?}", r.name)));
            }
            let prim = Arc::new(DiskSpacePrimitives::new(&r.path)?);
            root_names.push(r.name.clone());
            map.insert(r.name, prim);
        }
        Ok(Self { root_names, roots: map })
    }

    fn split_path<'a>(
        &'a self,
        p: &'a str,
    ) -> Result<(&'a str, &'a str, Arc<DiskSpacePrimitives>)> {
        let trimmed = p.trim_start_matches('/');
        // Reject `..` first so the spec 400 wins over the 404 the
        // root-name lookup would otherwise return (server.md Errors).
        if trimmed
            .split('/')
            .any(|seg| seg == ".." || seg.contains('\0'))
        {
            return Err(Error::PathOutsideRoot);
        }
        let Some(slash) = trimmed.find('/') else {
            // Top-level root reference (the dir itself, no inner path).
            let prim = self.roots.get(trimmed).ok_or(Error::NotFound)?;
            return Ok((trimmed, "", prim.clone()));
        };
        let (root, rest) = trimmed.split_at(slash);
        let rest = &rest[1..];
        let prim = self.roots.get(root).ok_or(Error::NotFound)?;
        Ok((root, rest, prim.clone()))
    }
}

#[async_trait]
impl SpacePrimitives for MultiRootSpacePrimitives {
    async fn fetch_file_list_all(&self, include_excluded: bool) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        // Each root contributes one top-level Dir entry plus its tree.
        let futures: Vec<_> = self
            .root_names
            .iter()
            .map(|name| {
                let prim = self.roots.get(name).cloned().unwrap();
                let name = name.clone();
                async move {
                    let inner = prim.fetch_file_list_all(include_excluded).await?;
                    Ok::<_, Error>((name, inner))
                }
            })
            .collect();
        let results = futures::future::try_join_all(futures).await?;
        for (name, inner) in results {
            out.push(Entry {
                kind: EntryType::Dir,
                path: name.clone(),
                ..Default::default()
            });
            for mut e in inner {
                e.path = format!("{name}/{}", e.path);
                out.push(e);
            }
        }
        Ok(out)
    }

    async fn get_file_meta(&self, path: &str) -> Result<Entry> {
        let (root, rest, prim) = self.split_path(path)?;
        if rest.is_empty() {
            return Ok(Entry {
                kind: EntryType::Dir,
                path: root.to_string(),
                ..Default::default()
            });
        }
        let mut e = prim.get_file_meta(rest).await?;
        e.path = format!("{root}/{}", e.path);
        Ok(e)
    }

    async fn read_file(&self, path: &str) -> Result<(Vec<u8>, Entry)> {
        let (root, rest, prim) = self.split_path(path)?;
        if rest.is_empty() {
            return Err(Error::NotFound);
        }
        let (data, mut e) = prim.read_file(rest).await?;
        e.path = format!("{root}/{}", e.path);
        Ok((data, e))
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<Entry> {
        let (root, rest, prim) = self.split_path(path)?;
        if rest.is_empty() {
            return Err(Error::PathOutsideRoot);
        }
        let mut e = prim.write_file(rest, data).await?;
        e.path = format!("{root}/{}", e.path);
        Ok(e)
    }

    async fn delete_file(&self, path: &str) -> Result<()> {
        let (_, rest, prim) = self.split_path(path)?;
        if rest.is_empty() {
            return Err(Error::NotAllowed);
        }
        prim.delete_file(rest).await
    }

    async fn create_dir(&self, path: &str) -> Result<Entry> {
        let (root, rest, prim) = self.split_path(path)?;
        if rest.is_empty() {
            return Err(Error::PathOutsideRoot);
        }
        let mut e = prim.create_dir(rest).await?;
        e.path = format!("{root}/{}", e.path);
        Ok(e)
    }

    async fn list_under_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let (root, rest, prim) = self.split_path(prefix)?;
        let inner = prim.list_under_prefix(rest).await?;
        Ok(inner.into_iter().map(|p| format!("{root}/{p}")).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, TempDir, MultiRootSpacePrimitives) {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        std::fs::write(
            a.path().join("admitted.md"),
            "---\ncoconote: true\ntitle: A\n---\nx",
        )
        .unwrap();
        std::fs::write(b.path().join("other.md"), "---\ncoconote: true\n---\nbody").unwrap();
        let mr = MultiRootSpacePrimitives::new(vec![
            RootConfig {
                name: "left".into(),
                path: a.path().to_path_buf(),
            },
            RootConfig {
                name: "right".into(),
                path: b.path().to_path_buf(),
            },
        ])
        .unwrap();
        (a, b, mr)
    }

    #[tokio::test]
    async fn list_prefixes_and_filters() {
        let (_a, _b, mr) = setup();
        let list = mr.fetch_file_list().await.unwrap();
        let paths: Vec<&str> = list.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"left"));
        assert!(paths.contains(&"right"));
        assert!(paths.contains(&"left/admitted.md"));
        assert!(paths.contains(&"right/other.md"));
    }

    #[tokio::test]
    async fn read_routes_to_correct_root() {
        let (_a, _b, mr) = setup();
        let (data, _) = mr.read_file("right/other.md").await.unwrap();
        assert!(data.starts_with(b"---\ncoconote: true"));
    }

    #[tokio::test]
    async fn unknown_root_is_not_found() {
        let (_a, _b, mr) = setup();
        assert!(matches!(
            mr.read_file("ghost/x.md").await.unwrap_err(),
            Error::NotFound
        ));
    }
}
