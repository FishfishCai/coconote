---
id: sd2hh4ns7f773wdv
coconote: true
title: welcome
---

# Coconote

Coconote is a self-hosted markdown notebook. It runs in either of two modes, both configured through one `coconote.yaml`:

- **Desktop app**: a native window with the UI built in. Nothing else to set up.
- **Headless server**: backend HTTP/WS only. Edit from any device by pointing a browser at the server URL and entering the `auth` token.

## coconote.yaml

```yaml
port: 40704
auth: coconote

root:
  main: /Users/main/notes
  secondary: /Users/secondary/notes

url:
  - https://coconote.example.com
```

Four top-level fields:

- **port**: the HTTP server port.
- **auth**: the bearer token. **Required**, and defaults to `coconote` if omitted. Remote browser clients enter it at login. Loopback (`127.0.0.1`) is always exempt, so local desktop clients never present it.
- **root**: local roots, as a `name -> absolute path` mapping (see below).
- **url**: remote roots, as a list of server URLs (see below).

`port` and `auth` change only by editing `coconote.yaml` directly (no UI), and the server must restart to pick them up. `root` and `url` are also editable live from the app (see [[setting]]).

The file lives in the standard per-user config directory: `~/.config/coconote/` on macOS / Linux (honouring `$XDG_CONFIG_HOME`), or `%APPDATA%\coconote\` on Windows. The server checks it for a parseable `coconote.yaml` on every boot. The desktop app's Setting can redirect it elsewhere.

## Roots (local and remote)

A vault is built from roots of two kinds, which coexist:

- **Local root**: one entry under `root:`, a `name -> absolute path` pair whose name you choose. The path must be absolute, and the server refuses to mount these system locations: `/`, `/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/boot`, `/proc`, `/sys`, `/dev`, `/System`, `/Library`. Symlinks are resolved before this check.
- **Remote root**: one URL under `url:`, pointing at another coconote server. Connecting mounts **all** of that server's roots (its own `root:` mapping) into your vault at once. You don't choose their names, which come from the remote yaml.

Every file then has a logical path of the shape:

```
<source URL>/<root name>/<path inside the root>/<filename>
```

where `<source URL>` is the server the file lives on: your own server (`http://localhost:<port>`, the `port` from your yaml) for a local root, or the matching `url:` entry for a url-mounted one.

## Map

Recommended reading order:

- [[file]]: md / pdf / image file formats, frontmatter, and sidecar.
- [[markdown]]: the markdown syntax we render.
- [[pdf]]: PDF reader.
- [[wikilink]]: `[[...]]` link jumps.
- [[editor]]: shortcuts, snippets, autocomplete, hover, and collab.
- [[content]]: Path / Tag / Graph views.
- [[setting]]: settings panel.
- [[history]]: version history, push / pull / merge.
- [[server]]: Server APIs.
