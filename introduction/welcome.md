---
id: sd2hh4ns7f773wdv
coconote: true
title: welcome
---

# Coconote

A self-hosted markdown notebook, running as a desktop app or a headless server. Both modes are configured through `coconote.yaml`.

- **Desktop app**: a native window that runs the server internally and shows the UI.
- **Headless server**: backend HTTP/WS only. Edit remotely via a browser pointed at the server URL after entering the `auth` token.

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
- **auth**: the bearer token. Defaults to `coconote` if omitted. Remote browser clients enter it at login. Loopback (`127.0.0.1`) is always exempt, so local desktop clients never present it.
- **root**: local roots, as a `name -> absolute path` mapping (see below).
- **url**: remote roots, as a list of server URLs (see below).

`port` and `auth` can only be changed by editing `coconote.yaml` directly (no UI), and the server must restart for changes to take effect. `root` and `url` are also editable live from the app (see [[setting]]).

`coconote.yaml` lives in the standard per-user config dir: `~/.config/coconote/` on macOS / Linux (respects `$XDG_CONFIG_HOME`), `%APPDATA%\coconote\` on Windows. On every boot the server checks that dir for a parseable `coconote.yaml`. The desktop app's Setting can redirect this directory.

## Roots (local and remote)

The two kinds of root coexist in one vault:

- **Local root**: an entry under `root:`, a `name -> absolute path` pair whose name you choose. The path must be absolute, and the server refuses to mount `/` or these system trees, including anything under them: `/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/boot`, `/proc`, `/sys`, `/dev`, `/System`, `/Library`. Symlinks are resolved before this check.
- **Remote root**: a URL under `url:`, pointing at another coconote server. Connecting mounts **all** of that server's roots (its own `root:` mapping) into your vault at once. You don't pick the names, which come from the remote yaml.

Every file's logical path looks like:

```
<source URL>/<root name>/<path inside the root>/<filename>
```

`<source URL>` is the server the file lives on: your own server (`http://localhost:<port>`, port from yaml) for a local root, or the matching `url:` entry for a url-mounted one. For example, `intro.md` under your local `main` root is `http://localhost:40704/main/.../intro.md`.

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
