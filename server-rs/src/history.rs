// SQLite version history (history.md Storage model): blobs(hash, bytes)
// content-addressable pool + versions(id, page_id, ts, save_type, manifest),
// manifest = flat {filename: hash} for a page's full file set at one moment.
// restore is NOT a save_type (writes a new edit row), pin clones the latest
// row's manifest with a fresh ts.

use anyhow::Context;
use directories::ProjectDirs;
use serde::de::Deserializer;
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct HistoryDb {
    pool: Pool<Sqlite>,
}

/// What triggered this version row. CHECK-constrained in the DB.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveType {
    Create,
    Edit,
    Push,
    Pull,
    Pin,
}

impl SaveType {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveType::Create => "create",
            SaveType::Edit => "edit",
            SaveType::Push => "push",
            SaveType::Pull => "pull",
            SaveType::Pin => "pin",
        }
    }

    /// Parse `?save_type=` on PUT /.file/<path>. `create` is server-decided
    /// (first row for a page_id) and never accepted from the wire.
    pub fn from_put_query(s: &str) -> Option<Self> {
        match s {
            "edit" => Some(SaveType::Edit),
            "push" => Some(SaveType::Push),
            "pull" => Some(SaveType::Pull),
            _ => None,
        }
    }
}

fn save_type_from_str(s: &str) -> SaveType {
    match s {
        "create" => SaveType::Create,
        "push" => SaveType::Push,
        "pull" => SaveType::Pull,
        "pin" => SaveType::Pin,
        _ => SaveType::Edit,
    }
}

/// One row of the `/.history/<page_id>` list (server.md: `[{ts, save_type}, ...]`).
#[derive(Debug, Serialize)]
pub struct VersionMeta {
    pub ts: i64,
    pub save_type: SaveType,
}

/// A page's full file set at one ts, stored as the flat {filename: hash}
/// JSON history.md specifies. `main_file` is derived from filename shapes
/// on read and never serialized.
#[derive(Debug)]
pub struct Manifest {
    /// Filename whose body the preview endpoint returns (server.md: "?ts=<ms>
    /// returns the main md text"): the .md file for md pages, the
    /// `.<name>.json` sidecar for pdf pages.
    pub main_file: String,
    /// {filename -> blake3 hex hash}, relative to the page's directory:
    /// page basename for the main file, `.<stem>.assets/<f>` for images.
    pub files: indexmap::IndexMap<String, String>,
}

impl Serialize for Manifest {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        // history.md: manifest JSON is flat {filename: hash}.
        self.files.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            /// Pre-flat rows, kept readable so existing DBs survive.
            Legacy {
                main_file: String,
                files: indexmap::IndexMap<String, String>,
            },
            Flat(indexmap::IndexMap<String, String>),
        }
        Ok(match Wire::deserialize(d)? {
            Wire::Legacy { main_file, files } => Manifest { main_file, files },
            Wire::Flat(files) => {
                let main_file = derive_main_file(&files);
                Manifest { main_file, files }
            }
        })
    }
}

/// `.{stem}.json` with no directory part: the pdf sidecar shape.
pub fn is_sidecar_name(name: &str) -> bool {
    !name.contains('/')
        && name
            .strip_prefix('.')
            .and_then(|r| r.strip_suffix(".json"))
            .is_some_and(|stem| !stem.is_empty())
}

/// Pick the main entry by filename shape: top-level `*.md` = md body,
/// top-level `.{stem}.json` = pdf sidecar, rest (`.{stem}.assets/<f>`) = assets.
fn derive_main_file(files: &indexmap::IndexMap<String, String>) -> String {
    for k in files.keys() {
        if !k.contains('/') && k.to_ascii_lowercase().ends_with(".md") {
            return k.clone();
        }
    }
    for k in files.keys() {
        if is_sidecar_name(k) {
            return k.clone();
        }
    }
    files.keys().next().cloned().unwrap_or_default()
}

