---
id: 7hy5s2t0szpe214m
coconote: true
title: setting
---

# Setting

Open the settings panel at the in-app route `/.setting` (type it as a path in the address bar). Every choice is persisted to `localStorage`.

## Appearance

- **Dark mode**: flips `data-theme` between `light` / `dark` on the document root. Follows OS preference on first run. Key: `coconote.darkMode`.
- **Font size** (12 - 28 px): CSS variable `--editor-font-size`.
- **Content width** (28 - 80 rem): CSS variable `--editor-width`.
- Colour rows
    - **Accent**: `--accent-h/s/l` (the three HSL components). Active links, primary buttons, and focus rings use this colour. Stored as HSL so hover and selection variants can use different saturations.
    - **Highlight**: `--editor-highlight-background-color`. The yellow of `==marker==`.
    - **Missing link**: `--editor-wiki-link-missing-color`. The red dashed underline of an unresolved `[[...]]`.
    - **Code background**: `--editor-code-background-color`. Background for inline + fenced code blocks.
    - **Hover background**: `--background-secondary-alt`. Button hover, modal hint hover, settings group hover.
- Font
    - **Prose font**: body and most markdown.
    - **UI font**: chrome surfaces (status chip, content browser, settings).
    - **Monospace font**: code block, inline code, math fallback.

Each accepts a full CSS `font-family` value, e.g. `Inter, system-ui, sans-serif`. Leave empty to fall back to the theme default.

## Snippet

A snippet is a user-defined editing or rendering rule (see [[editor]]). This panel is an embedded JSON editor for those rules and saves when it loses focus. The edited JSON is compiled into rules that take effect the next time you open a page.

## Shortcut

Bind custom keybindings. The panel lists every configurable action and its current binding. Each action can have several key combinations (e.g. `Cmd+K`, `Ctrl+Shift+P`). Changes take effect immediately.

Conflict handling: if a combination is already used by another action, the UI flags the clash and you must unbind the original before saving.

Saved to `localStorage["coconote.userPrefs"].shortcuts`. Only Coconote's custom navigation and mode actions are rebindable. Markdown-editing keys (`Tab` / `Enter` / `Backspace`) and system-level shortcuts (undo / redo / copy-paste / find / cursor motion, etc.) use the defaults and cannot be rebound.

Rebindable actions:

- **Mode switch** (cycle the editor through render, source, and read views): default `Cmd / Ctrl + M`.
- **Open version history panel**: default `Cmd / Ctrl + Shift + H`.
- **Pin current version** (keeps a version from being auto-deleted by retention, see [[history]]): default `Cmd / Ctrl + Shift + P`.
- **Open PDF metadata panel** (only active in the PDF viewer, see [[pdf]]): default `Cmd / Ctrl + Shift + M`.
- **Back to Content page**: default `Cmd / Ctrl + Shift + C`.
- **Back to previous page**: default `Cmd / Ctrl + Shift + B`.
- **Forward to next page**: default `Cmd / Ctrl + Shift + F`.
- **Open Settings**: default `Cmd / Ctrl + Shift + S`.

## Local

Lists the local roots configured in `coconote.yaml`'s `root:` (a root is a top-level source folder, defined in [[welcome]]). The header has `+` to add a root, each row has `−` to remove. Validation rules and the yaml schema are also in [[welcome]]. Every add and remove rewrites `coconote.yaml` atomically and reloads the file index in place, with no restart.

- Add `+`: a modal asks for the root's **name** and **absolute path**.
- Remove `−`: confirm, and the entry is dropped.

## Remote

Lists the remote URLs configured in `coconote.yaml`'s `url:`. The `+ / −` UI and the atomic yaml rewrite behave the same as Local, on the `url:` list instead of `root:`.

- Add `+`: a modal asks for the URL (`http(s)://host:port`, no trailing slash) and an optional token (saved as the remote's `auth` field, sent when contacting it). `Add` probes `/.health` to confirm the other side really is a coconote server.
- Remove `−`: confirm, and the entry is dropped.

After a successful add, every root of that remote appears in the unified Content browser (see [[content]]).

## Config file

Shows the **directory** where `coconote.yaml` lives (default = the OS standard config directory). Edit the path and click `Reset` to point at a new directory, which restarts the server. On startup the server reads `<dir>/coconote.yaml`. If it is missing or unparseable, the server writes a fresh default there.
