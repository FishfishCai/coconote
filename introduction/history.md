---
id: np193j08yn6x122g
coconote: true
title: history
---

# History

The server maintains a history database for each vault, recording every write snapshot of every page. The version history is used for review / restore; for cross-vault sync via push / pull, the same history serves as the source for finding the merge base. Identity travels with the file via the `id:` field in frontmatter (markdown) or sidecar (pdf) — nothing else.

## Storage model

The database has two layers:

- **Content pool** (`blobs`): every byte stream that has ever appeared is stored, deduplicated by content hash. Md files, PDF sidecars, and images under the assets folder all enter the same pool.
- **Version table** (`versions`): each version is a page's "file manifest" at one moment in time — each file in the manifest points to one hash in the content pool.

```sql
CREATE TABLE blobs (
  hash  TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
);

CREATE TABLE versions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id   TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  save_type TEXT    NOT NULL
            CHECK (save_type IN ('create','edit','push','pull','pin')),
  manifest  JSON    NOT NULL   -- {filename: hash, ...}
);
CREATE INDEX idx_versions_page ON versions(page_id, ts DESC);
```

A page's "full file set":

- md page: the md body + every image under `.<filename>.assets/`
- pdf page: the sidecar `.<filename>.json` (the PDF body itself doesn't enter the history — it's frozen on import)

The five `save_type` values:

- **create**: the page's first recorded write (no prior row for this `page_id`).
- **edit**: editor save, collab autosave, Restore, and other "write-to-disk" actions.
- **push**: a write produced by a push operation.
- **pull**: a write produced by a pull operation.
- **pin**: the user pressed the shortcut (default `Cmd / Ctrl + Shift + P`, rebindable in setting) to lock the current version as a permanent retention point.

### Write

On every save (editor save, push landing, pull landing, etc.), the server walks every file of that page, adds any unseen byte streams to the content pool, then writes a new row to the version table tagged with a `save_type`.

### Restore

Read each hash from the version row's manifest, fetch the blob from the content pool, and write it back to the current path on disk.

## Retention

Periodic pruning of history records:

- The four types `create` / `push` / `pull` / `pin` are **never pruned**.
- The `edit` type is pruned on a time window:
    - Within the last hour: keep all
    - 1 hour to 1 day: 1 per hour (keep the last of each hour)
    - 1 to 7 days: 1 per day
    - 7 to 30 days: 1 per week
    - Beyond 30 days: 1 per month

## Orphan page_ids

At server startup, the history DB drops every `page_id` no on-disk file claims, then collects the now-unreferenced blobs. Boot-only — same trigger model as the sidecar / assets sweep in [[file]].

## Version history panel

- Left column: recorded versions, newest to oldest. Each row shows the timestamp and the `save_type` tag.
- Right column: preview of the selected version. A git-diff-style red/green block highlights the difference between this version and the "current on-disk content".
- Bottom buttons:
    - **Restore this version**: writes the selected version back to the current path on disk (producing a new `edit` row).
    - **Delete**: deletes that version row from the database. Any type can be deleted directly.

The panel is indexed by `page_id`; even if the file has been renamed, the full chain is visible.

## Push

Push modal configuration:

- **Target url root**: chooses the push destination via a two-level menu — the first level is the url (with a free-input box plus the url list already saved under setting's Remote), the second is the root under that url. A manually entered url is first probed to confirm the peer is actually a coconote server.

After the target is chosen, branches as follows:

- **A remote file exists with the same page_id**:
    - Remote file == content of the local latest `push` / `pull` row: **fast-forward**; local content overwrites remote.
    - Otherwise: **merge** (see below).
- **No same page_id, but the same relative path holds a same-named file**: a "confirm overwrite" dialog pops up, prompting per file, with an "apply the same choice to the rest" option in the dialog.
- **No same page_id, no path collision**: direct upload.

After completion, the local history appends one `save_type = push` row. On the merge path, the local content is also replaced with the merged result, and the remote history likewise gets a `save_type = push` row.

## Pull

Pull modal configuration:

- **Target root**: chooses a local root as the landing destination.

After the target is chosen, branches as follows:

- **A local file exists with the same page_id**:
    - Local file == content of the local latest `push` / `pull` row: **fast-forward**; remote content overwrites local.
    - Otherwise: **merge**.
- **No same page_id, but the same relative path holds a same-named file**: a "confirm overwrite" dialog pops up, likewise with an "apply the same choice to the rest" option.
- **No same page_id, no path collision**: direct download.

After completion, the local history appends one `save_type = pull` row.

## Merge

When push / pull detects that both sides have changes, a merge is triggered. The merge base is the content of the local latest `push` / `pull` row in the database for that page.

### Three-way diff

1. diff base $\leftrightarrow$ local: $\Delta$L (the local-side change set)
2. diff base $\leftrightarrow$ remote: $\Delta$R (the remote-side change set)
3. Classify chunk by chunk:
    - Only $\Delta$L changed: take the local version
    - Only $\Delta$R changed: take the remote version
    - Both changed without overlap: keep both
    - Both changed and overlap: **conflict** — pop the MergeView for the user to decide

No conflict $\to$ auto-merge $\to$ write to disk $\to$ sync. With conflict $\to$ pop the MergeView.

### MergeView

Three horizontal columns by conflicting chunk: **local | base | remote**. Each chunk has three buttons:

- **$\leftarrow$ take local**: take the local version
- **take remote $\rightarrow$**: take the remote version
- **reset**: revert to base

A collapsible "Edit merged buffer directly" textarea at the bottom can bypass per-chunk selection to hand-edit the final result.

On submit:

1. Write the merged result back to the trigger side (push-triggered writes the remote; pull-triggered writes the local).
2. Also write the same content to the other side, aligning both ends.
3. Each side records a sync marker (push-triggered: `save_type = push`; pull-triggered: `save_type = pull`).
