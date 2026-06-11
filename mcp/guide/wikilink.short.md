# Wikilink contract

- `[[name]]` links to a page: `name` matches the filename (md extension stripped, pdf kept)
  or the frontmatter title. Filename matches beat title matches (not a collision).
- Minimum-prefix principle: write the shortest form that is unique. On collision prepend a
  disambiguating prefix, `[[path/name]]` (path segments) or `[[tag/name]]` (a tag prefix).
- A link that resolves to zero or several pages renders red and unclickable. Never leave one:
  re-check with list_pages/search_pages and add a prefix.
- Position markers, appended after `name`:
    - `#heading` jumps to a heading (H1-H4 text).
    - `@anchor` jumps to an `@anchor` written in the target body.
    - `:label` jumps to the callout opened with `::: kind:label` (`:3` = 3rd numbered callout).
    - `%name` jumps to a named PDF highlight, only on `.pdf` links: `[[paper.pdf%name]]`.
- Anchor names: letters, digits, `_`, `-`, `:`, `/`, first char a letter or `_`, no spaces.
- Marker only (`[[#heading]]`, `[[@anchor]]`) targets the current file.
- `[[anything|display]]` overrides the display text. The `|alias` goes last, after any marker.
- `[[https://...]]` is an external URL link, not a vault lookup.
