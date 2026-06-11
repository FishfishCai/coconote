---
id: 96z4dhfc331nsgas
coconote: true
title: content
---

# Content

The file index has three views, each occupying its own URL:

- `/.content/path`: Path view
- `/.content/tag`: Tag view
- `/.content/graph`: Graph view

The default URL is `/.content/path`; visiting `/.content/` is equivalent to `/.content/path`. Clicking a file opens the matching viewer — md goes into the md editor, pdf goes into the PDF viewer.

**Filter**: plain text matching, no special syntax. The match scope covers folder names, file names, tags (at every level), titles, and headings inside files. Matching files plus the file trees they belong to are all shown.

## Path view

Path view arranges files as a folder tree, drilling down by each page's logical path. Top-level folders are the configured roots — local roots show their yaml name; url-mounted roots display in `root<url>` format (root name followed by the URL string), to visually distinguish them from local roots.

### Display mode toggle

The top of Path view has a toggle: "**Coconote files only**" / "**All supported files**".

- **Coconote files only** (default): only files whose frontmatter / sidecar carries `coconote: true` are shown.
- **All supported files**: every md and pdf inside the root is listed; files not included in Coconote appear greyed out — clicking does not open them, and the only right-click menu item is **Include in Coconote**.

### Right-click menu

The menu below applies only to files **already included in Coconote** (right-click behaviour for non-included files was covered above). Right-clicking a row brings up a file-manager-style action menu whose contents depend on the file type:

**Folder:**
- **New Markdown**: prompts for a name and creates `<name>.md` in that folder. If a file with the same name already exists with `coconote: false`, its `coconote` is flipped to `true` instead of overwriting.
- **New Folder**: creates a new folder under the folder.

**`.md` and `.pdf`:**
- **Rename**: prompts for a new path and filename. Any `[[wikilink]]` pointing at the old name is rewritten to point at the new one.
- **Remove**: file stays on disk, but its frontmatter `coconote` flips to `false` and it disappears from the index.
- **Delete**: physically deletes the file and its assets folder; gone for good after confirmation.

Rename, New Markdown, and New Folder all provide UI for entering the new path/name.

### push / pull

In addition to the file-management menu above:

- local files / folders get an extra **push** item;
- url-mounted remote files / folders get an extra **pull** item.

Details in [[history]].

## Tag view

The same set of pages, grouped into a file tree by the `tag:` declarations in their frontmatter. A single file can appear under multiple tags; pages with no `tag:` land in `(untagged)`. No right-click menu.

Clicking a tag in a file's frontmatter from the editor jumps to tag view and auto-fills that tag into the filter.

## Graph view

Graph view is a directed force graph driven by both the `prereq:` field in frontmatter and wikilinks. The arrow `A -> B` reads "B is a prerequisite of A" (A's body references B via wikilink, or A's `prereq:` lists B). No right-click menu. Nodes are coloured by the first tag of their file (same tag → same colour); filter input dims non-matching nodes.

The graph supports the following interactions:

- **Drag**: reposition a node.
- **Scroll**: zoom centred on the cursor.
- **Drag empty space**: pan the canvas.
- **Hover**: highlight the node's 1-hop neighbourhood.
- **Click**: open that page.

A panel on the left lets you tune: attraction strength, repulsion strength, tag colouring level (at level 1, `a/1` and `a/2` share one colour since they're both under `a`; at level 2 they each get their own colour), and whether isolated nodes are shown.
