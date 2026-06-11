---
id: 7hy5s2t0szpe214m
coconote: true
title: setting
---

# Setting

Visit `/.setting` to open the settings panel. Every choice is persisted to `localStorage`.

## Appearance

- **Dark mode**: flips `data-theme` between `light` / `dark` on the document root. Follows OS preference on first run. Key: `coconote.darkMode`.
- **Font size** (12 – 28 px): CSS variable `--editor-font-size`.
- **Content width** (28 – 80 rem): CSS variable `--editor-width`.
- Colour rows
    - **Accent**: `--accent-h/s/l` (HSL three components). Active links, primary buttons, and focus rings use this colour. Stored as HSL so hover / selection variants can be derived at different saturations.
    - **Highlight**: `--editor-highlight-background-color`. The yellow of `==marker==`.
    - **Missing link**: `--editor-wiki-link-missing-color`. The red dashed underline of unresolved `[[…]]`.
    - **Code background**: `--editor-code-background-color`. Background for inline + fenced code blocks.
    - **Hover background**: `--background-secondary-alt`. Button hover, modal hint hover, settings group hover.
- Font
    - **Prose font**: body / most markdown.
    - **UI font**: chip, content browser, settings.
    - **Monospace font**: code block, inline code, math fallback.

Each accepts a full CSS `font-family` value, e.g. `Inter, system-ui, sans-serif`; leave empty to fall back to the theme default.

## Snippet

Embedded JSON editor; saves on blur. Compiled rules take effect the next time you open a page (no reload needed). Full syntax in [[editor]].

## Shortcut

Bind custom keybindings. The panel lists every configurable action with its current binding; each action can be bound to a set of key combinations (e.g. `Cmd+K`, `Ctrl+Shift+P`). Changes take effect immediately.

Conflict handling: if the same combination is already taken by another action, the UI highlights the clash and requires unbinding the original before submitting.

Saved to `localStorage["coconote.userPrefs"].shortcuts`. Only Coconote's custom navigation / mode actions are rebindable; markdown-editing keys (`Tab` / `Enter` / `Backspace`) and system-level shortcuts (undo / redo / copy-paste / find / cursor motion, etc.) use the defaults and cannot be rebound.

Rebindable actions:

- **Mode switch** (cycle through render / source / read): default `Cmd / Ctrl + M`.
- **Open version history panel**: default `Cmd / Ctrl + Shift + H`.
- **Pin current version** (prevents retention pruning; see [[history]]): default `Cmd / Ctrl + Shift + P`.
- **Open PDF metadata panel** (only active in the PDF viewer; see [[pdf]]): default `Cmd / Ctrl + Shift + M`.
- **Back to Content page**: default `Cmd / Ctrl + Shift + C`.
- **Back to previous page**: default `Cmd / Ctrl + Shift + B`.

## Local

Lists the local roots configured in `coconote.yaml`'s `root:`. The header has `+` to add a root; each row has `−` to remove. Validation rules and the yaml schema are in [[welcome]].

- Add `+`: a modal asks for the root's **name** + **absolute path**, then writes back to `coconote.yaml` and atomically reloads the file index — no restart needed.
- Remove `−`: confirm and the entry is dropped; the yaml is also atomically rewritten.

## Remote

Lists the remote URLs configured in `coconote.yaml`'s `url:`. `+ / −` UI is the same as Local.

- Add `+`: a modal asks for the URL (`http(s)://host:port`, no trailing slash) and an optional token (used as the remote's `auth`). `Add` probes `/.health` to confirm the other side really is a coconote server.
- Remove `−`: confirm and the corresponding entry in `coconote.yaml`'s `url:` list is atomically removed.

After a successful add, every root of that remote appears in the unified Content browser (see [[content]]).

## Config file

Shows the **directory** where `coconote.yaml` lives (default = standard config dir). Edit + `Reset` to redirect and restarts. On startup the server reads `<dir>/coconote.yaml`; if it's missing or unparseable, it writes a fresh default in place.
