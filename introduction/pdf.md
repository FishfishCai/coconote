---
id: 7hwb4fzberx3xhjq
coconote: true
title: pdf
---

## PDF reader

The PDF reader supports the following:

- Continuous scrolling (mouse wheel / trackpad).
- Browser-level zoom (`Cmd / Ctrl + +/-`).
- Selecting text pops up a colour picker; clicking a colour saves the selection as a highlight.
- Right-clicking a highlight pops up a menu:
    - **anchor / rename anchor**: gives the highlight a name (or renames it if already named). Once named, the highlight becomes a jumpable target via wikilinks of the form `[[paper.pdf%<name>]]`; see [[wikilink]].
    - **add / edit comment**: attaches a comment to this highlight (or edits the existing one); shown on hover.
    - **change colour**: switches the highlight colour; choose from 5 (yellow / green / blue / pink / orange).
    - **remove**: deletes the highlight, along with its anchor and comment.

All PDF metadata and annotations (metadata, highlights, anchors, comments) live in one sidecar file **`.<name>.json`** (basename without the `.pdf` extension; see [[file]]), structured as:

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
  "rects": [...],         // array of rectangular regions (in-page normalized coords)
  "text": "..."           // text snapshot at selection time
}
```

### anchors

Naming a highlight via the right-click menu writes one anchor row, mapping a readable name to the highlight id; named highlights serve as jumpable targets, see [[wikilink]].

```json
{ "name": "fig3", "highlightId": "..." }
```

### comments

A comment attached to a highlight:

```json
{ "highlightId": "...", "body": "...", "ts": 1717000000000 }
```

## Metadata panel

While the PDF viewer is open, **`Cmd / Ctrl + Shift + M`** opens a floating panel that exposes the sidecar's four metadata fields — **id**, **coconote**, **title**, **tag** — for direct editing. Changes are written back to `.<name>.json` on **Save**; **Cancel** closes the panel without writing.
