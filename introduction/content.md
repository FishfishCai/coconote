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

`/.content/` defaults to `/.content/path`. Clicking a file opens the matching viewer: md goes into the md editor, pdf goes into the PDF viewer.

**Filter**: one input shared across all three views, its text persisting across switches. Plain text matching, no special syntax. The match scope covers folder names, file names, tags (every segment, see [[file]]), titles, and headings inside files. Matching files plus the file trees they belong to are shown.

## Export

The **Export** header button downloads `coconote-site.zip`: the whole vault, every included page as a read-only static website with the same Path / Tag / Graph views. md pages become HTML with relative links, pdfs carry their highlights baked in (see [[pdf]]). The site omits Setting, the Included/All toggle, context menus, and all editing. Unzip onto any static host or open `index.html` from disk. Pages whose bytes cannot be fetched are skipped and reported in a notice.

## Path view

Path view arranges files as a folder tree, drilling down by each page's logical path. Top-level folders are the configured roots: local roots show their name, url-mounted roots show as `root<url>` to stand out.

### Display mode toggle

Path view shows a toggle: "**Included**" / "**All**".

- **Included** (default): only files marked `coconote: true` are shown (see [[file]]).
- **All**: additionally lists every supported file not in Coconote, local roots only. Non-included files appear greyed out: clicking does not open them, and their only right-click menu item is **Include**.

### Right-click menu

A non-included row has a single item, **Include**. An included row shows the grouped menu below, divided by separator lines, with Delete alone in the last group. A failed action reports "<action> failed: <reason>" in a modal.

**Folder:**

- **New Markdown**: prompts for a name and creates `<name>.md` in that folder. If a same-named file is excluded (`coconote: false`), it is included instead of overwritten and a notice says so.
- **New Folder**: creates a new folder under the folder.
- **Rename / Remove**: apply the file actions to every included page under the folder at once. Rename keeps the folder inside its root and warns when excluded files will stay in the old folder.
- **Include**: between Rename and Remove on a sub-folder, its own group after New Folder on a root. Shown when some supported file under the folder is not yet included (local only). Includes every such file after confirmation.
- **Push**: pushes every included page under the folder (see [[history]]).
- **Download**: saves a raw copy of the folder's included files, each md page's image assets and each pdf's sidecar, zipped to a location you pick.
- **Export**: builds the folder subtree as a static site, scoped, with internal wikilinks kept relative and outward links turned to plain spans.
- **Delete**: deletes every included page under the folder. The confirmation states the count and that files not in Coconote stay on disk.

Rename, Remove, and Delete appear only on sub-folders holding at least one included page, never on a configured root (renamed or dropped via Setting, see [[setting]]). A folder with no included pages offers only Include.

**`.md` and `.pdf`:**

- **Rename**: prompts for a new path and filename inside the same root. Any `[[wikilink]]` pointing at the old name is rewritten to the new one.
- **Remove**: the file stays on disk, but its `coconote` flips to `false` and it disappears from the index.
- **Push**: pushes the file to a remote (see [[history]]).
- **Download**: saves the raw file as-is: md source for an md row, the original pdf (no baked highlights) for a pdf row.
- **Export**: downloads to the local machine, never into the vault. md downloads a single self-contained `.html` that works offline. pdf downloads a copy with highlights baked in (see [[pdf]]).
- **Delete**: permanently deletes the file and its assets folder after confirmation.

Every Download and Export saves via the OS save dialog when the browser has one, otherwise as a plain download. Cancelling saves nothing.

Url-mounted remote rows are read-only and get **Pull** in place of Push (see [[history]]): a remote file offers Pull, Download, and Export, a remote folder only Pull.

## Tag view

The same set of pages, grouped into a file tree by the `tag:` declarations in their frontmatter. A single file can appear under multiple tags. Pages with no `tag:` land in `(untagged)`. No right-click menu.

Clicking a tag in a file's frontmatter from the editor jumps to tag view and auto-fills that tag into the filter.

## Graph view

Graph view is a directed force graph driven by both the `prereq:` field in frontmatter and wikilinks. The edge `A -> B` reads "B is a prerequisite of A": A's body references B via a wikilink, or A's `prereq:` lists B. No right-click menu. Nodes are coloured by the file's first tag (same tag means same colour). The filter dims non-matching nodes.

The graph supports the following interactions:

- **Drag a node**: reposition that node.
- **Drag empty space**: pan the canvas.
- **Scroll**: zoom centred on the cursor.
- **Hover**: highlight the node's 1-hop neighbourhood.
- **Click**: open that page.

A panel on the left lets you tune: attraction strength, repulsion strength, tag colouring level (at level 1, `a/1` and `a/2` share one colour since they are both under `a`, while at level 2 they each get their own colour), whether isolated nodes are included, and whether to include markdown files only. Both filters rebuild the graph, dropping excluded nodes from the layout entirely.
