import { isLocalURL } from "coconote/lib/resolve";
import { renderToText, traverseTree } from "coconote/lib/tree";
import { parseTransclusion } from "./transclusion.ts";
import { parseMarkdown } from "./parser/parser.ts";

// The set of LOCAL asset filenames a markdown body implies through its
// `![[...]]` image embeds (history.md: a file's set = md body + the images
// it references). Image embeds are flat filenames inside the owning file's
// `.<name>.assets/` dir; external http(s) urls are dropped. Used by the
// sync flows to mirror a file's images to a remote instance.
export function bodyImpliedAssets(mdText: string): string[] {
  const tree = parseMarkdown(mdText);
  const out = new Set<string>();
  traverseTree(tree, (n) => {
    if (n.type !== "Image") return false;
    const text = renderToText(n);
    if (!text.startsWith("![[")) return true;
    const t = parseTransclusion(text);
    if (!t) return true;
    // Only local image embeds travel; external http(s) embeds stay remote.
    if (t.url && isLocalURL(t.url) && isMediaTransclusion(t.url)) {
      out.add(t.url);
    }
    return true;
  });
  return [...out];
}

// markdown.md makes `![[...]]` an *image* syntax. Restrict the embed
// renderer to image MIME types - PDFs / audio / video aren't part of
// the markdown spec.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
// Explicit non-image binary extensions that must NOT embed. A markdown
// `![[...]]` only renders images (markdown.md), so a video / audio / pdf
// target falls back to plain text instead of a blank media element.
const NON_IMAGE_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|m4a|flac|aac|pdf)$/i;

export function isMediaTransclusion(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  // External http(s) inside `![[url]]` embeds as an image (extension-less
  // image services like placehold.co are in the spec example), unless it
  // carries an explicit non-image extension, in which case it is not media.
  if (/^https?:\/\//i.test(url)) return !NON_IMAGE_EXT_RE.test(url);
  return false;
}
