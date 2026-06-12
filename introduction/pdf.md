---
id: 7hwb4fzberx3xhjq
coconote: true
title: pdf
---

# PDF

The PDF reader supports the following:

- Continuous scrolling (mouse wheel / trackpad).
- Zoom (`Cmd / Ctrl + +/-`), using the host window's zoom.
- Select text, then click a colour to save it as a highlight.
- Clicking a highlight opens a menu:
    - **anchor / rename anchor**: names the highlight (or renames it). A named highlight becomes a jump target written `[[paper.pdf%<name>]]` (see [[wikilink]]).
    - **add / edit comment**: adds or edits a comment, shown on hover.
    - **change colour**: changes the highlight colour (yellow, green, blue, pink, or orange).
    - **remove**: deletes the highlight along with its anchor and comment.

**Export PDF** (see [[content]]) downloads a copy with the highlights drawn into the pages. The vault file is untouched.

All of a PDF's data lives in one sidecar **`.<name>.json`** beside it (so `paper.pdf` pairs with `.paper.json`): the four common fields (see [[file]]) plus highlights, anchors, and comments. Its shape:

```jsonc
{
  "metadata": {
    "id": "...",
    "coconote": true,
    "title": "...",
    "tag": [...]
  },
  "highlights": [...],
  "anchors": [...],
  "comments": [...]
}
```

The sidecar follows the PDF on rename / move / delete (see [[file]]).

### highlights

Shape of each highlight:

```jsonc
{
  "id": "...",            // highlight uuid
  "color": "yellow",      // yellow | green | blue | pink | orange
  "page": 3,              // page number (1-based)
  "rects": [...],         // rectangles as page fractions (0 to 1, from the top-left)
  "text": "..."           // text snapshot at selection time
}
```

### anchors

Naming a highlight writes an anchor entry that maps a readable name to the highlight id:

```json
{ "name": "fig3", "highlightId": "..." }
```

### comments

A comment attached to a highlight:

```json
{ "highlightId": "...", "body": "...", "ts": 1717000000000 }
```

## Metadata panel

While the PDF reader is open, **`Cmd / Ctrl + Shift + M`** opens a floating panel for editing the four common fields (`id`, `coconote`, `title`, `tag`, see [[file]]). **Save** writes them back to the sidecar. **Cancel** closes the panel without writing.

## Collaboration and history

The sidecar collaborates and is versioned exactly like a markdown body, because both ride the same per-file channel. Highlights, anchors, comments, and metadata sync live across open clients (see [[editor]]), and every save records a sidecar snapshot you can restore (see [[history]]).
