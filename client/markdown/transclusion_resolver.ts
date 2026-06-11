import { isLocalURL } from "coconote/lib/resolve";
import {
  joinAnchorRange,
  parseAnchorRange,
  type Transclusion,
} from "coconote/lib/transclusion";
import type { PageMeta } from "coconote/type/page";
import { resolveWikiLink } from "../lib/wikilink.ts";
import { resolveWikiLinkPath } from "./wiki_link_resolver.ts";

// Input is never mutated — the widget callback may fire repeatedly across re-renders.
export function resolveTransclusion(
  transclusion: Transclusion,
  _currentName: string,
  currentPath: string,
  allKnownFiles: ReadonlySet<string>,
  allPages: readonly PageMeta[],
): Transclusion {
  const range = parseAnchorRange(transclusion.url);
  let bare = range.path;

  if (isLocalURL(bare)) {
    // Decide treat-as-binary from the basename only — a dot inside a
    // directory segment like `notes/section.draft/page` must not
    // flip the classification. Lowercase comparison so `MY.MD` ≡ `my.md`.
    const lastSlash = bare.lastIndexOf("/");
    const base = (lastSlash === -1 ? bare : bare.slice(lastSlash + 1)).toLowerCase();
    const isBinary = base.includes(".") && !base.endsWith(".md");
    if (!isBinary) {
      const r = resolveWikiLink(bare, allPages);
      if (r.kind === "ok") {
        bare = r.page.name;
      }
    } else {
      const resolved = resolveWikiLinkPath(bare, currentPath, allKnownFiles);
      if (resolved !== bare) {
        bare = resolved;
      } else if (currentPath) {
        // Binary assets aren't in the page-only allKnownFiles index.
        // Per file.md: a markdown file's images live in
        // `.<basename>.assets/` beside it, so rewrite under that dir
        // unless `bare` is already there (round-trip stability) or
        // starts with a known root prefix.
        const slash = currentPath.lastIndexOf("/");
        const dir = slash >= 0 ? currentPath.slice(0, slash + 1) : "";
        const file = slash >= 0 ? currentPath.slice(slash + 1) : currentPath;
        const stem = file.toLowerCase().endsWith(".md")
          ? file.slice(0, -3)
          : file;
        const assetsPrefix = `${dir}.${stem}.assets/`;
        if (!bare.startsWith(assetsPrefix)) {
          bare = `${assetsPrefix}${bare}`;
        }
      }
    }
  }
  return {
    ...transclusion,
    url: joinAnchorRange(bare, range.start, range.end),
  };
}

// markdown.md makes `![[…]]` an *image* syntax. Restrict the
// embed renderer to image MIME types; PDFs / audio / video aren't part
// of the markdown spec.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

export function isMediaTransclusion(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  // External http(s) inside `![[url]]` is always treated as an image
  // (extension-less image services like placehold.co are listed by the
  // spec example).
  if (/^https?:\/\//i.test(url)) return true;
  return false;
}
