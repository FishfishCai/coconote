---
id: 13pkqgztj5nfhm5k
coconote: true
title: editor
---

# Editor

The editor has three modes — **render** (default), **source**, and **read** — toggled via shortcut. Under render, math / callout / image are displayed as widgets; moving the cursor into a widget's source range expands it back to editable text, and moving out re-folds.

## Shortcuts

The bindings below are the defaults; some can be overridden in setting.

- `Cmd / Ctrl + M`: cycle through render / source / read modes.
- `Tab`: indent (4 spaces) inside a list; **4 literal spaces** otherwise.
- `Shift + Tab`: outdent inside a list; no-op otherwise.
- `Enter`: new line; auto-continues the list marker / blockquote prefix; on an empty bullet, cancels the list (line becomes a blank paragraph).
- `Backspace`: character delete; markdown-aware (deleting the bullet exits the list; deleting `>` exits the blockquote).
- `Cmd / Ctrl + A`: smart select; selects the callout body if the cursor is inside a callout, the code if inside fenced code, the inline code/math content if inside one of those; otherwise selects the whole document.
- `Cmd / Ctrl + Z` / `Cmd / Ctrl + Shift + Z`: undo / redo (Yjs-aware under collab).
- `Cmd / Ctrl + Shift + H`: open the version history panel (see [[history]]).
- `Cmd / Ctrl + Shift + P`: pin the current version (prevents retention pruning; see [[history]]).
- `Cmd / Ctrl + Shift + M`: open the PDF metadata panel (only active in the PDF viewer; see [[pdf]]).
- `Cmd / Ctrl + Shift + C`: go back to the Content page.
- `Cmd / Ctrl + Shift + B`: return to the previous page.
- `Cmd / Ctrl + Click` a link: open in a new tab (browser) / new window (desktop app).
- `Cmd / Ctrl + C / X / V`: copy / cut / paste. When pasting an image from the clipboard, Coconote automatically saves it to the current file's `.<filename>.assets/` folder and inserts a wikilink at the cursor.
- `Cmd / Ctrl + ←/→`: jump to line start / end.
- `Alt + ←/→`: jump by word.
- `Cmd / Ctrl + F`: find.
- `Cmd / Ctrl + D`: next occurrence.

## Snippet

The **Snippet** panel in Setting is a JSON editor; rules are saved to a `snippet.json` file. The lookup path for `snippet.json` is the same as `coconote.yaml` (see [[welcome]]).

```json
[
  { "trigger": "<trigger>", "replacement": "<replacement>", "options": "<flags>" }
]
```

Type the trigger and press **Tab** to expand — unless the `A` flag is set, in which case it expands the moment the trigger is finished.

**Options flags:**

- `m`: math context (`$...$` or `$$...$$`).
- `M`: display math only (`$$...$$`).
- `t`: text only (outside math).
- `A`: auto-expand, no Tab needed.
- `r`: `trigger` is treated as a regex; capture groups are referenced in `replacement` as `[[1]]`, `[[2]]`, ….
- `w`: word boundary. The trigger only fires when preceded by a space, line start, or non-alphanumeric character, preventing it from firing mid-word.

**Cursor placeholders `$0`-`$9`:**

- `$1`, `$2`, …, `$9` are **sequential tab stops**. After expansion the cursor first lands at `$1`; pressing Tab jumps to `$2`; another Tab to `$3`; and so on.
- `$0` is the **final caret**. Once all `$1`-`$9` have been visited, pressing Tab jumps to `$0` and the snippet ends (Tab is no longer captured by the snippet and returns to default behavior).
- `$0` alone also works: `replacement: "\\sum_{$0}^{}"` has only a final caret — after expansion the cursor lands inside the first pair of braces, and pressing Tab exits the snippet directly.
- No `$0`-`$9` at all: cursor stops at the end of the replacement.
- To keep a literal `$0`-`$9`: escape as `$$0`, `$$1`, …, which output as `$0`, `$1`, … respectively.

## Autocomplete

**Bracket auto-completion**

Typing an opening bracket auto-inserts the matching closing bracket after the cursor (`|` marks the cursor position):

- `[` -> `[|]`
- `[[` -> `[[|]]`
- `(` -> `(|)`
- `{` -> `{|}`
- `"` -> `"|"`
- `` ` `` -> `` `|` ``
- `$` -> `$|$` (math context)
- `$$` -> `$$|$$` (display math)

Backspace on an opening bracket: if the adjacent closing bracket was auto-inserted and the pair is empty, both are deleted together; if content exists between them, only the opening bracket is deleted.

**Filename and jump-target autocomplete**

Typing any of the following triggers pops up a live-filtering menu:

- `[[`: page list — candidates surface at the shortest form that uniquely identifies them (minimum-prefix principle; see [[wikilink]]).
- `[[page#`: that page's headings.
- `[[page@`: that page's `@anchor`s.
- `[[page:`: that page's callout labels.
- `[[paper%`: that PDF's highlight anchors.

Press `Tab` or `Enter` to select a candidate; the candidate name replaces the entered prefix, and the cursor stays just before the matching `]]` (already inserted by bracket completion above), letting you continue adding a sigil or `|display` alias.

## Hover preview

Hovering over a `[[…]]` for **500 ms** pops up a preview of the linked content:

- `[[page]]`: full body of `page.md`.
- `[[page#Heading]]`: just that section.
- `[[page@anchor]]`: from the anchor marker to the end of the file.
- `[[page:label]]`: that callout's body, fence stripped.
- `[[paper%name]]`: card with anchor name + page number + highlighted text + comments.
- `[[https://…]]`: no hover.

Hide delay is 100 ms (covers cursor drift); moving onto the popup cancels the timer.

## Collaboration

Two browser windows / tabs (same machine or different) opened on **the same page on the same server** stay in sync — Yjs CRDT, ~50 ms LAN latency. Cursors render as coloured vertical bars (random colour, no identity / name).

- **Offline & reconnect.** When the WS disconnects, the client does not freeze: user input continues to land in the local Yjs doc in real time, and the UI status indicator (green / yellow) reflects the current connection state. The client retries with exponential backoff — 1, 2, 4, 8, 16 seconds doubling, capped at 32 seconds, each delay with jitter to avoid thundering herd. It also listens for `visibilitychange`, `online`, and `focus` events: when the tab becomes visible again / the browser regains network / the window regains focus, an immediate reconnect attempt is triggered regardless of the current backoff timer — so resuming from sleep or a network drop does not have to wait out the backoff. After reconnect, both sides exchange diffs via SyncStep1 / SyncStep2; offline-period edits are auto-merged by the Yjs CRDT.
- **Persistence.** The server checkpoints the current Yjs state to the corresponding markdown file every 5 seconds; an additional write is triggered immediately when the last peer disconnects. On startup / restart, the server uses the on-disk file as the initial Yjs doc state; when a new peer connects, both sides do a full sync that merges any unpushed local state from the client (if any). **Worst-case data loss bound: 5 seconds** (when the crash happens less than 5 seconds after the last checkpoint). If a non-collab write (push / pull / external editor) lands on the file mid-session, peers are dropped on the next checkpoint and re-seed from disk on reconnect; unflushed Yjs edits since the last checkpoint are lost.
- **Message size.** The single WS frame cap is **16 MB**. Typical collab updates are well under this; exceeding it usually means the page should be split. For first-time sync of a very large doc or extra-large pastes, bypass the WS and use `/.file` PUT instead — body size is limited by HTTP config (much higher); see [[server]].