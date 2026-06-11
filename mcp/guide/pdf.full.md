# PDF

The PDF reader renders the binary and stores every annotation in the sidecar.
A highlight is saved from a text selection plus a colour. Right-clicking a
highlight in the app can:

- **anchor / rename anchor**: names the highlight (or renames it). A named
  highlight becomes a jump target written `[[paper.pdf%<name>]]`, where `%`
  separates the file from the anchor name (see the wikilink guide).
- **add / edit comment**: adds or edits a comment, shown on hover.
- **change colour**: changes the highlight colour (yellow, green, blue, pink,
  or orange).
- **remove**: deletes the highlight along with its anchor and comment.

All of a PDF's data lives in one sidecar **`.<name>.json`** beside it (so
`paper.pdf` pairs with `.paper.json`): the four common fields (see the file
guide) plus highlights, anchors, and comments. Its shape:

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

The sidecar follows the PDF on rename / move / delete (see the file guide).

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

Each rect is `{"x": ..., "y": ..., "w": ..., "h": ...}` in page fractions.

### anchors

Naming a highlight writes an anchor entry that maps a readable name to the
highlight id:

```json
{ "name": "fig3", "highlightId": "..." }
```

### comments

A comment attached to a highlight:

```json
{ "highlightId": "...", "body": "...", "ts": 1717000000000 }
```

## Collaboration and history

The sidecar collaborates and is versioned exactly like a markdown body,
because both ride the same per-file channel. Highlights, anchors, comments,
and metadata sync live across open clients, and every save records a sidecar
snapshot that can be restored.
