# PDF sidecar contract

- All of a PDF's data lives in its sidecar `.<stem>.json` next to it
  (`paper.pdf` -> `.paper.json`). The PDF binary itself is frozen after import.
- Sidecar shape:
  `{"metadata": {"id", "coconote", "title", "tag"}, "highlights": [], "anchors": [], "comments": []}`
  `metadata` carries the common fields (see the file guide). Never touch `metadata.id`.
- Each highlight: `{"id": "<uuid>", "color": "...", "page": N, "rects": [...], "text": "..."}`
    - `color`: exactly one of yellow | green | blue | pink | orange.
    - `page`: 1-based page number.
    - `rects`: `[{"x", "y", "w", "h"}]`, page fractions 0..1 measured from the TOP-LEFT corner.
    - `text`: snapshot of the highlighted text.
- Each anchor maps a readable name to a highlight: `{"name": "fig3", "highlightId": "<uuid>"}`.
  A named highlight is a wikilink jump target: `[[paper.pdf%fig3]]`.
  Names: letters, digits, `_`, `-`, `:`, `/`, first char a letter or `_`, no spaces.
- Each comment: `{"highlightId": "<uuid>", "body": "...", "ts": <ms epoch>}`.
- Prefer add_pdf_highlight (it computes rects from a text quote). For other sidecar changes,
  read the JSON, mutate, then write_page the full JSON.
