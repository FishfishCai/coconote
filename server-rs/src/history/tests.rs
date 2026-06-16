use super::types::derive_main_file;
use super::*;
use crate::util::now_ms;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::sync::Arc;

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
    let (json,): (String,) = sqlx::query_as("SELECT manifest FROM versions LIMIT 1")
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
    sqlx::query("INSERT INTO versions (page_id, ts, save_type, manifest) VALUES (?, ?, 'edit', ?)")
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
        sqlx::query("INSERT INTO versions (page_id, ts, save_type, manifest) VALUES (?, ?, ?, ?)")
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
