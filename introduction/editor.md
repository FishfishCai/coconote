---
id: 13pkqgztj5nfhm5k
coconote: true
title: editor
---

# Editor

The editor has three modes (toggled via shortcut): **render** (default), **source**, and **read**. Under render, math, table, callout (a labeled block, see [[markdown]]), and image are shown as widgets. Moving the cursor into a widget shows its source text, and moving out re-folds it.

Two dots sit at the top right: the collab status dot (see Collaboration below) and a mode dot showing the active editor mode - green for render, orange for source, blue for read, grey when the current view is not a markdown editor (Content, Setting, PDF).

## Shortcuts

The bindings below are the defaults. Some can be overridden in setting.

- `Cmd / Ctrl + M`: cycle through render / source / read modes.
- `Tab`: indent (4 spaces) inside a list, **4 literal spaces** otherwise.
- `Shift + Tab`: outdent inside a list, no-op otherwise.
- `Enter`: new line. Auto-continues the list marker / blockquote prefix. On an empty bullet, cancels the list (line becomes a blank paragraph).
- `Backspace`: character delete, markdown-aware (deleting the bullet exits the list, deleting `>` exits the blockquote).
- `Cmd / Ctrl + A`: smart select. Selects the callout body if the cursor is inside a callout, the code if inside fenced code, or the content if inside inline code or inline math. Otherwise selects the whole document.
- `Cmd / Ctrl + Z` / `Cmd / Ctrl + Shift + Z`: undo / redo (Yjs-aware under collab).
- `Cmd / Ctrl + Shift + H`: open the version history panel (see [[history]]).
- `Cmd / Ctrl + Shift + P`: pin the current version (prevents retention pruning, see [[history]]).
- `Cmd / Ctrl + Shift + M`: open the PDF metadata panel (only active in the PDF viewer, see [[pdf]]).
- `Cmd / Ctrl + Shift + E`: export the open page (md as a self-contained HTML file, PDF with highlights baked in, see [[content]]).
- `Cmd / Ctrl + Shift + C`: open Content.
- `Cmd / Ctrl + Shift + B`: return to the previous page.
- `Cmd / Ctrl + Shift + F`: go forward to the next page (inverse of Shift + B).
- `Cmd / Ctrl + Shift + S`: open Setting.
- `Cmd / Ctrl + Click` a link: open in a new tab (browser) / new window (desktop app).
- `Cmd / Ctrl + C / X / V`: copy / cut / paste. When pasting an image from the clipboard, Coconote automatically saves it to the current file's `.<filename>.assets/` folder and inserts a wikilink at the cursor.
- `Cmd / Ctrl + Left/Right`: jump to line start / end.
- `Alt + Left/Right`: jump by word.
- `Cmd / Ctrl + F`: find.
- `Cmd / Ctrl + D`: next occurrence.

## Snippet

The **Snippet** panel in Setting is a JSON editor. Rules are saved to a `snippet.json` file. The lookup path for `snippet.json` is the same as `coconote.yaml` (see [[welcome]]).

```json
[
  { "trigger": "<trigger>", "replacement": "<replacement>", "options": "<flags>" }
]
```

Type the trigger and press **Tab** to expand, unless the `A` flag is set, in which case it expands the moment the trigger is finished.

**Options flags:**

- `m`: math context (`$...$` or `$$...$$`).
- `M`: display math only (`$$...$$`).
- `t`: text only (outside math).
- `A`: auto-expand, no Tab needed.
- `r`: `trigger` is treated as a regex. Capture groups are referenced in `replacement` as `[[1]]`, `[[2]]`, and so on.
- `w`: word boundary. The trigger only fires when preceded by a space, line start, or non-alphanumeric character, preventing it from firing mid-word.

**Cursor placeholders `$0`-`$9`:**

