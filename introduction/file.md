---
id: 0s6z4k1pkwhg6drd
coconote: true
title: file
---

# File

Coconote supports three file types: **markdown**, **PDF**, and **images**. Markdown and PDF are first-class — both render in dedicated viewers. Images are second-class — they can only appear embedded inside markdown files.

## Markdown

A markdown file is named `<filename>.md` and carries the following frontmatter:

```yaml
---
id: 1234abcd5678efgh    # auto-generated
coconote: true              # only `true` makes the file visible to Coconote
title: ...              # display name
tag: [...]              # YAML array of tags
prereq: [...]           # prerequisite files
---
```

Five fields:

- **id**: Auto-generated on creation and re-checked on save; if missing, regenerated. Used for version tracking. User-editable, but not recommended. Generation rule: 16 lowercase Crockford base32 characters (alphabet `0123456789abcdefghjkmnpqrstvwxyz`, with the easily-confused `i / l / o / u` removed); on write, regenerated if it would collide with another id in the vault.

- **coconote**: Boolean. **Only `coconote: true` (lowercase) is treated as included in Coconote**; any other value (`false`, missing, a string, …) is treated as excluded. New files get `coconote: true` written automatically. Three ways to include an existing markdown file:
    1. Edit `coconote` to `true` outside Coconote.
    2. In the Content browser, create a new file at the same filepath with the same filename — if such a file already exists, instead of creating a duplicate, that file's `coconote` flips to `true`.
    3. In the Content browser, switch to *show all supported files* mode, right-click the markdown file, and choose **Include in Coconote**.

    **Reverse:** to remove a file from Coconote, set `coconote: false` — its assets folder (see below) is preserved. Or, in the Content browser, right-click the markdown file and choose **Remove**.

- **title**: A user-friendly display name distinct from the filename, with equal standing in lookups. Initialized to the filename when the file is created.

- **tag**: File classification in YAML-array form; multiple tags allowed, `/` delimits hierarchy. Example: `tag: [research/algebra, math/calculus]`. Tags are clickable and jump to `content/tag` filtered to files sharing them. No depth limit, no reserved names.

- **prereq**: Prerequisite-file marker; clickable. See [[wikilink]] for syntax.

When a markdown file references images, an `.<name>.assets/` folder is created alongside it to hold them; with no images referenced, no folder is created. `<name>` is the basename **without** the `.md` extension — `notes/foo.md` pairs with `notes/.foo.assets/`. The folder follows the markdown file on rename, move, and delete. **A markdown file may only reference images inside its own assets folder.** Images pasted or dropped into the editor are automatically saved into that folder.

## PDF

A PDF file carries a sidecar `.<name>.json`, where `<name>` is the basename **without** the `.pdf` extension — `papers/foo.pdf` pairs with `papers/.foo.json`. The sidecar follows the PDF on rename, move, and delete. It holds the PDF's metadata and per-file operations (highlights, anchors and comments — see [[pdf]] for their structure). The sidecar is **not** created automatically. Two ways to include an existing PDF into Coconote, both of which auto-create the sidecar:

1. Create `.<name>.json` externally with `coconote: true` inside.
2. In the Content browser, switch to *show all supported files* mode, right-click the PDF, and choose **Include in Coconote**.

**Reverse:** to remove a PDF from Coconote, set `coconote: false` outside Coconote — its sidecar is preserved. Or, in the Content browser, right-click the PDF and choose **Remove**.

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

Four metadata fields:

- **id**: Same generation rule as markdown (see above).

- **coconote**: Boolean. **Only `coconote: true` (lowercase) is treated as included**; any other value is treated as excluded. When `.<name>.json` is created, `coconote: true` is auto-written.

- **title**: A user-friendly display name distinct from the filename, with equal standing in lookups. Initialized to the filename when `.<name>.json` is created. Editable from the PDF metadata panel; see [[pdf]].

- **tag**: File classification in JSON-array form; multiple tags allowed, `/` delimits hierarchy. Example: `"tag": ["research/algebra", "math/calculus"]`. No depth limit, no reserved names. Editable from the PDF metadata panel; see [[pdf]].

## Orphan files

At server startup, root folders are scanned for orphan `.<name>.json` and `.<name>.assets/` entries; orphans are auto-deleted.
