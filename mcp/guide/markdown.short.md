# Coconote markdown contract (write rules)

- Headings: H1-H4 only (`#` to `####`). H5+ does not exist, do not write it.
- No HTML tags, no footnotes. They are not part of the dialect.
- Lists: `-` unordered, `1.` ordered. Sub-items are indented by exactly 4 spaces.
  An ordered item keeps the typed number, restyled to its level's marker.
- Tables: GFM pipe syntax, a header row, a dash delimiter row, then body rows.
  Delimiter colons set alignment: `:---` left, `:---:` center, `---:` right.
- Inline marks: `**bold**` (or `__bold__`), `*italic*` (or `_italic_`), `~~strike~~`, `==highlight==`.
  Bold/italic/strike nest in any order. `==highlight==` cannot combine with the other three.
- Escaping: backslash a marker to render it literally, e.g. `\*not italic\*`.
- Quote: only the first `>` on a line is the marker, further `>` render as plain text
  (no nesting). Horizontal rule: `---`, `***`, or `___` on its own line.
- Code: inline in backticks, blocks in triple-backtick fences with an optional language tag.
  Use more backticks for the fence when the code itself contains backticks.
- Math: inline `$...$`, block `$$ ... $$` (LaTeX).
- Callout: `::: kind` (optional label: `::: kind:label`), body lines, closed by a line
  of 3 or more colons.
  The 12 kinds: definition, theorem, proposition, lemma, corollary, example, proof,
  remark, note, warning, tip, info. The first six share one running counter.
- Image embed: `![[name|alt|WxH|align]]` (alt/size/align optional, align is left|center|right).
  A local image must live in the page's own `.<stem>.assets/` folder, where `<stem>` is the
  md filename without `.md` (`notes/foo.md` -> `notes/.foo.assets/`). Use the add_image tool
  to place it there, then embed by bare name: `![[pic.png]]`. `![[https://...]]` embeds a URL.
