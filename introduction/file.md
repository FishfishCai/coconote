---
id: 0s6z4k1pkwhg6drd
coconote: true
title: file
---

# File

Coconote handles three file types: **markdown**, **PDF**, and **images**. Markdown and PDF each open in their own viewer. Images are second-class: they appear only embedded inside markdown files.

## Common fields

Markdown files and PDFs share the same four fields. In a markdown file they live in the frontmatter. In a PDF they live in the `.<name>.json` sidecar (see below).

- **id**: auto-generated, and used for version tracking. It is 16 lowercase Crockford base32 characters (alphabet `0123456789abcdefghjkmnpqrstvwxyz`, which already omits the look-alike `i l o u`). On write it is regenerated if it is missing or collides with another id in the vault. Editable, but not recommended.
- **coconote**: a boolean gate. Only `coconote: true` (lowercase) counts as included in Coconote. Any other value (`false`, missing, a string) is excluded. See "Including and removing" below.
- **title**: a display name shown instead of the filename, and treated like the filename when searching or resolving links. Starts as the filename without its extension.
- **tag**: a list of tags that classify the file. Multiple are allowed, and `/` marks hierarchy, for example `research/algebra`. No depth limit and no reserved names. Clicking a tag opens the Tag view filtered to files that carry it (see [[content]]).

## Markdown

A markdown file is named `<filename>.md` and carries the common fields plus `prereq` in its frontmatter:

```yaml
---
id: 1234abcd5678efgh    # auto-generated
coconote: true          # only `true` makes the file visible to Coconote
title: ...              # display name
tag: [...]              # tags
prereq: [...]           # prerequisite files
---
```

- **prereq**: a list of prerequisite files, clickable like a link. See [[wikilink]] for the syntax.

If a markdown file references images, an `.<name>.assets/` folder is created beside it to hold them (none is created if it references no images). `<name>` is the basename without the `.md`, so `notes/foo.md` pairs with `notes/.foo.assets/`. The folder follows the file on rename, move, and delete. A markdown file may reference images only inside its own assets folder, and images pasted or dropped into the editor are saved there automatically.

## PDF

A PDF carries a sidecar `.<name>.json`, where `<name>` is the basename without the `.pdf`, so `papers/foo.pdf` pairs with `papers/.foo.json`. The sidecar holds the common fields plus the PDF's highlights, anchors, and comments (see [[pdf]] for those), and it follows the PDF on rename, move, and delete.

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

Two differences from markdown: the fields sit in the sidecar's `metadata` object as JSON (so `tag` is a JSON array), and `title` and `tag` are editable from the PDF metadata panel (see [[pdf]]).

## Including and removing

A new markdown file is included automatically (`coconote: true` is written for you). A PDF starts with no sidecar, so it must be included explicitly. You can edit the flag where it lives, or use the Content browser's Include and Remove actions (see [[content]] for the menus). Either way the effect on disk is the same:

- **Include, markdown**: `coconote` flips to `true` in the frontmatter. A missing key is added, and a file with no frontmatter gets a fresh block.
- **Include, PDF**: an existing sidecar gets its `coconote` flipped to `true` in place, keeping its id, title, and tags. With no sidecar, one is created with fresh metadata.
- **Remove, either kind**: `coconote` flips to `false`. The file stays on disk and keeps the flag line, and its companion (assets folder or sidecar) is kept, so re-including restores everything.

## Orphan files

A companion left without its file (a `.<name>.json` or `.<name>.assets/` whose `.pdf` or `.md` is gone) is an orphan. The server sweeps each root folder and deletes its orphans, at startup for every configured root and again for any root added while running.
