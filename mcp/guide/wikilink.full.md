# Wikilink

`[[...]]` links to another page (md or pdf) in the vault, or to a specific
position inside a page.

## Resolving the page

`[[path/name]]` resolves to a page:

- `name` matches the page's **filename** (with the `.md` extension stripped)
  or the frontmatter `title`.
- `path` is an optional disambiguation prefix. It can be a file-path segment
  (e.g. `path/to/`) or a tag prefix (e.g. `tag/`).
- **Minimum-prefix principle**: if `name` is unique, write `[[name]]`
  directly. If it collides, add a prefix until it is unique. When both a
  filename match and a title match exist, the filename match wins (this is
  not treated as a collision).
- If the link matches more than one page, or none, it shows in **red** and is
  not clickable.

## Jumping to a position

Append a position marker after `name`. Four markers:

- `#heading`: jumps to a markdown heading. Levels 1 through 4 (`#` to `####`)
  are targetable.
- `@anchor`: jumps to a named anchor placed in the body. Create an anchor by
  writing `@name` in the body. The name uses letters, digits, underscore,
  hyphen, colon, and slash, the first character must be a letter or
  underscore, and it contains no spaces. So `[[note@anchor]]` targets the
  `@anchor` written in `note`.
- `:label`: jumps to a callout block opened with `::: keyword:label` (where
  `keyword` is the callout type, see the markdown guide). Only the label is
  matched, so `[[note:intro]]` targets the callout labeled `intro` in `note`,
  whatever its keyword. A numeric form `:3` jumps to the 3rd numbered callout
  on the page (numbering is defined in the markdown guide).
- `%name`: jumps to a PDF highlight named `name`. Only valid for `.pdf`
  links. For example `[[paper.pdf%name]]` (highlight naming rules in the pdf
  guide).

Omit `name` and write only the position marker (e.g. `[[#heading]]`,
`[[@anchor]]`) to target the **current file**. If the marker doesn't match
anything, the link lands at the top of the file.

## External URL

`[[https://example.com]]` doesn't query the vault. It opens the external link
in a new tab.

## Display

`[[name|display]]` overrides the link's display text with `display`. This
works on every link form above: page resolution, position markers, and
external URLs.
