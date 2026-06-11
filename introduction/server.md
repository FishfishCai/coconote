---
id: c1dh0kt9hw0qm47t
coconote: true
title: server
---

# Server

Every Coconote interaction is plain HTTP or WebSocket.

## API

No native binding, no IPC — these endpoints can be called directly from a script. All endpoints require `auth` token authentication (see [[welcome]]); loopback (`127.0.0.1`) bypasses it. Probes (`/.health`) are always reachable.

- `GET /.health`: returns `{app, version, pid, startedAt, rootPath}`. The desktop shell uses this to probe an existing server; clients use it to verify a remote url is actually a coconote server.
- `GET /.file`: lists every entry in the current vault. Returns an array; each item is `{type: "file"|"dir", path, ...}`, with file items also carrying `page_id` (empty when there's no id), `title`, `tag`, size, mtime (no body, no hash).
- `GET /.file/<path>`: reads a file. Body + `X-*` metadata headers.
- `HEAD /.file/<path>`: same as GET but returns headers only (cheap; use when only metadata is needed).
- `PUT /.file/<path>`: writes a file. Query: `save_type=edit|push|pull` tags the history type for this write (defaults to `edit`; push / pull is set by the cross-server caller); `type=dir` creates an empty directory (no body).
- `DELETE /.file/<path>`: physically deletes the file or an empty directory.
- `GET /.history/<page_id>`: without query, lists snapshots `[{ts, save_type}, ...]`; with `?ts=<ms>`, returns the main md text of that snapshot (for the version history panel preview).
- `DELETE /.history/<page_id>?ts=<ms>`: deletes a single version row (any `save_type` can be deleted).
- `POST /.history/<page_id>/restore?ts=<ms>`: atomically writes the snapshot's manifest back to the current path, and appends a `save_type = edit` row.
- `POST /.history/<page_id>/pin`: clones the latest version row with a pin tag (same manifest, new ts, `save_type = pin`).
- `WS /.collab/<path>?token=<token>`: Yjs sync + awareness. Binary frames only; single-frame cap 16 MB.
- `GET /.config` also returns `configDir` — the directory currently holding `coconote.yaml`. `PATCH /.config` with `{configDir}` updates the pointer and triggers a self-restart so the new location takes effect (see [[setting]] §Config file).

History is indexed by page id (frontmatter `id:`), not by path. Files without an id (assets, sidecars, etc.) don't get history rows. Any GET that doesn't match the routes above falls back to the embedded client bundle (static fallback).

## File metadata protocol

GET response headers for `/.file/<path>`:

- `X-Permission` — `ro` / `rw`.
- `X-Last-Modified` — mtime, millisecond epoch (integer string, not RFC 7231).
- `X-Content-Hash` — lowercase hex BLAKE3 of the body bytes. Present on GET responses; absent on `HEAD` responses (to skip the hash cost).

## Conditional GET

```
GET /.file/notes/foo.md
If-Modified-Since: 1717000000000
```

If the file's `last_modified` is no later than the given millisecond value, the server returns `304 Not Modified` with metadata headers and an empty body.

## Optimistic concurrency on PUT

```
PUT /.file/notes/foo.md
X-If-Unmodified-Since: 1717000000000
Content-Type: text/markdown
<body>
```

If the file has been modified after that millisecond value, the server returns `409 Conflict` with body `stale write` and current headers. Omit the header for unconditional overwrite.

## WebSocket protocol (collab)

```
ws://localhost:40704/.collab/notes/foo.md?token=<token>
```

Coconote collab follows the Yjs sync + awareness standard directly. Clients can use `yjs` + `y-websocket` as-is — no need to handle the wire format yourself. Single-frame cap **16 MB** — the server closes the connection on overflow (typical collab updates are far below this; hitting the cap usually means the page should be split).

## Errors

Coconote-specific error bodies:

- `400 path not in space` — `..` traversal or absolute path
- `409 stale write` — `X-If-Unmodified-Since` mismatch
- collab frame > 16 MB — the server closes the WS connection; the client should retry with smaller updates

Everything else follows the HTTP standard (`403` auth failure / `404` not found / `405` read-only vault).

## curl examples

```bash
TOK="paste-from-coconote.yaml"
BASE="http://localhost:40704"

# $BASE is loopback here, so auth is bypassed — the Authorization header below is optional;
# it becomes required only when $BASE points to a remote coconote url.

# List entries
curl -s -H "Authorization: Bearer $TOK" "$BASE/.file"

# Read and inspect the hash
curl -i -H "Authorization: Bearer $TOK" "$BASE/.file/main/welcome.md"

# Write
curl -H "Authorization: Bearer $TOK" -X PUT \
     --data "$(cat my-page.md)" \
     "$BASE/.file/main/my-page.md"

# Fetch version history (PAGE_ID comes from the frontmatter id: field)
curl -s -H "Authorization: Bearer $TOK" "$BASE/.history/$PAGE_ID" | jq
```
