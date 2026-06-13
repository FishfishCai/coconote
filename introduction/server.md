---
id: c1dh0kt9hw0qm47t
coconote: true
title: server
---

# Server

Every Coconote interaction is plain HTTP or WebSocket.

## API

These endpoints can be called directly from a script (no native binding or IPC needed). All endpoints require `auth` token authentication (see [[welcome]]), except loopback (`127.0.0.1`) bypasses it and the health probe `/.health` is always reachable.

- `GET /.health`: returns `{app, version, pid, startedAt, rootPath}`. The desktop shell uses this to probe an existing server. Clients use it to verify a remote url is actually a coconote server.
- `GET /.file`: lists every entry in the current vault. Returns an array. Each item is `{type: "file"|"dir", path, ...}`. File items also carry `page_id`, `title`, and `tag` (each omitted when empty), plus `size` and `mtime` (no body, no hash). Dir items carry no page fields, and their `size` and `mtime` are 0.
- `GET /.file?prefix=<dir-path>`: lists every file under that directory as a flat array of path strings. Unlike the plain listing, dot-prefixed entries (assets folders, sidecars) are included.
- `GET /.file/<path>`: reads a file. Body + `X-*` metadata headers.
- `HEAD /.file/<path>`: same as GET but returns headers only (cheap, use when only metadata is needed).
- `PUT /.file/<path>`: writes a file. Query: `save_type=edit|push|pull` tags the history type for this write (defaults to `edit`, with push / pull set by the cross-server caller). `type=dir` creates an empty directory (no body).
- `DELETE /.file/<path>`: physically deletes the file or an empty directory.
- `GET /.history/<page_id>`: without query, lists snapshots `[{ts, save_type}, ...]`. With `?ts=<ms>`, returns that snapshot's main file text (md body, or PDF sidecar) for the version history panel preview.
- `DELETE /.history/<page_id>?ts=<ms>`: deletes a single version row (any `save_type` can be deleted).
- `POST /.history/<page_id>/restore?ts=<ms>`: writes that snapshot back to the current path and appends a `save_type = edit` row.
- `POST /.history/<page_id>/pin`: clones the latest version row as a labeled checkpoint (same manifest, new ts, `save_type = pin`). Pins are not delete-protected.
- `WS /.collab/<path>?token=<token>`: Yjs sync + awareness. Binary frames only, single-frame cap 16 MB.
- `GET /.config`: returns the active config, including `configDir`, the directory currently holding `coconote.yaml`.
- `PATCH /.config` with `{configDir}`: repoints `configDir` and triggers a self-restart so it takes effect (see [[setting]], Config file section).

History is indexed by page id (frontmatter `id:`), not by path. Files without an id (assets, sidecars, etc.) don't get history rows. Any GET that doesn't match the routes above falls back to the embedded client bundle (static fallback).

## File metadata protocol

GET response headers for `/.file/<path>`:

- `X-Permission`: `ro` / `rw`.
- `X-Last-Modified`: mtime, millisecond epoch (integer string, not RFC 7231).
- `X-Content-Hash`: lowercase hex BLAKE3 of the body bytes. Present on GET responses, absent on `HEAD` responses (to skip the hash cost).

## Conditional GET

```
GET /.file/notes/foo.md
If-Modified-Since: 1717000000000
```

The value is a millisecond epoch, not an RFC 7231 date (see `X-Last-Modified`). If the file's `last_modified` is no later than that value, the server returns `304 Not Modified` with metadata headers and an empty body.

## Optimistic concurrency on PUT

```
PUT /.file/notes/foo.md
X-If-Unmodified-Since: 1717000000000
Content-Type: text/markdown
<body>
```

If the file was modified after that millisecond value, the server returns `409 Conflict` with body `stale write` and current headers (see Errors). Omit the header for unconditional overwrite.

## WebSocket protocol

```
ws://localhost:40704/.collab/notes/foo.md?token=<token>
```

Coconote collab follows the Yjs sync + awareness standard directly, so clients can use `yjs` + `y-websocket` as-is without handling the wire format. Frames are binary Yjs updates. Single-frame cap **16 MB** - the server closes the connection on overflow (normal updates are far smaller, so hitting the cap usually means the page should be split).

## Errors

Coconote-specific error bodies:

- `400 path not in space`: `..` traversal or absolute path
- `409 stale write`: `X-If-Unmodified-Since` mismatch (see Optimistic concurrency)
- collab frame over 16 MB: the server closes the WS connection, and the client should retry with smaller updates

Everything else follows the HTTP standard (`403` auth failure / `404` not found / `405` read-only vault).

## curl examples

```bash
TOK="paste-from-coconote.yaml"
BASE="http://localhost:40704"

# $BASE is loopback here, so the Authorization header below is optional
# (it is required only when $BASE points to a remote coconote url).

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
