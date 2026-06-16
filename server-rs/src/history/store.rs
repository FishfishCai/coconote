// Content pool + version-row reads and writes (history.md Write / Restore):
// blob storage, version recording, and the listing / preview / manifest
// queries that back the /.history endpoints.

use super::types::{save_type_from_str, Manifest, SaveType, VersionMeta};
use super::HistoryDb;
use crate::util::now_ms;
use std::sync::Arc;

impl HistoryDb {
    pub async fn get_blob(&self, hash: &str) -> sqlx::Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT bytes FROM blobs WHERE hash = ?")
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
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT ts, save_type FROM versions WHERE page_id = ? ORDER BY ts DESC")
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
    pub async fn preview_at(&self, page_id: &str, ts: i64) -> sqlx::Result<Option<Vec<u8>>> {
        let Some(manifest) = self.manifest_at(page_id, ts).await? else {
            return Ok(None);
        };
        let Some(hash) = manifest.files.get(&manifest.main_file) else {
            return Ok(None);
        };
        self.get_blob(hash).await
    }

    /// Whole manifest at one ts (for Restore).
    pub async fn manifest_at(&self, page_id: &str, ts: i64) -> sqlx::Result<Option<Manifest>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT manifest FROM versions WHERE page_id = ? AND ts = ? LIMIT 1")
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
    pub async fn latest_manifest(&self, page_id: &str) -> sqlx::Result<Option<Manifest>> {
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
}
