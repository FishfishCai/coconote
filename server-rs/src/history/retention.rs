// history.md Retention + Orphan page_ids: the edit-decay pruner, the
// content-pool blob GC, and the boot-time orphan page_id sweep. The
// background pruner cycle drives all three.

use super::HistoryDb;
use crate::util::now_ms;
use std::sync::Arc;
use std::time::Duration;

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
            let r = sqlx::query(&format!("DELETE FROM versions WHERE id IN ({id_list})"))
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
        let rows: Vec<(String,)> = sqlx::query_as("SELECT DISTINCT page_id FROM versions")
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
