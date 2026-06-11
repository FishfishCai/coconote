<p align="center">
  <img src="electron/icons/icon.png" alt="Coconote" width="180" />
</p>

<h1 align="center">Coconote</h1>

<p align="center">
  A self-hosted markdown notebook — local-first, live collaborative, with built-in PDF reader, wikilinks, history, and a desktop app on every platform.
</p>

---

## About

Coconote is a self-hosted markdown notebook designed for technical writing. Highlights:

- **Markdown + math + callouts** rendered inline (KaTeX, custom callout blocks for theorem / definition / proof / etc.)
- **Wikilinks** with shortest-prefix autocomplete and hover previews; cross-links every doc to every doc
- **PDF reader** with highlight / anchor / comment support; PDFs link back into your markdown via `[[paper.pdf%anchor]]`
- **Live collaboration** via Yjs over WebSocket — open the same page in two tabs and watch the cursors merge
- **Version history** with `create` / `edit` / `push` / `pull` / `pin` save types, three-way merge for cross-vault sync, and time-window retention pruning
- **Snippet expansion** (LaTeX-style, with regex / math-context / word-boundary flags)
- **Electron desktop app** for native macOS / Windows / Linux, plus a headless server mode for browser access from any device on your network

## Download

Each release ships pre-built artifacts on the [Releases page](https://github.com/FishfishCai/coconote/releases).

### Headless server binaries (6 targets)

The server is a single static-friendly binary that serves both the HTTP API and the built-in web client. Unpack and run it, then open the URL it logs in any browser. First launch auto-creates `coconote.yaml` in the standard per-user config dir; point it at your vault via Setting → Local in the UI or by editing that file.

| OS | Architecture | Archive |
|---|---|---|
| macOS | arm64 (Apple Silicon) | `coconote-server-vX.Y.Z-darwin-aarch64.zip` |
| macOS | x86_64 (Intel) | `coconote-server-vX.Y.Z-darwin-x86_64.zip` |
| Linux (gnu) | x86_64 | `coconote-server-vX.Y.Z-linux-x86_64.zip` |
| Linux (gnu) | arm64 | `coconote-server-vX.Y.Z-linux-aarch64.zip` |
| Linux (musl, static) | x86_64 | `coconote-server-vX.Y.Z-linux-musl-x86_64.zip` |
| Windows | x86_64 | `coconote-server-vX.Y.Z-windows-x86_64.zip` |

### Desktop app (3 installers)

The desktop app bundles a sidecar server, so no separate server install is needed; first launch writes a default `coconote.yaml` under the standard per-user config dir (`~/.config/coconote/` on macOS/Linux, `%APPDATA%\coconote\` on Windows) — see `introduction/setting.md` §Config file to redirect it.

| OS | Installer |
|---|---|
| macOS | `coconote-vX.Y.Z-darwin-aarch64.dmg` |
| Linux | `coconote-vX.Y.Z-linux-x86_64.deb` or `.AppImage` |
| Windows | `coconote-vX.Y.Z-windows-x86_64.exe` |

> **Not notarized.** The macOS app is ad-hoc signed (no Apple Developer ID),
> so Gatekeeper flags the first launch as an unidentified developer:
> right-click the app → Open, or run
> `xattr -dr com.apple.quarantine /Applications/Coconote.app`.
> On Windows the build is unsigned — SmartScreen may warn, choose
> "More info → Run anyway". Linux packages are unaffected.

## Documentation

The user manual / walkthrough lives in a separate `introduction/` folder. Download it, drop it under your vault root, and read every feature page.

## License

This project is released under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. You may use, copy, modify, and redistribute the source code freely under the terms of the license. The AGPL is a strong copyleft license: any modified version of Coconote that you make available to users — including over a network (e.g., hosted as a web service) — must also be released under AGPL-3.0 with the complete corresponding source code made available to those users. The full license text is in [`LICENSE`](./LICENSE) and at <https://www.gnu.org/licenses/agpl-3.0.html>.
