---
id: sd2hh4ns7f773wdv
coconote: true
title: welcome
---

# Coconote

Coconote is a self-hosted markdown notebook. It runs in either of two modes, and both are configured through a single `coconote.yaml`:

- **Desktop app** — a native window with the UI built in. Nothing else to set up.
- **Headless server** — backend HTTP/WS only. Edit from any device by pointing a browser at the server URL and entering the `auth` token.

## coconote.yaml

A single file drives everything:

```yaml
port: 40704
auth: coconote

root:
  main: /Users/main/notes
  secondary: /Users/secondary/notes

url:
  - https://coconote.example.com
```

It has four top-level fields:

- **port** — the HTTP server port.
- **auth** — the bearer token. **Required**; defaults to `coconote` if omitted. Remote browser clients enter it at login. Loopback (`127.0.0.1`) is always exempt, so local desktop clients never present it.
- **root** — local roots, written as a `name -> absolute path` mapping (see below).
- **url** — remote roots, written as a list of server URLs (see below).

`port` and `auth` change only by editing `coconote.yaml` directly — there is no UI for them, and the server must restart for the change to take effect. `root` and `url` can also be managed live from the app — see [[setting]].

### Where it lives

`coconote.yaml` sits in the standard per-user config directory:

- **macOS / Linux** — `~/.config/coconote/` (respects `$XDG_CONFIG_HOME`).
- **Windows** — `%APPDATA%\coconote\`.

The server checks that directory for a parseable `coconote.yaml` on every boot. The desktop app's Setting can redirect the directory to another location.

## Roots (local and remote)

A vault is assembled from roots, and the two kinds coexist:

- **Local root** — one entry under `root:`: a `name -> absolute path` pair whose name you choose. The path must be absolute. For safety the server refuses to mount these system locations: `/`, `/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/boot`, `/proc`, `/sys`, `/dev`, `/System`, `/Library`. Symlinks are resolved before this check.
- **Remote root** — one URL under `url:`, pointing at another coconote server. Connecting to it mounts **all** of that server's roots (its own `root:` mapping) into your vault at once; you don't pick their names — they come from the remote yaml.

### How a file is addressed

Every file has a logical path of this shape:

```
<source URL>/<root name>/<path inside the root>/<filename>
```

`<source URL>` names the server the file lives on:

- a **local** root resolves to your own server, `http://localhost:<port>` (the `port` from your yaml).
- a **url-mounted** root resolves to the matching entry in `url:`.

## Map

Recommended reading order:

- [[file]] — md / pdf / image file formats, frontmatter, and sidecar.
- [[markdown]] — the markdown syntax we render.
- [[pdf]] — PDF reader.
- [[wikilink]] — `[[…]]` link jumps.
- [[editor]] — shortcuts, snippets, autocomplete, hover, and collab.
- [[content]] — Path / Tag / Graph views.
- [[setting]] — settings panel.
- [[history]] — version history, push / pull / merge.
- [[server]] — Server APIs.
