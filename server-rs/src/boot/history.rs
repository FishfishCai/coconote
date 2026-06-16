// Per-vault history DB: scope derivation, open, boot-time orphan page_id
// sweep, and pruner start (history.md Orphan page_ids).

use crate::history::HistoryDb;
use crate::state::DynSpace;
use indexmap::IndexMap;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::info;

/// Open the per-vault history DB, drop orphan page_ids, and start the
/// pruner. Returns None (history disabled) on open failure so the server
/// still serves.
pub(super) async fn open_history(
    config_path: Option<&str>,
    roots_pretty: &IndexMap<String, String>,
    space: &DynSpace,
) -> Option<Arc<HistoryDb>> {
    let scope = history_scope(config_path, roots_pretty);
    let db = match HistoryDb::open(&scope).await {
        Ok(db) => Arc::new(db),
        Err(e) => {
            tracing::warn!("history disabled: {e}");
            return None;
        }
    };
    // Drop history rows for page_ids no on-disk file claims. Must run after
    // the space is open (we walk it for the live id set). None = listing
    // empty or failed (e.g. no roots): skip the sweep, wiping the whole DB
    // on an empty boot is never right.
    match collect_live_page_ids(space).await {
        Some(live_ids) => match db.drop_orphan_page_ids(&live_ids).await {
            Ok((rows, blobs)) if rows + blobs > 0 => {
                info!("history orphan sweep: {rows} version rows, {blobs} blobs collected");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("history orphan sweep failed: {e}"),
        },
        None => info!("history orphan sweep skipped: empty listing"),
    }
    db.spawn_pruner();
    Some(db)
}

/// Per-vault history scope so two vaults sharing filenames stay isolated.
/// Config path is the most stable identifier; fall back to the first root.
fn history_scope(config_path: Option<&str>, roots_pretty: &IndexMap<String, String>) -> String {
    config_path.map(|p| format!("config:{p}")).unwrap_or_else(|| {
        roots_pretty
            .values()
            .next()
            .map(|p| format!("vault:{p}"))
            .unwrap_or_else(|| "vault:default".into())
    })
}

/// Collect every page_id in the live space (frontmatter / sidecar),
/// INCLUDING excluded pages (`coconote: false`): excluding a page must not
/// delete its history. None when the listing fails or is empty (no roots),
/// so the caller skips the sweep instead of dropping every row.
async fn collect_live_page_ids(space: &DynSpace) -> Option<HashSet<String>> {
    let entries = space.fetch_file_list_all(true).await.ok()?;
    if entries.is_empty() {
        return None;
    }
    let mut out = HashSet::new();
    for e in entries {
        if !e.page_id.is_empty() {
            out.insert(e.page_id);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_prefers_config_path_then_first_root() {
        let mut roots = IndexMap::new();
        roots.insert("main".to_string(), "/vault".to_string());
        assert_eq!(
            history_scope(Some("/cfg/coconote.yaml"), &roots),
            "config:/cfg/coconote.yaml"
        );
        assert_eq!(history_scope(None, &roots), "vault:/vault");
        assert_eq!(history_scope(None, &IndexMap::new()), "vault:default");
    }
}
