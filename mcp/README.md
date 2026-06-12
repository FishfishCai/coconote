# coconote-mcp

An MCP (Model Context Protocol) stdio server that lets AI agents read and
edit a Coconote vault through the existing server HTTP / WebSocket API:
vault listing and search, page CRUD, live collab edits, includes, imports,
images, version history, rename with wikilink refactor, PDF text extraction
and highlights, and cross-server push / pull.

## Quickstart

Get the server bundle one of two ways:

- Repo checkout: `cd mcp && npm ci && npm run build` produces
  `mcp/dist/index.js` (plus `dist/pdf.worker.mjs` next to it).
- Release artifact: unzip `coconote-mcp-vX.Y.Z.zip` from a GitHub
  release. It contains `coconote-mcp/index.js`, `pdf.worker.mjs`, and
  this README, no build step needed.

Both layouts keep `pdf.worker.mjs` next to `index.js`, so point `node`
at whichever `index.js` you have. Claude Code:

```bash
# repo checkout
claude mcp add coconote --env COCONOTE_URL=http://localhost:40704 \
  -- node <abs>/mcp/dist/index.js

# unzipped release artifact
claude mcp add coconote --env COCONOTE_URL=http://localhost:40704 \
  -- node <abs>/coconote-mcp/index.js
```

