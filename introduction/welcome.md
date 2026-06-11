---
id: sd2hh4ns7f773wdv
coconote: true
title: welcome
---

# Coconote

A self-hosted markdown notebook, shipping as a desktop app or a headless server. Both modes are configured through `coconote.yaml`.

- **Desktop app** — launches a native window with the UI embedded.
- **Headless server** — backend HTTP/WS only; edit remotely via a browser pointed at the server URL after entering the `auth` token.

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

- **port** — HTTP server port.
- **auth** — bearer token. **Required**; defaults to `"coconote"` if omitted. Browser clients on remote instances enter this value at login. Loopback (`127.0.0.1`) is always exempt — local desktop clients never need to present it.
- **root** — mapping for local roots. See below.
- **url** — list for remote roots. See below.

`port` and `auth` can only be changed by editing `coconote.yaml` directly (no UI). Restart the server for changes to take effect.

`coconote.yaml` lives in the standard per-user config dir: `~/.config/coconote/` on macOS / Linux (respects `$XDG_CONFIG_HOME`), `%APPDATA%\coconote\` on Windows. On every boot the server checks that dir for a parseable `coconote.yaml`. The desktop app's Setting can redirect this directory.

## Roots (local + remote)

The two kinds of root coexist in one vault:

- **Local root** — `root:` is a `name - absolute path` mapping; you choose the name. Local roots must be absolute paths; the server rejects these dangerous mount points: `/`、`/etc`、`/var`、`/usr`、`/bin`、`/sbin`、`/boot`、`/proc`、`/sys`、`/dev`、`/System`、`/Library`. Symlinks are resolved before validation.

- **Remote root** — `url:` is a list of URLs, each pointing to a remote coconote server. Connecting to one mounts **all of that server's roots** (its own `root:` mapping) into your vault wholesale; you don't pick the names — they come from the remote yaml.

Each file's logical path looks like: `<source URL>/<rootname>/<relative path inside the root>/<filename>`

`<source URL>` is the URL of the server that file lives on — for a local root it's your own server (`http://localhost:<port>`, where port comes from yaml); for a url-mounted root it's the corresponding entry in `url:`.


## Map

Recommended reading order:

- [[file]] — md / pdf / image file formats, frontmatter, and sidecar.
- [[markdown]] — the markdown syntax we render.
- [[pdf]] — PDF reader.
- [[wikilink]] — `[[…]]` link jumps.
- [[editor]] — shortcuts, snippets, autocomplete, hover and collab.
- [[content]] — Path / Tag / Graph views.
- [[setting]] — settings panel.
- [[history]] — version history, push / pull / merge.
- [[server]] — Server APIs.
