// Per-vault DB file path resolution and legacy-schema quarantine
// (history.md: "a history database per vault"). The scope string names the
// vault; its blake3 hash is the on-disk filename so it survives restarts.

use anyhow::Context;
use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::path::PathBuf;

pub(super) fn db_path(scope: &str) -> anyhow::Result<PathBuf> {
    let pd = ProjectDirs::from("io", "coconote", "server")
        .context("could not resolve data dir")?;
    let hash = scope_hash(scope);
    Ok(pd.data_dir().join(format!("history-{hash}.sqlite")))
}

// Deterministic so the on-disk filename survives restarts (DefaultHasher's
// process-randomized seed would abandon the prior DB every reboot).
fn scope_hash(s: &str) -> String {
    blake3::hash(s.as_bytes()).to_hex()[..16].to_string()
}

/// Rename a pre-schema DB to `<file>.bak` so the new schema starts fresh.
/// Legacy = a `versions.content`/`kind` column, or no `blobs` table.
pub(super) async fn rename_legacy_if_needed(db_path: &std::path::Path) -> anyhow::Result<()> {
    let opts = SqliteConnectOptions::new().filename(db_path);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .context("probe legacy")?;
    let cols: Vec<(i64, String, String, i64, Option<String>, i64)> =
        sqlx::query_as("PRAGMA table_info(versions)")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
    let names: std::collections::HashSet<String> = cols.iter().map(|c| c.1.clone()).collect();
    let blob_table: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='blobs'")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
    let is_legacy = !cols.is_empty()
        && (names.contains("content") || names.contains("kind") || blob_table.is_none());
    drop(pool);
    if is_legacy {
        let mut bak = db_path.to_path_buf();
        bak.set_extension("sqlite.bak");
        tracing::warn!(
            "history: legacy schema detected at {}; renaming to {}",
            db_path.display(),
            bak.display()
        );
        std::fs::rename(db_path, &bak).context("rename legacy db")?;
    }
    Ok(())
}