Remote Coconote server (the token is required off loopback, copy it from
the server's `coconote.yaml`):

```bash
claude mcp add coconote \
  --env COCONOTE_URL=https://notes.example.com \
  --env COCONOTE_TOKEN=paste-from-coconote.yaml \
  -- node <abs>/coconote-mcp/index.js
```

Any other MCP client (Claude Desktop `claude_desktop_config.json`,
Cursor, `.mcp.json`, ...) takes the same generic shape:

```json
{
  "mcpServers": {
    "coconote": {
      "command": "node",
      "args": ["<abs>/mcp/dist/index.js"],
      "env": {
        "COCONOTE_URL": "http://localhost:40704",
        "COCONOTE_TOKEN": "paste-from-coconote.yaml"
      }
    }
  }
}
```

Replace `<abs>` with an absolute path (the repo for `mcp/dist/index.js`,
the unzip location for `coconote-mcp/index.js`). Drop `COCONOTE_TOKEN`
for a localhost server. `npm install -g <path-to-mcp-dir>` also works
and puts a `coconote-mcp` command on PATH (same env vars).

## Build

```bash
cd mcp
npm ci
npm run check   # tsc --noEmit
npm run build   # bundles to dist/index.js + dist/pdf.worker.mjs
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `COCONOTE_URL` | `http://localhost:40704` | Base URL of the Coconote server, scheme required. The collab WebSocket URL is derived from it (`http` -> `ws`, `https` -> `wss`). |
| `COCONOTE_TOKEN` | unset | Auth token from `coconote.yaml`. Optional on loopback (the server exempts `127.0.0.1`), REQUIRED for remote servers. Sent as `Authorization: Bearer` on HTTP and `?token=` on the collab WebSocket. |

At startup the process probes `GET /.health` and the vault listing, and
exits 1 with a one-line stderr message when the URL is unreachable, does
not answer like a Coconote server, or rejects the token. After that,
network failures surface per tool call with the same actionable wording.
stdout carries only the MCP JSON-RPC stream, all logging goes to stderr.

## Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `list_pages` | `prefix?`, `all?` | Vault listing mapped to `{path, title, tags, headings, wikilinks, size, mtime}`, dir rows dropped. `prefix` narrows to one folder subtree. `all: true` adds the supported files not in the Coconote index (the app's All view), their rows marked `included: false`. |
| `search_pages` | `query`, `all?` | Case-insensitive filter over path / title / tags / headings (the same fields the app filter uses). `all: true` extends the search to excluded files (matches marked `included: false`). |
| `read_page` | `path` | `{content, id, lastModified}` of a page (id from frontmatter / sidecar metadata, mtime from `X-Last-Modified`). Errors on `.pdf` and points at `read_pdf_text`. |
| `edit_page` | `path`, `edits[{old_str, new_str}]` | Targeted replacements over live collab. Every `old_str` must match exactly once (progressively), otherwise nothing is applied. |
| `write_page` | `path`, `content` | Full rewrite over live collab, applied as a minimal diff. Refuses to drop or change an existing page id. |
| `create_page` | `path`, `content?` | New markdown page with `coconote: true` and no id. Flips the key on an existing excluded file, errors when already included. |
| `create_folder` | `path` | `PUT ?type=dir`. |
| `set_included` | `path`, `included` | md: flips frontmatter `coconote`. pdf: flips or creates the sidecar (fresh include sidecars get a generated id, like the app). |
| `delete_page` | `path` | Physical delete of a file or an empty folder, plus best-effort companion cleanup (md assets folder, pdf sidecar). |
| `import_file` | `source`, `dest_path`, `include?` | Copy a local file or URL into the vault (50MB cap). `include` (default true): md gets `coconote: true` ensured, `.pdf` gets its include sidecar. `false`: raw bytes only. |
| `add_image` | `page_path`, `source`, `name?` | Upload an image (25MB cap) into the page's `.<stem>.assets/` folder with name dedupe, returns the `![[name]]` snippet. |
| `page_history` | `path`, `ts?` | Version list for the page's id, or one snapshot's text with `ts`. |
| `restore_version` | `path`, `ts` | `POST /.history/<id>/restore?ts=`. |
| `pin_version` | `path` | `POST /.history/<id>/pin`. |
| `delete_version` | `path`, `ts` | `DELETE /.history/<id>?ts=`. |
| `rename_page` | `path`, `new_path` | Move inside the same root (no clobber, rollback on failure), carry the assets folder / sidecar along, then rewrite every `[[wikilink]]` that resolved to the old name. Returns `{moved, linksRewritten}`. |
| `rename_folder` | `old_path`, `new_path` | Batch move: every included page under `old_path` goes to `new_path` (same root, no clobber, companions follow), then one vault-wide link pass repairs all broken `[[wikilink]]`s. Files not in Coconote stay in the old folder (noted in the result). |
| `read_pdf_text` | `path`, `pages?` | pdfjs text extraction, returned as `[page N]` blocks. |
| `add_pdf_highlight` | `path`, `quote`, `color?`, `anchor?`, `comment?`, `page?` | Find the quote (whitespace-insensitive, must be unique - `page` disambiguates), compute top-left-normalized rects, and append highlight + optional anchor / comment to the sidecar over live collab. Returns `{highlightId, anchorLink?}`. |
| `remove_pdf_highlight` | `path`, `highlight_id` | Remove the highlight from the sidecar over live collab, cascading to its anchors and comments (the app's right-click Remove highlight). Unknown ids error with the existing ids listed. |
| `push_page` | `path`, `target_url`, `target_root`, `target_token?`, `overwrite?`, `merged_content?` | history.md Push: direct upload / fast-forward / diff3 auto-merge. Structured outcomes: `pathCollision` (re-call with `overwrite: true`) and `conflict` (returns base/local/remote texts, re-call with `merged_content` to commit both sides as `save_type=push`). |
| `pull_page` | `remote_url`, `remote_path`, `target_root`, `remote_token?`, `overwrite?`, `merged_content?` | Mirror of `push_page` (history.md Pull), landing remote pages in a local root with `save_type=pull` rows. |
| `export_page` | `path`, `dest` | The app's Export action. `.md`: one self-contained offline HTML file (CSS / fonts / vault images inlined, static math, wikilinks degraded), `dest` must end in `.html`. `.pdf`: a copy with its sidecar highlights baked into the pages, `dest` must end in `.pdf`. Written to `dest` on the MCP host machine (absolute path, parent dir created). Returns `{dest, bytes}`. |
| `get_syntax` | `topic` | Full syntax reference for `markdown` / `wikilink` / `file` / `pdf` (from `guide/*.full.md`). |

Any tool that resolves a vault path appends up to 3 similar known paths to
its 404 error, so a typo'd path is self-correcting.

## How live edits work (src/collab.ts)

`edit_page` / `write_page` join the page's room at `WS /.collab/<path>`
with a minimal hand-rolled Yjs sync client (`ws` + `y-protocols`), modeled
on the product's own client in `client/collab/collab_extension.ts`. Flow:
connect, SyncStep1, wait for the server's SyncStep2 (initial content),
mutate the `Y.Text` named `content` in one transaction, then send one more
SyncStep1 and wait for its SyncStep2 before disconnecting. The server
processes frames in arrival order and answers SyncStep1 inline, so that
final reply proves every update was applied server-side. The server's
last-client-out flush then persists the page to disk.

y-websocket was evaluated and not used: its v3 URL building does keep room
slashes intact, but it cannot confirm a server ack (this server never
echoes an update back to its sender, so the prescribed update-echo check
can never fire) and it converts auth failures into silent endless
reconnects instead of an error. Both matter for one-shot tool calls.

The same room path scheme covers PDF sidecars (`WS /.collab/<dir>/.<stem>.json`):
the server seeds any UTF-8 file into a room, so `add_pdf_highlight` rides the
identical sync barrier when it appends to the sidecar.

## Syntax guides (guide/)

`guide/*.short.md` are the dense write-contracts injected into the server's
MCP `instructions`, `guide/*.full.md` are the full references served by
`get_syntax`. Both are distilled from `introduction/{markdown,wikilink,file,pdf}.md`
and bundled as text at build time (`--loader:.md=text`).
