<p align="center">
  <img src="electron/icons/icon.png" alt="Coconote" width="180" />
</p>

<h1 align="center">Coconote</h1>

<p align="center">
  A self-hosted notebook where your markdown notes and your PDFs are first-class peers: read, annotate, link, and collaborate on both, all from files you own.
</p>

---

## About

Coconote is a self-hosted notebook that treats markdown notes and PDFs as equals. You write in markdown and read PDFs in the same app, link freely between them, and keep everything in plain files on your own machine. Both kinds of document get real-time collaboration and full version history, so the same workflow covers your notes and the papers you read.

What makes it stand out:

- **Markdown and PDF side by side.** Write notes in markdown or read a PDF, then link between them. A PDF can be highlighted, anchored, and commented, and those anchors link straight back into your notes.
- **One workflow for both.** Real-time collaboration and version history work for markdown files and PDFs alike, not just for notes.
- **Wikilinks and graph view.** Cross-link any document to any other with `[[...]]`, follow hover previews, and see how your vault connects in a graph view.
- **Rich markdown.** Inline math (KaTeX), callout blocks for theorem, definition, and proof, plus snippet expansion for fast typing.
- **Self-hosted, files you own.** Run the native desktop app on macOS, Windows, or Linux, or run a headless server and reach your vault from any browser on your network. Your notes stay as plain markdown and PDF files on disk.

## Download

Each release ships pre-built artifacts on the [Releases page](https://github.com/FishfishCai/coconote/releases).

### Headless server binaries (6 targets)

The server is a single static-friendly binary that serves both the HTTP API and the built-in web client. Unpack and run it, then open the URL it logs in any browser. First launch auto-creates `coconote.yaml` in the standard per-user config dir. Point it at your vault via Setting -> Local in the UI or by editing that file.

| OS | Architecture | Archive |
|---|---|---|
| macOS | arm64 (Apple Silicon) | `coconote-server-vX.Y.Z-darwin-aarch64.zip` |
| macOS | x86_64 (Intel) | `coconote-server-vX.Y.Z-darwin-x86_64.zip` |
| Linux (gnu) | x86_64 | `coconote-server-vX.Y.Z-linux-x86_64.zip` |
| Linux (gnu) | arm64 | `coconote-server-vX.Y.Z-linux-aarch64.zip` |
| Linux (musl, static) | x86_64 | `coconote-server-vX.Y.Z-linux-musl-x86_64.zip` |
| Windows | x86_64 | `coconote-server-vX.Y.Z-windows-x86_64.zip` |

### Desktop app (3 installers)

The desktop app bundles a sidecar server, so no separate server install is needed. First launch writes a default `coconote.yaml` under the standard per-user config dir (`~/.config/coconote/` on macOS/Linux, `%APPDATA%\coconote\` on Windows). See the Config file section of `introduction/setting.md` to redirect it.

| OS | Installer |
|---|---|
| macOS | `coconote-vX.Y.Z-darwin-aarch64.dmg` |
| Linux | `coconote-vX.Y.Z-linux-x86_64.deb` or `.AppImage` |
| Windows | `coconote-vX.Y.Z-windows-x86_64.exe` |

> **Not notarized.** The macOS app is ad-hoc signed (no Apple Developer ID),
> so Gatekeeper flags the first launch as an unidentified developer:
> right-click the app -> Open, or run
> `xattr -dr com.apple.quarantine /Applications/Coconote.app`.
> On Windows the build is unsigned, so SmartScreen may warn: choose
> "More info -> Run anyway". Linux packages are unaffected.

## Documentation

The user manual and walkthrough live in the [`introduction/`](./introduction/) folder of this repository. Download that folder, drop it under your vault root, and open it in Coconote to read every feature page. A good starting point is [`introduction/welcome.md`](./introduction/welcome.md), which lists the recommended reading order.

## License

This project is released under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. You may use, copy, modify, and redistribute the source code freely under the terms of the license. The AGPL is a strong copyleft license: any modified version of Coconote that you make available to users (including over a network, for example hosted as a web service) must also be released under AGPL-3.0 with the complete corresponding source code made available to those users. The full license text is in [`LICENSE`](./LICENSE) and at <https://www.gnu.org/licenses/agpl-3.0.html>.
