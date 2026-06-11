# File

Coconote handles three file types: **markdown**, **PDF**, and **images**.
Markdown and PDF each open in their own viewer. Images are second-class: they
appear only embedded inside markdown files.

## Common fields

Markdown files and PDFs share the same four fields. In a markdown file they
live in the frontmatter. In a PDF they live in the `.<name>.json` sidecar
(see below).

- **id**: auto-generated, and used for version tracking. It is 16 lowercase
  Crockford base32 characters (alphabet `0123456789abcdefghjkmnpqrstvwxyz`,
  which already omits the look-alike `i l o u`). On write it is regenerated
  if it is missing or collides with another id in the vault. Editable, but
  not recommended (the MCP tools refuse to change it).
- **coconote**: a boolean gate. Only `coconote: true` (lowercase) counts as
  included in Coconote. Any other value (`false`, missing, a string) is
  excluded. See "Including and removing" below.
- **title**: a display name shown instead of the filename, and treated like
  the filename when searching or resolving links. Starts equal to the
  filename.
- **tag**: a list of tags that classify the file. Multiple are allowed, and
  `/` marks hierarchy, for example `research/algebra`. No depth limit and no
  reserved names.

## Markdown

A markdown file is named `<filename>.md` and carries the common fields plus
`prereq` in its frontmatter:

```yaml
---
id: 1234abcd5678efgh    # auto-generated
coconote: true          # only `true` makes the file visible to Coconote
title: ...              # display name
tag: [...]              # tags
prereq: [...]           # prerequisite files
---
```

- **prereq**: a list of prerequisite files, clickable like a link. See the
  wikilink guide for the syntax.

If a markdown file references images, an `.<name>.assets/` folder is created
beside it to hold them (none is created if it references no images). `<name>`
is the basename without the `.md`, so `notes/foo.md` pairs with
`notes/.foo.assets/`. The folder follows the file on rename, move, and
delete. A markdown file may reference images only inside its own assets
folder.

## PDF

A PDF carries a sidecar `.<name>.json`, where `<name>` is the basename
without the `.pdf`, so `papers/foo.pdf` pairs with `papers/.foo.json`. The
sidecar holds the common fields plus the PDF's highlights, anchors, and
comments (see the pdf guide for those), and it follows the PDF on rename,
move, and delete.

```json
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

Two differences from markdown: the fields sit in the sidecar's `metadata`
object as JSON (so `tag` is a JSON array), and `title` and `tag` are editable
from the PDF metadata panel in the app.

## Including and removing

A new markdown file is included automatically (`coconote: true` is written
for you). A PDF starts with no sidecar, so it must be included explicitly,
which creates the sidecar. Ways to include an existing file:

- Set `coconote: true` yourself: edit a markdown file's frontmatter, or
  create a PDF's `.<name>.json` with `coconote: true` in its `metadata`
  (the set_included tool does both).
- Markdown only: create a file at an existing markdown file's path. Coconote
  does not duplicate it, it flips that file's `coconote` to `true`.

To remove a file, set `coconote: false` (set_included with included false).
Its companion (assets folder or sidecar) is kept.

## Orphan files

A companion left without its file (a `.<name>.json` or `.<name>.assets/`
whose `.pdf` or `.md` is gone) is an orphan. The server deletes orphans when
it scans the root folders at startup.