/// Orphan-blob GC: drop blobs no surviving version references. First branch
/// covers flat {filename: hash} manifests (text values at the JSON root),
/// second the legacy {main_file, files:{...}} shape older rows may carry.
const BLOB_GC_SQL: &str = "DELETE FROM blobs WHERE hash NOT IN (\
    SELECT json_each.value FROM versions, json_each(json(versions.manifest)) \
    WHERE json_each.type = 'text' \
    UNION \
    SELECT json_each.value FROM versions, \
    json_each(json(versions.manifest), '$.files'))";

impl HistoryDb {
    /// Per-vault DB at $XDG_DATA_HOME/coconote/history-<scope>.sqlite. `scope`
    /// identifies the vault: `config:<path>` multi-root, `vault:<folder>` single.
    pub async fn open(scope: &str) -> anyhow::Result<Self> {
        let db_path = db_path(scope)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).context("create history dir")?;
        }
        if db_path.exists() {
            if let Err(e) = rename_legacy_if_needed(&db_path).await {
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

    pub async fn get_blob(&self, hash: &str) -> sqlx::Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT bytes FROM blobs WHERE hash = ?")
                .bind(hash)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(b,)| b))
    }

    /// Record one version (caller supplies manifest and blobs).
    ///
    /// `save_type = None`: the INSERT's CASE checks for a prior row of this
    /// page_id in the same statement, so racing first writes can't both land
    /// as `create`. Blob and version inserts share one transaction so the
    /// pruner's blob GC never sees blobs without their referencing row. ts is
    /// forced strictly increasing per page (max(now, MAX(ts)+1)): (page_id, ts)
    /// is the wire address of a version, unique even within one millisecond.
    pub async fn record(
        &self,
        page_id: &str,
        save_type: Option<SaveType>,
        manifest: &Manifest,
        blobs: &[(String, Vec<u8>)],
    ) -> sqlx::Result<i64> {
        let json =
            serde_json::to_string(manifest).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        let mut tx = self.pool.begin().await?;
        for (h, b) in blobs {
            // Idempotent: PRIMARY KEY does the dedup.
            sqlx::query("INSERT OR IGNORE INTO blobs (hash, bytes) VALUES (?, ?)")
                .bind(h)
                .bind(b)
                .execute(&mut *tx)
                .await?;
        }
        let r = sqlx::query(
            "INSERT INTO versions (page_id, ts, save_type, manifest) \
             SELECT ?1, \
                    MAX(?2, COALESCE((SELECT MAX(ts) + 1 FROM versions WHERE page_id = ?1), 0)), \
                    CASE WHEN ?3 <> '' THEN ?3 \
                         WHEN EXISTS (SELECT 1 FROM versions WHERE page_id = ?1) THEN 'edit' \
                         ELSE 'create' END, \
                    ?4",
        )
        .bind(page_id)
        .bind(now_ms())
        .bind(save_type.map(SaveType::as_str).unwrap_or(""))
        .bind(&json)
        .execute(&mut *tx)
        .await?;
        let rowid = r.last_insert_rowid();
        tx.commit().await?;
        Ok(rowid)
    }

    /// Single-file convenience (1-entry manifest). Used by fs::put for plain
    /// md saves and pdf sidecar writes.
    pub async fn record_single(
        self: &Arc<Self>,
        page_id: &str,
        save_type: Option<SaveType>,
        main_file: &str,
        bytes: &[u8],
    ) -> sqlx::Result<i64> {
        let hash = crate::util::blake3_hex(bytes);
        let mut files = indexmap::IndexMap::new();
        files.insert(main_file.to_string(), hash.clone());
        let manifest = Manifest {
            main_file: main_file.to_string(),
            files,
        };
        self.record(page_id, save_type, &manifest, &[(hash, bytes.to_vec())])
            .await
    }

    /// `/.history/<page_id>` list, newest first.
    pub async fn list_id(&self, page_id: &str) -> sqlx::Result<Vec<VersionMeta>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT ts, save_type FROM versions WHERE page_id = ? ORDER BY ts DESC",
        )
        .bind(page_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(ts, st)| VersionMeta {
                ts,
                save_type: save_type_from_str(&st),
            })
            .collect())
    }

    /// `?ts=<ms>` preview: main md (or sidecar) text of that snapshot.
    pub async fn preview_at(
        &self,
        page_id: &str,
        ts: i64,
    ) -> sqlx::Result<Option<Vec<u8>>> {
        let Some(manifest) = self.manifest_at(page_id, ts).await? else {
            return Ok(None);
        };
        let Some(hash) = manifest.files.get(&manifest.main_file) else {
            return Ok(None);
        };
        self.get_blob(hash).await
    }

    /// Whole manifest at one ts (for Restore).
    pub async fn manifest_at(
        &self,
        page_id: &str,
        ts: i64,
    ) -> sqlx::Result<Option<Manifest>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT manifest FROM versions WHERE page_id = ? AND ts = ? LIMIT 1",
        )
        .bind(page_id)
        .bind(ts)
        .fetch_optional(&self.pool)
        .await?;
        let Some((json,)) = row else {
            return Ok(None);
        };
        Ok(serde_json::from_str(&json).ok())
    }

    /// Most recent row's manifest, used by /pin (clones it).
    pub async fn latest_manifest(
        &self,
        page_id: &str,
    ) -> sqlx::Result<Option<Manifest>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT manifest FROM versions WHERE page_id = ? ORDER BY ts DESC LIMIT 1",
        )
        .bind(page_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((json,)) = row else {
            return Ok(None);
        };
        Ok(serde_json::from_str(&json).ok())
    }

    /// DELETE /.history/<page_id>?ts=<ms>: exactly one row (server.md
    /// "deletes a single version row"). New inserts keep ts unique per page,
    /// legacy same-ts duplicates go one per call.
    pub async fn delete_at(&self, page_id: &str, ts: i64) -> sqlx::Result<u64> {
        let r = sqlx::query(
            "DELETE FROM versions WHERE id = \
             (SELECT id FROM versions WHERE page_id = ? AND ts = ? LIMIT 1)",
        )
        .bind(page_id)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// history.md Retention for one page_id: create/push/pull/pin always kept,
    /// edit decays (<1h all, 1h-1d 1/hr, 1d-7d 1/day, 7d-30d 1/wk, >30d 1/mo).
    pub async fn prune_id(&self, page_id: &str) -> sqlx::Result<u64> {
        self.prune_id_at(page_id, now_ms()).await
    }

    /// `prune_id` with `now` injected (for retention bucket tests). Does NOT
    /// GC blobs: the pruner runs that once per cycle.
    pub async fn prune_id_at(&self, page_id: &str, now: i64) -> sqlx::Result<u64> {
        let h = 60 * 60 * 1000_i64;
        let d = 24 * h;
        let w = 7 * d;
        let mo = 30 * d;
        let mut tx = self.pool.begin().await?;
        let rows: Vec<(i64, i64, String)> = sqlx::query_as(
            "SELECT id, ts, save_type FROM versions WHERE page_id = ? ORDER BY ts DESC",
        )
        .bind(page_id)
        .fetch_all(&mut *tx)
        .await?;
        let mut keep = std::collections::HashSet::<i64>::new();
        // 1) all non-edit rows.
        for (id, _, st) in &rows {
            if st != "edit" {
                keep.insert(*id);
            }
        }
        // 2) edit decay: newest in each bucket survives.
        let mut last_hour = i64::MIN;
        let mut last_day = i64::MIN;
        let mut last_week = i64::MIN;
        let mut last_month = i64::MIN;
        for (id, ts, st) in &rows {
            if st != "edit" {
                continue;
            }
            let age = now - ts;
            if age < h {
                keep.insert(*id);
            } else if age < d {
                let bucket = ts / h;
                if bucket != last_hour {
                    keep.insert(*id);
                    last_hour = bucket;
                }
            } else if age < w {
                let bucket = ts / d;
                if bucket != last_day {
                    keep.insert(*id);
                    last_day = bucket;
                }
            } else if age < mo {
                let bucket = ts / w;
                if bucket != last_week {
                    keep.insert(*id);
                    last_week = bucket;
                }
            } else {
                let bucket = ts / mo;
                if bucket != last_month {
                    keep.insert(*id);
                    last_month = bucket;
                }
            }
        }
        let drop_ids: Vec<i64> = rows
            .iter()
            .filter(|(id, _, _)| !keep.contains(id))
            .map(|(id, _, _)| *id)
            .collect();
        let mut deleted = 0u64;
        if !drop_ids.is_empty() {
            // ids are server-generated integers, safe to inline (one
            // statement, no bind-param limit).
            let id_list = drop_ids
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let r = sqlx::query(&format!(
                "DELETE FROM versions WHERE id IN ({id_list})"
            ))
            .execute(&mut *tx)
            .await?;
            deleted = r.rows_affected();
        }
        tx.commit().await?;
        Ok(deleted)
    }

    /// Drop blobs no surviving version references. Single atomic statement,
    /// shared by the pruner cycle and the boot orphan sweep.
    pub async fn gc_orphan_blobs(&self) -> sqlx::Result<u64> {
        let r = sqlx::query(BLOB_GC_SQL).execute(&self.pool).await?;
        Ok(r.rows_affected())
    }

    /// Every page_id with at least one version row.
    pub async fn known_page_ids(&self) -> sqlx::Result<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT DISTINCT page_id FROM versions")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|(s,)| s).collect())
    }

    /// Drop versions rows whose page_id is NOT in `live_ids`, then GC
    /// unreferenced blobs. Returns (rows_deleted, blobs_collected).
    pub async fn drop_orphan_page_ids(
        &self,
        live_ids: &std::collections::HashSet<String>,
    ) -> sqlx::Result<(u64, u64)> {
        let known = self.known_page_ids().await?;
        let mut rows_deleted: u64 = 0;
        for id in known {
            if live_ids.contains(&id) {
                continue;
            }
            let r = sqlx::query("DELETE FROM versions WHERE page_id = ?")
                .bind(&id)
                .execute(&self.pool)
                .await?;
            rows_deleted += r.rows_affected();
        }
        let blobs = self.gc_orphan_blobs().await.unwrap_or(0);
        Ok((rows_deleted, blobs))
    }

    /// Sweep every page ~every 5 minutes, then collect orphan blobs once per
    /// cycle (NOT per page: the GC is full-table).
    pub fn spawn_pruner(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let interval = Duration::from_secs(5 * 60);
            loop {
                tokio::time::sleep(interval).await;
                let ids = match me.known_page_ids().await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("history pruner list: {e}");
                        continue;
                    }
                };
                for id in ids {
                    if let Err(e) = me.prune_id(&id).await {
                        tracing::warn!("history pruner {id}: {e}");
                    }
                }
                if let Err(e) = me.gc_orphan_blobs().await {
                    tracing::warn!("orphan blob sweep failed: {e}");
                }
            }
        });
    }
}

