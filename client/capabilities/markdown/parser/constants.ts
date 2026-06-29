// Valid name shape for a PDF named highlight (`[[paper%name]]`). Consumed
// by the pdf feature to validate a highlight name before saving it.
export const ANCHOR_NAME_RE = /[A-Za-z_][A-Za-z0-9_/:-]*/;

// Matches a `[[target|alias]]` (or `![[..]]` image) wiki link. The `g`
// copy scans a whole document; `pWikiLinkRegex` is the anchored copy the
// inline parser runs at a candidate position.
export const wikiLinkRegex =
  /(?<leadingTrivia>!?\[\[)(?<stringRef>.*?)(?:\|(?<alias>.*?))?(?<trailingTrivia>\]\])/g;
export const pWikiLinkRegex = new RegExp(`^${wikiLinkRegex.source}`);
