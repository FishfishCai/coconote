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

`/.content/` defaults to the path view (`/.content/path`). Clicking a file opens the matching viewer: md goes into the md editor, pdf goes into the PDF viewer.

**Filter**: one filter input, shared across all three views (the text persists when you switch view). Plain text matching, no special syntax. The match scope covers folder names, file names, tags (each segment of a hierarchical tag like `a/b`, see [[file]]), titles, and headings inside files. Matching files plus the file trees they belong to are shown.

## Path view

Path view arranges files as a folder tree, drilling down by each page's logical path (see [[welcome]]). Top-level folders are the configured roots. Local roots show their name from the roots config. Url-mounted roots show as `root<url>` so they stand out from local ones.

### Display mode toggle

The Content header shows a toggle while Path view is active: "**Included**" / "**All**".

- **Included** (default): only files marked `coconote: true` are shown (in a md frontmatter, or in a pdf's sidecar, see [[file]]).
- **All**: additionally lists every supported file not in Coconote, local roots only (url-mounted roots expose no excluded-file data). Non-included files appear greyed out: clicking does not open them, and their only right-click menu item is **Include**.

### Right-click menu

Every row is either not in Coconote (single item: **Include**) or in Coconote (the grouped menu below, groups divided by separator lines). A failed action reports "<action> failed: <reason>" in a modal instead of failing silently.

**Folder:** a creation group, then the file actions broadcast over the included pages under the folder.

- **New Markdown**: prompts for a name and creates `<name>.md` in that folder. If a same-named file already exists but is excluded (`coconote: false`, see [[file]]), it is included instead of overwritten and a notice says so.
- **New Folder**: creates a new folder under the folder.
- **Include (N)**: shown only when N > 0 supported files under the folder are not yet included (local roots only). Includes all N after confirmation. A folder whose subtree holds no included pages (possible only in All view) offers only this item.
- **Rename / Remove / Delete**: apply the file actions to every included page under the folder at once. Rename keeps the folder inside its root (the leading root name is fixed) and warns when excluded files will stay in the old folder. Delete's confirmation states how many Coconote pages it deletes and that files not in Coconote stay on disk. These appear only on sub-folders, not on a configured root folder (a root is renamed or dropped only via Setting, see [[setting]]).

**`.md` and `.pdf`:**
- **Rename**: prompts for a new path and filename. Any `[[wikilink]]` pointing at the old name is rewritten to point at the new one.
- **Remove**: file stays on disk, but its `coconote` flips to `false` (in the md frontmatter, or the pdf sidecar) and it disappears from the index.
- **Export PDF**: downloads a PDF of the page to the local machine, never written into the vault. Works for url-mounted files too. A pdf's export bakes its highlights into the pages (see [[pdf]]).
- **Export HTML** (md only): downloads a single self-contained `.html` (styles, fonts, images, and math all inlined) that works fully offline.
- **Delete**: permanently deletes the file and its assets folder after confirmation. Delete always sits alone in the menu's last group.

### push / pull

In addition to the file-management menu above:

- local files / folders get an extra **Push** item.
- url-mounted remote files / folders get a **Pull** item instead. Remote rows are otherwise read-only: a remote file offers only Pull plus the exports, a remote folder only Pull.

Details in [[history]].

## Tag view

The same set of pages, grouped into a file tree by the `tag:` declarations in their frontmatter. A single file can appear under multiple tags. Pages with no `tag:` land in `(untagged)`. No right-click menu.

Clicking a tag in a file's frontmatter from the editor jumps to tag view and auto-fills that tag into the filter.

## Graph view

Graph view is a directed force graph. An edge is drawn whenever A depends on B, from two sources treated identically: A's body references B via a wikilink, or A's `prereq:` lists B. Either way the edge is `A -> B`, read as "B is a prerequisite of A". (So in this view, any wikilink counts as a prerequisite relationship.) No right-click menu. Nodes are coloured by the file's first tag in frontmatter declaration order (same tag means same colour). The filter dims non-matching nodes.

The graph supports the following interactions:

- **Drag a node**: reposition that node.
- **Drag empty space**: pan the canvas.
- **Scroll**: zoom centred on the cursor.
- **Hover**: highlight the node's 1-hop neighbourhood.
- **Click**: open that page.

A panel on the left lets you tune: attraction strength, repulsion strength, tag colouring level (at level 1, `a/1` and `a/2` share one colour since they are both under `a`, while at level 2 they each get their own colour), whether isolated nodes are included, and whether to include markdown files only (hiding PDFs). Both filters rebuild the graph, so an excluded node leaves the layout entirely rather than staying in the simulation while hidden.