use crate::util::now_ms;

/// Rename a pre-schema DB to `<file>.bak` so the new schema starts fresh.
/// Legacy = a `versions.content`/`kind` column, or no `blobs` table.
async fn rename_legacy_if_needed(db_path: &std::path::Path) -> anyhow::Result<()> {
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
    let names: std::collections::HashSet<String> =
        cols.iter().map(|c| c.1.clone()).collect();
    let blob_table: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='blobs'",
    )
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

fn db_path(scope: &str) -> anyhow::Result<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> HistoryDb {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);",
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, ts INTEGER NOT NULL, save_type TEXT NOT NULL CHECK (save_type IN ('create','edit','push','pull','pin')), manifest TEXT NOT NULL);",
            "CREATE INDEX idx_versions_page ON versions(page_id, ts DESC);",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        HistoryDb { pool }
    }

    #[tokio::test]
    async fn record_then_list_and_preview() {
        let db = Arc::new(fresh_db().await);
        db.record_single("page1", Some(SaveType::Create), "foo.md", b"hello")
            .await
            .unwrap();
        db.record_single("page1", Some(SaveType::Edit), "foo.md", b"hello world")
            .await
            .unwrap();
        let list = db.list_id("page1").await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].save_type, SaveType::Edit);
        assert_eq!(list[1].save_type, SaveType::Create);
        let preview = db.preview_at("page1", list[1].ts).await.unwrap().unwrap();
        assert_eq!(preview, b"hello");
    }

    #[tokio::test]
    async fn manifest_is_stored_flat() {
        let db = Arc::new(fresh_db().await);
        db.record_single("p", Some(SaveType::Create), "f.md", b"x")
            .await
            .unwrap();
        let (json,): (String,) =
            sqlx::query_as("SELECT manifest FROM versions LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        // history.md: flat {filename: hash}, no main_file/files wrapper.
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("f.md"));
        assert!(!obj.contains_key("main_file"));
        assert!(!obj.contains_key("files"));
    }

    #[tokio::test]
    async fn legacy_manifest_shape_still_reads() {
        let db = Arc::new(fresh_db().await);
        sqlx::query("INSERT INTO blobs (hash, bytes) VALUES ('h1', x'68')")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO versions (page_id, ts, save_type, manifest) \
             VALUES ('p', 5, 'edit', '{\"main_file\":\"f.md\",\"files\":{\"f.md\":\"h1\"}}')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let m = db.manifest_at("p", 5).await.unwrap().unwrap();
        assert_eq!(m.main_file, "f.md");
        assert_eq!(db.preview_at("p", 5).await.unwrap().unwrap(), b"h");
    }

    #[test]
    fn derive_main_prefers_md_then_sidecar() {
        let mut files = indexmap::IndexMap::new();
        files.insert(".note.assets/img.png".to_string(), "h1".to_string());
        files.insert("note.md".to_string(), "h2".to_string());
        assert_eq!(derive_main_file(&files), "note.md");
        let mut pdf = indexmap::IndexMap::new();
        pdf.insert(".paper.json".to_string(), "h3".to_string());
        assert_eq!(derive_main_file(&pdf), ".paper.json");
    }

    #[tokio::test]
    async fn dedup_blobs_by_hash() {
        let db = Arc::new(fresh_db().await);
        db.record_single("p", Some(SaveType::Create), "f.md", b"same")
            .await
            .unwrap();
        db.record_single("p", Some(SaveType::Edit), "f.md", b"same")
            .await
            .unwrap();
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobs")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n.0, 1);
    }

    #[tokio::test]
    async fn server_decides_create_then_edit() {
        let db = Arc::new(fresh_db().await);
        db.record_single("p", None, "f.md", b"v1").await.unwrap();
        db.record_single("p", None, "f.md", b"v2").await.unwrap();
        let list = db.list_id("p").await.unwrap();
        assert_eq!(list[1].save_type, SaveType::Create);
        assert_eq!(list[0].save_type, SaveType::Edit);
    }

    #[tokio::test]
    async fn ts_strictly_increasing_within_one_ms() {
        let db = Arc::new(fresh_db().await);
        for i in 0..5u8 {
            db.record_single("p", None, "f.md", &[i]).await.unwrap();
        }
        let mut ts: Vec<i64> = db.list_id("p").await.unwrap().iter().map(|v| v.ts).collect();
        ts.reverse(); // oldest first
        for w in ts.windows(2) {
            assert!(w[1] > w[0], "ts must be strictly increasing: {ts:?}");
        }
    }

    #[tokio::test]
    async fn delete_at_removes_exactly_one_row() {
        let db = Arc::new(fresh_db().await);
        // Legacy collision: two rows sharing (page_id, ts).
        for tag in ["a", "b"] {
            sqlx::query(
                "INSERT INTO versions (page_id, ts, save_type, manifest) VALUES ('p', 7, 'edit', ?)",
            )
            .bind(format!(r#"{{"f.md":"{tag}"}}"#))
            .execute(&db.pool)
            .await
            .unwrap();
        }
        assert_eq!(db.delete_at("p", 7).await.unwrap(), 1);
        assert_eq!(db.list_id("p").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn pin_keeps_create_push_pull_pin() {
        let db = Arc::new(fresh_db().await);
        for st in [SaveType::Create, SaveType::Push, SaveType::Pull, SaveType::Pin] {
            db.record_single("p", Some(st), "f.md", st.as_str().as_bytes())
                .await
                .unwrap();
        }
        // Backdate well past every retention window.
        sqlx::query("UPDATE versions SET ts = ts - ?")
            .bind(40_i64 * 24 * 60 * 60 * 1000)
            .execute(&db.pool)
            .await
            .unwrap();
        db.prune_id("p").await.unwrap();
        let after = db.list_id("p").await.unwrap();
        assert_eq!(after.len(), 4);
    }

    #[tokio::test]
    async fn prune_edit_decay() {
        let db = Arc::new(fresh_db().await);
        let now = now_ms();
        for (i, age_ms) in [
            0_i64,
            10 * 60 * 1000,
            2 * 60 * 60 * 1000,
            3 * 60 * 60 * 1000,
            3 * 24 * 60 * 60 * 1000,
        ]
        .into_iter()
        .enumerate()
        {
            insert_edit_at(&db, "p", now - age_ms, &format!("h{i}")).await;
        }
        db.prune_id("p").await.unwrap();
        let after = db.list_id("p").await.unwrap();
        // 0 and 10min are <1h (kept), 2h and 3h sit in different hour
        // buckets, 3d alone in its day bucket: all 5 survive.
        assert_eq!(after.len(), 5);
    }

    async fn insert_edit_at(db: &HistoryDb, page_id: &str, ts: i64, tag: &str) {
        let m = format!(r#"{{"f.md":"{tag}"}}"#);
        sqlx::query("INSERT OR IGNORE INTO blobs (hash, bytes) VALUES (?, ?)")
            .bind(tag)
            .bind(vec![0u8])
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO versions (page_id, ts, save_type, manifest) VALUES (?, ?, 'edit', ?)",
        )
        .bind(page_id)
        .bind(ts)
        .bind(m)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    /// history.md Retention: create/push/pull/pin are never pruned.
    #[tokio::test]
    async fn prune_keeps_all_non_edit() {
        let db = Arc::new(fresh_db().await);
        // Backdate into the monthly window.
        let very_old_ms = 365_i64 * 24 * 60 * 60 * 1000;
        let now = 1_700_000_000_000_i64;
        for (i, st) in ["create", "push", "pull", "pin"].iter().enumerate() {
            let tag = format!("h{i}");
            let m = format!(r#"{{"f.md":"{tag}"}}"#);
            sqlx::query("INSERT INTO blobs (hash, bytes) VALUES (?, ?)")
                .bind(&tag)
                .bind(vec![i as u8])
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO versions (page_id, ts, save_type, manifest) VALUES (?, ?, ?, ?)",
            )
            .bind("p")
            .bind(now - very_old_ms)
            .bind(*st)
            .bind(m)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        db.prune_id_at("p", now).await.unwrap();
        let kept = db.list_id("p").await.unwrap();
        assert_eq!(kept.len(), 4, "create/push/pull/pin must all survive prune");
    }

    /// history.md Retention: every edit younger than 1 hour is kept.
    #[tokio::test]
    async fn prune_keeps_all_edits_under_hour() {
        let db = Arc::new(fresh_db().await);
        let now = 1_700_000_000_000_i64;
        for (i, age_min) in [0, 10, 30, 55].iter().enumerate() {
            insert_edit_at(&db, "p", now - (*age_min as i64) * 60 * 1000, &format!("h{i}")).await;
        }
        db.prune_id_at("p", now).await.unwrap();
        assert_eq!(db.list_id("p").await.unwrap().len(), 4);
    }

    /// history.md Retention: 1h-1d keeps the last edit of each hour bucket.
    #[tokio::test]
    async fn prune_edits_1h_to_1d_keeps_one_per_hour() {
        let db = Arc::new(fresh_db().await);
        let h_ms = 60 * 60 * 1000_i64;
        let now = 100 * h_ms; // bucket-aligned so `ts/h` is clean
        // Three edits in the SAME hour bucket (5h ago, +5min, +10min).
        let bucket_start = now - 5 * h_ms;
        for (i, off) in [0_i64, 5 * 60 * 1000, 10 * 60 * 1000].iter().enumerate() {
            insert_edit_at(&db, "p", bucket_start + *off, &format!("a{i}")).await;
        }
        // Plus one edit in a different hour bucket (3h ago).
        insert_edit_at(&db, "p", now - 3 * h_ms, "b").await;
        db.prune_id_at("p", now).await.unwrap();
        // Two buckets in the 1h-1d window -> 2 survivors.
        assert_eq!(db.list_id("p").await.unwrap().len(), 2);
    }

    /// history.md Retention: 1d-7d keeps one survivor per day bucket.
    #[tokio::test]
    async fn prune_edits_1d_to_7d_keeps_one_per_day() {
        let db = Arc::new(fresh_db().await);
        let h_ms = 60 * 60 * 1000_i64;
        let d_ms = 24 * h_ms;
        let now = 100 * d_ms;
        let bucket_day_ago = now - 2 * d_ms;
        for (i, off) in [0_i64, 2 * h_ms, 5 * h_ms].iter().enumerate() {
            insert_edit_at(&db, "p", bucket_day_ago + *off, &format!("a{i}")).await;
        }
        insert_edit_at(&db, "p", now - 5 * d_ms, "b").await;
        db.prune_id_at("p", now).await.unwrap();
        assert_eq!(db.list_id("p").await.unwrap().len(), 2);
    }

    /// history.md Retention: 7d-30d keeps one survivor per week bucket.
    #[tokio::test]
    async fn prune_edits_7d_to_30d_keeps_one_per_week() {
        let db = Arc::new(fresh_db().await);
        let d_ms = 24 * 60 * 60 * 1000_i64;
        let w_ms = 7 * d_ms;
        let now = 100 * w_ms;
        let bucket_week_ago = now - 2 * w_ms;
        for (i, off) in [0_i64, d_ms, 3 * d_ms].iter().enumerate() {
            insert_edit_at(&db, "p", bucket_week_ago + *off, &format!("a{i}")).await;
        }
        insert_edit_at(&db, "p", now - 4 * w_ms, "b").await;
        db.prune_id_at("p", now).await.unwrap();
        assert_eq!(db.list_id("p").await.unwrap().len(), 2);
    }

    /// history.md Retention: beyond 30d, one survivor per month bucket.
    #[tokio::test]
    async fn prune_edits_over_30d_keeps_one_per_month() {
        let db = Arc::new(fresh_db().await);
        let d_ms = 24 * 60 * 60 * 1000_i64;
        let mo_ms = 30 * d_ms;
        let now = 100 * mo_ms;
        let bucket_month_ago = now - 3 * mo_ms;
        for (i, off) in [0_i64, 5 * d_ms, 10 * d_ms].iter().enumerate() {
            insert_edit_at(&db, "p", bucket_month_ago + *off, &format!("a{i}")).await;
        }
        insert_edit_at(&db, "p", now - 6 * mo_ms, "b").await;
        db.prune_id_at("p", now).await.unwrap();
        assert_eq!(db.list_id("p").await.unwrap().len(), 2);
    }

    /// Blob GC keeps blobs referenced by either manifest shape, collects the rest.
    #[tokio::test]
    async fn gc_respects_flat_and_legacy_manifests() {
        let db = Arc::new(fresh_db().await);
        for hash in ["flat_h", "legacy_h", "orphan_h"] {
            sqlx::query("INSERT INTO blobs (hash, bytes) VALUES (?, x'00')")
                .bind(hash)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO versions (page_id, ts, save_type, manifest) \
             VALUES ('p1', 1, 'edit', '{\"f.md\":\"flat_h\"}')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO versions (page_id, ts, save_type, manifest) \
             VALUES ('p2', 1, 'edit', '{\"main_file\":\"g.md\",\"files\":{\"g.md\":\"legacy_h\"}}')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let collected = db.gc_orphan_blobs().await.unwrap();
        assert_eq!(collected, 1);
        assert!(db.get_blob("flat_h").await.unwrap().is_some());
        assert!(db.get_blob("legacy_h").await.unwrap().is_some());
        assert!(db.get_blob("orphan_h").await.unwrap().is_none());
    }
}
