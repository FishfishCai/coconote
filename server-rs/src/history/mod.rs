// SQLite version history (history.md Storage model): blobs(hash, bytes)
// content-addressable pool + versions(id, page_id, ts, save_type, manifest),
// manifest = flat {filename: hash} for a page's full file set at one moment.
// restore is NOT a save_type (writes a new edit row), pin clones the latest
// row's manifest with a fresh ts.
//
// HistoryDb owns the pool; its impl is spread across submodules by concern:
// types (SaveType/Manifest), store (blob + version CRUD), retention
// (prune/GC), scope (db file path).

mod retention;
mod scope;
mod store;
mod types;

pub use types::{is_sidecar_name, Manifest, SaveType, VersionMeta};

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};

pub struct HistoryDb {
    pool: Pool<Sqlite>,
}

impl HistoryDb {
    /// Per-vault DB at $XDG_DATA_HOME/coconote/history-<scope>.sqlite. `scope`
    /// identifies the vault: `config:<path>` multi-root, `vault:<folder>` single.
    pub async fn open(scope: &str) -> anyhow::Result<Self> {
        let db_path = scope::db_path(scope)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).context("create history dir")?;
        }
        if db_path.exists() {
            if let Err(e) = scope::rename_legacy_if_needed(&db_path).await {
                tracing::warn!("history: legacy detection failed: {e}");
            }
        }
        let opts = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await
            .with_context(|| format!("open {}", db_path.display()))?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS blobs (
                hash  TEXT PRIMARY KEY,
                bytes BLOB NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .context("create blobs table")?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS versions (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id   TEXT    NOT NULL,
                ts        INTEGER NOT NULL,
                save_type TEXT    NOT NULL
                          CHECK (save_type IN ('create','edit','push','pull','pin')),
                manifest  TEXT    NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .context("create versions table")?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_versions_page ON versions(page_id, ts DESC);")
            .execute(&pool)
            .await
            .context("create idx_versions_page")?;
        Ok(Self { pool })
    }
}

#[cfg(test)]
mod tests;
