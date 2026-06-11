// Shared by NamedAnchor (parser.ts), refRegex anchor group (ref.ts), and
// runtime $name lookup (lib/transclusion.ts). Keep in sync.
export const ANCHOR_NAME_RE = /[A-Za-z_][A-Za-z0-9_/:-]*/;

export const wikiLinkRegex =
  /(?<leadingTrivia>!?\[\[)(?<stringRef>.*?)(?:\|(?<alias>.*?))?(?<trailingTrivia>\]\])/g;
export const nakedUrlRegex =
  /(^https?:\/\/([-a-zA-Z0-9@:%_+~#=]|(?:[.](?!(\s|$)))){1,256})(([-a-zA-Z0-9(@:%_+~#?&=/]|(?:[.,:;)](?!(\s|$))))*)/;
export const pWikiLinkRegex = new RegExp(`^${wikiLinkRegex.source}`);
