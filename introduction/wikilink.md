---
id: xn2yhq5p56jhw0jz
coconote: true
title: wikilink
---

# Wikilink

`[[…]]` jumps within the vault — it can point to a md / pdf page, or to a specific position inside a page.

## Resolving the page

`[[path/name]]` resolves to a page:

- `name` matches the page's **filename** (with the `.md` extension stripped) or the frontmatter `title`.
- `path` is an optional disambiguation prefix; it can be a file-path segment (e.g. `notes/`) or a tag prefix (e.g. `research/`).
- **Minimum-prefix principle**: when the candidate is unique, write `[[name]]` directly; on collision, add a prefix until uniqueness is reached. Filename matches outrank title matches. Autocomplete suggests candidates by this principle.
- Still ambiguous (more than one candidate) or nothing matched at all: the link is rendered in **red** and not clickable.

## Jumping to a position

Append a position marker after `name` to jump to somewhere inside the page. Four markers:

- `#heading`: jumps to a markdown heading; `#`–`####` all work.
- `@anchor`: jumps to a manually-placed named anchor in the body. Write `@name` in the body to create an anchor — the name is composed of letters / digits / underscore / hyphen / colon / slash, the first character must be a letter or underscore, and no spaces.
- `:label`: jumps to a callout block opened with `::: keyword:label`; `:3` jumps to the 3rd numbered callout on the page (see [[markdown]]).
- `%name`: jumps to a PDF highlight named `name`; only valid for `.pdf` links (naming rules in [[pdf]]).

Omit `name` and write only the position marker (e.g. `[[#editing]]`, `[[@figure1]]`): the target defaults to the **current file**. When the file exists but the position marker doesn't match, the link still lands at the top of that file.

## External URL

`[[https://example.com]]` doesn't query the vault; it opens the external link in a new tab.

## Display

`[[name|display]]` overrides the link's display text with `display`; this works on all three forms — page resolution, position markers, and external URLs.
