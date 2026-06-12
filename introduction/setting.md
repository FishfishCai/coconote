---
id: 7hy5s2t0szpe214m
coconote: true
title: setting
---

# Setting

Visit the in-app route `/.setting` to open the settings panel. Every choice is persisted to `localStorage`.

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
    - **UI font**: status chip, content browser, settings.
    - **Monospace font**: code block, inline code, math fallback.

Each accepts a full CSS `font-family` value, e.g. `Inter, system-ui, sans-serif`. Leave empty to fall back to the theme default.

## Snippet

Embedded JSON editor for snippets (user-defined editing and rendering rules, full syntax in [[editor]]). Saves on blur. Compiled rules take effect the next time you open a page.

## Shortcut

Bind custom keybindings. The panel lists every configurable action with its current binding. Each action has exactly one combination: click the binding and press the new keys to record it (`Escape` cancels), or reset it to the default. Changes take effect immediately.

Conflict handling: if a combination is already used by another action, the UI highlights both rows and blocks saving until one of them is rebound.

Saved to `localStorage["coconote.userPrefs"].shortcuts`. Only Coconote's custom navigation and mode actions are rebindable. Markdown-editing keys (`Tab` / `Enter` / `Backspace`) and system-level shortcuts (undo / redo / copy-paste / find / cursor motion, etc.) use the defaults and cannot be rebound.

Rebindable actions:

- **Cycle render / source / read** (the editor mode switch): default `Cmd / Ctrl + M`.
- **Open version history panel**: default `Cmd / Ctrl + Shift + H`.
- **Pin current version** (prevents retention pruning, see [[history]]): default `Cmd / Ctrl + Shift + P`.
- **Open PDF metadata panel** (only active in the PDF viewer, see [[pdf]]): default `Cmd / Ctrl + Shift + M`.
- **Export** (the open page: md as self-contained HTML, PDF with highlights baked in, see [[content]]): default `Cmd / Ctrl + Shift + E`.
- **Back to previous page**: default `Cmd / Ctrl + Shift + B`.
- **Forward to next page**: default `Cmd / Ctrl + Shift + F`.
- **Open Content** (the Content page): default `Cmd / Ctrl + Shift + C`.
- **Open Setting**: default `Cmd / Ctrl + Shift + S`.

## Local

Lists the local roots configured in `coconote.yaml`'s `root:`. The header has `+` to add a root, each row has `−` to remove. Validation rules and the yaml schema are in [[welcome]]. Every add and remove rewrites `coconote.yaml` atomically and reloads the file index in place, with no restart.

- Add `+`: a modal asks for the root's **name** and **absolute path**.
- Remove `−`: confirm, and the entry is dropped.

## Remote

Lists the remote URLs configured in `coconote.yaml`'s `url:`. The `+ / −` UI and the atomic yaml rewrite behave the same as Local, on the `url:` list instead of `root:`.

- Add `+`: a modal asks for the URL (`http(s)://host:port`, no trailing slash) and an optional token (saved as the remote's `auth` field, sent when contacting it). `Add` probes `/.health` to confirm the other side really is a coconote server.
- Remove `−`: confirm, and the entry is dropped.

After a successful add, every root of that remote appears in the unified Content browser (see [[content]]).

## Config file

Shows the **directory** where `coconote.yaml` lives (default = the OS standard config directory). Edit the path and click `Reset` to point at a new directory, which restarts the server. On startup the server reads `<dir>/coconote.yaml`. If it is missing or unparseable, the server writes a fresh default there.
