---
id: np193j08yn6x122g
coconote: true
title: history
---

# History

The server keeps a history database per vault, recording every write of every page. A page's identity is stored only in the `id:` field of its frontmatter (markdown) or sidecar (pdf), nowhere else.

The history serves two uses: review and restore, and cross-vault sync via push and pull, where it supplies the merge base.

## Storage model

The database has two layers:

- **Content pool** (`blobs`): every byte stream is stored once, keyed by content hash. Md files, PDF sidecars, and images under the assets folder all enter the same pool.
- **Version table** (`versions`): each version is a page's file manifest at one moment. Every file in the manifest maps to one hash in the content pool.

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

A page's full file set:

- md page: the md body + every image under `.<filename>.assets/`
- pdf page: the sidecar `.<filename>.json` (the PDF body itself never enters the history - it's frozen on import).

The five `save_type` values:

- **create**: the page's first recorded write (no prior row for this `page_id`).
- **edit**: editor save, collab autosave, Restore, and other write-to-disk actions.
- **push**: a write produced by a push operation.
- **pull**: a write produced by a pull operation.
- **pin**: the user pressed the shortcut (default `Cmd / Ctrl + Shift + P`, rebindable in setting) to lock the current version as a permanent retention point.

### Write

On every save, the server adds any new byte streams to the content pool, then writes a version row tagged with a `save_type`.

### Restore

Read each hash from the version row's manifest, fetch the blob from the content pool, and write it back to the current path on disk. This produces a new `edit` row.

## Retention

Periodic pruning of history records:

- The four types `create` / `push` / `pull` / `pin` are **never pruned**.
- The `edit` type is pruned on a time window (each bucket keeps the last edit of its period):
    - Within the last hour: keep all
    - 1 hour to 1 day: 1 per hour
    - 1 to 7 days: 1 per day
    - 7 to 30 days: 1 per week
    - Beyond 30 days: 1 per month

## Orphan page_ids

At server startup, the history DB drops every `page_id` that no on-disk file claims, then garbage-collects the blobs left unreferenced. This runs only at boot.

## Version history panel

- Left column: recorded versions, newest to oldest. Each row shows the timestamp and the `save_type` tag.
- Right column: preview of the selected version. A diff block highlights the difference between this version and the current on-disk content, git-diff style (red for removed, green for added).
- Bottom buttons:
    - **Restore this version**: runs Restore on the selected version, producing a new `edit` row.
    - **Delete**: deletes that version row from the database. Any type can be deleted directly.

The panel is indexed by `page_id`, so even if the file has been renamed, the full chain is visible.

## Sync branching

Push and pull share one branching logic, differing only in direction. "Source" is the side sent from, "target" the side written to: push is local -> remote, pull is remote -> local.

After the target is chosen, the operation branches by how the target holds the page:

- **A target file exists with the same page_id**:
    - Target file == content of the local latest `push` / `pull` row (the merge base, see Merge): **fast-forward**, source content overwrites target.
    - Otherwise: **merge** (see below).
- **No same page_id, but the same relative path holds a same-named file**: a "confirm overwrite" dialog pops up, prompting per file, with an "apply the same choice to the rest" option.
- **No same page_id, no path collision**: direct transfer (upload for push, download for pull).

## Push

Push modal configuration:

- **Target url root**: chooses the push destination via a two-level menu. Level one is the url (a free-input box plus the saved urls from setting's Remote), level two is the root under that url. A manually entered url is probed to confirm it is a coconote server.

Branching follows Sync branching above, with local as source and remote as target.

On completion, the local history appends one `save_type = push` row. On the merge path, the local content is also replaced with the merged result, and the remote history likewise gets a `save_type = push` row.

## Pull

Pull modal configuration:

- **Target root**: chooses a local root as the landing destination.

Branching follows Sync branching above, with remote as source and local as target.

On completion, the local history appends one `save_type = pull` row.

## Merge

When push / pull detects that both sides have changes, a merge is triggered. The merge base is the content of the local latest `push` / `pull` row for that page, the last version both sides agreed on.

### Three-way diff

The diff works chunk by chunk, a chunk being a contiguous region produced by the line-based diff.

1. diff base $\leftrightarrow$ local: $\Delta$L (the local-side change set)
2. diff base $\leftrightarrow$ remote: $\Delta$R (the remote-side change set)
3. Classify each chunk:
    - Only $\Delta$L changed it: take local
    - Only $\Delta$R changed it: take remote
    - Both changed, non-overlapping regions: keep both
    - Both changed the same region: **conflict**, pop the MergeView for the user to decide

No conflict -> auto-merge -> write to disk -> sync. With conflict, pop the MergeView.

### MergeView

Three horizontal columns by conflicting chunk: **local | base | remote**. Each chunk has three buttons:

- **$\leftarrow$ take local**: take the local version
- **take remote $\rightarrow$**: take the remote version
- **reset**: revert to base

A collapsible "Edit merged buffer directly" textarea at the bottom can bypass per-chunk selection to hand-edit the final result.

On submit, both ends are aligned to the merged result:

1. Write the merged result to the trigger side (push-triggered writes the remote, pull-triggered writes the local).
2. Write the same content to the other side.
3. Each side records one sync-marker row of the triggering type (push: `save_type = push`, pull: `save_type = pull`). These are the rows described under Push / Pull above, not extra ones.