- `$1` through `$9` are **sequential tab stops**. After expansion the cursor lands at `$1`, and each Tab jumps to the next (`$2`, `$3`, and so on).
- `$0` is the **final caret**. Once all `$1`-`$9` have been visited, Tab jumps to `$0` and the snippet ends (Tab is no longer captured and returns to default behavior).
- `$0` alone also works: `replacement: "\\sum_{$0}^{}"` has only a final caret, so the cursor lands inside the first pair of braces and the next Tab ends the snippet.
- No `$0`-`$9` at all: cursor stops at the end of the replacement.
- To keep a literal `$0`-`$9`, escape as `$$0`, `$$1`, and so on, which output as `$0`, `$1`, respectively.

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

Backspace on an opening bracket: if the adjacent closing bracket was auto-inserted and the pair is empty, both are deleted together. If content exists between them, only the opening bracket is deleted.

**Filename and jump-target autocomplete**

Typing any of the following triggers pops up a live-filtering menu:

- `[[`: page list. A candidate is shown as the shortest name fragment that still uniquely identifies its page (minimum-prefix principle, see [[wikilink]]).
- `[[page#`: that page's headings.
- `[[page@`: that page's `@anchor`s.
- `[[page:`: that page's callout labels.
- `[[paper%`: that PDF's highlight anchors.

Press `Tab` or `Enter` to select a candidate. The candidate name replaces what you typed, and the cursor sits just before the closing `]]`, so you can still add a sigil or `|display` alias.

## Hover preview

Hovering over a `[[...]]` for **500 ms** pops up a preview of the linked content:

- `[[page]]`: full body of `page.md`.
- `[[page#Heading]]`: just that section.
- `[[page@anchor]]`: from the anchor marker to the end of the file.
- `[[page:label]]`: that callout's body, fence stripped.
- `[[paper%name]]`: card with anchor name + page number + highlighted text + comments.
- `[[https://...]]`: no hover.

Hide delay is 100 ms (covers cursor drift). Moving onto the popup cancels the timer.

## Collaboration

Live edits are held in a shared in-memory document and are periodically saved (checkpointed) to the markdown file on disk. The in-memory document is powered by Yjs, a CRDT library that merges concurrent edits from multiple peers automatically.

Two browser windows / tabs (same machine or different) opened on **the same page on the same server** stay in sync (Yjs CRDT, ~50 ms LAN latency). Cursors render as coloured vertical bars (random colour, deliberately showing no identity or name).

- **Offline & reconnect.** When the WS disconnects, the client does not freeze: user input continues to land in the local Yjs doc in real time, and the UI status indicator (green / yellow) reflects the current connection state. The client retries with exponential backoff (1, 2, 4, 8, 16 seconds, capped at 32 seconds), with jitter on each delay. It also listens for `visibilitychange`, `online`, and `focus` events: when the tab becomes visible again, the browser regains network, or the window regains focus, it reconnects immediately without waiting out the backoff timer. After reconnect, both sides exchange diffs in two rounds (SyncStep1 sends each side's state vector, SyncStep2 sends the missing updates), and offline-period edits are auto-merged by the Yjs CRDT.
- **Persistence.** The server checkpoints the current Yjs state to the corresponding markdown file every 5 seconds, plus an immediate write when the last peer disconnects. On startup / restart, the server loads the on-disk file as the initial Yjs doc state. When a new peer connects, both sides do a full sync that merges any unpushed local state from the client (if any) into the server doc. The merge is by CRDT, so it combines the two states rather than one side overwriting the other. **Worst-case data loss bound: 5 seconds** (when the crash happens less than 5 seconds after the last checkpoint). If a non-collab write (sync push / pull, see [[server]], or an external editor) lands on the file mid-session, the next checkpoint diffs it against the last checkpointed text and merges it into the live document like edits from another peer, so open clients keep their unflushed edits. If the file becomes unreadable (deleted or not valid UTF-8), peers are still dropped and re-seed from disk on reconnect.
- **Message size.** The single WS frame cap is **16 MB**. Typical collab updates are well under this. Exceeding it usually means the page should be split. For first-time sync of a very large doc or extra-large pastes, bypass the WS and use the `/.file` PUT endpoint instead, whose body size is limited only by HTTP config (much higher). See [[server]].
- **PDFs.** A PDF collaborates the same way through its sidecar, so highlights, anchors, comments, and metadata sync live and checkpoint to disk just like a markdown body. See [[pdf]].