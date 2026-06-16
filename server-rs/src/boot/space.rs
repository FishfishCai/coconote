// Vault space construction and the boot-time orphan sweep (file.md).

use crate::space::{
    DiskSpacePrimitives, MultiRootSpacePrimitives, ReadOnlySpacePrimitives, RootConfig,
};
use crate::state::DynSpace;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::info;

/// Build the vault space: a single `--folder` root when given, else the
/// configured multi-root set, wrapped read-only on demand. Empty roots is
/// OK (the user adds roots via Setting -> Local at runtime).
pub(super) fn build_space(
    roots: &[RootConfig],
    folder: Option<&Path>,
    read_only: bool,
) -> Result<DynSpace, String> {
    let base: DynSpace = if let Some(folder) = folder {
        Arc::new(DiskSpacePrimitives::new(folder).map_err(|e| format!("vault: {e}"))?)
    } else {
        Arc::new(
            MultiRootSpacePrimitives::new(roots.to_vec()).map_err(|e| format!("multiroot: {e}"))?,
        )
    };
    Ok(if read_only {
        Arc::new(ReadOnlySpacePrimitives::new(base))
    } else {
        base
    })
}

/// Orphan sweep on every configured root (file.md). Empty roots = nothing
/// to sweep.
pub(super) fn sweep_orphans(roots: &[RootConfig], folder: Option<&Path>) {
    let scan_roots: Vec<PathBuf> = match folder {
        Some(f) => vec![f.to_path_buf()],
        None => roots.iter().map(|r| r.path.clone()).collect(),
    };
    for r in scan_roots {
        let (j, a) = crate::orphan::sweep_root(&r);
        if j + a > 0 {
            info!("orphan sweep at {}: {j} sidecar, {a} assets removed", r.display());
        }
    }
}
