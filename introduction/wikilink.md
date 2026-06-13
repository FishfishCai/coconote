---
id: xn2yhq5p56jhw0jz
coconote: true
title: wikilink
---

# Wikilink

`[[...]]` links to another page (md or pdf) in the vault, or to a specific position inside a page.

## Resolving the page

`[[path/name]]` resolves to a page:

- `name` matches the page's **filename** (with the `.md` extension stripped) or the frontmatter `title`.
- `path` is an optional disambiguation prefix. It can be a file-path segment (e.g. `path/to/`) or a tag prefix (e.g. `tag/`).
- **Minimum-prefix principle**: if `name` is unique, write `[[name]]` directly. On collision, add a prefix until it is unique. A filename match outranks a title match (not treated as a collision). Autocomplete suggests candidates by this principle.
- If the link matches more than one page, or none, it shows in **red** and is not clickable.

## Jumping to a position

Append a position marker after `name`. Four markers:

- `#heading`: jumps to a markdown heading. Levels 1 through 4 (`#` to `####`) are targetable.
- `@anchor`: jumps to a named anchor placed in the body. Create an anchor by writing `@name` in the body. The name uses letters, digits, underscore, hyphen, colon, and slash, the first character must be a letter or underscore, and it contains no spaces.
- `:label`: jumps to a callout block opened with `::: keyword:label` (see [[markdown]]). Only the label is matched, whatever the keyword. The numeric form `:3` jumps to the 3rd numbered callout on the page.
- `%name`: jumps to a PDF highlight named `name`. Only valid for `.pdf` links (naming rules in [[pdf]]).

Omit `name` and write only the position marker (e.g. `[[#heading]]`, `[[@anchor]]`) to target the **current file**. If the marker doesn't match anything, the link lands at the top of the file.

## External URL

`[[https://example.com]]` doesn't query the vault. It opens the external link in a new tab.

## Display

`[[name|display]]` overrides the link's display text with `display`. This works on every link form above: page resolution, position markers, and external URLs.
