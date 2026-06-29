import { getPathExtension } from "../../../core/util";
import { isLocalURL } from "coconote/lib/resolve";
import mime from "mime";
import { assetUrl } from "../../../core/transport";
import type { Transclusion } from "../transclusion.ts";

function getMimeTypeFromUrl(
  url: string,
  allowExternal: boolean,
): string | null {
  if (!isLocalURL(url) && allowExternal) {
    // new URL is universal; the static URL.parse it replaced is only in very
    // recent engines and threw "URL.parse is not a function" elsewhere.
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch { /* malformed URL - no extension hint */ }
    const lastDot = pathname.lastIndexOf(".");
    if (lastDot >= 0) {
      const extension = pathname.slice(lastDot + 1);
      const guess = mime.getType(extension);
      if (guess) return guess;
    }
    // Extension-less hint: some image services end the URL with the
    // format name (e.g. placehold.co/300x100/png).
    const tail = pathname.split("/").pop()?.toLowerCase() ?? "";
    if (/^(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(tail)) {
      return `image/${tail === "jpg" ? "jpeg" : tail}`;
    }
    // Last resort: default to image/* so `<img>` attempts the load -
    // onerror swaps in a text link.
    return "image/*";
  }
  // Local embed: the url is a flat filename inside the owner's assets dir.
  // A bare page name (no extension) yields null, so the caller renders it
  // as a text link rather than embedding it.
  return mime.getType(getPathExtension(url));
}

/** Local images load via `/.file?id=<owner>&asset=<filename>`; external
 *  http(s) urls load directly. Without an owner id a local image cannot be
 *  addressed, so it stays as its literal (unloadable) name. */
function sanitizeTransclusionUrl(url: string, ownerId?: string): string {
  if (!isLocalURL(url)) return url;
  return ownerId ? assetUrl(ownerId, url) : url;
}

// External image URLs land in an `<img>` `src`, so a
// `javascript:` / `data:` / `vbscript:` scheme would execute. Mirror
// safeHref in markdown_render.ts: strip the control chars browsers
// ignore when parsing a scheme, then allow only http(s). Internal
// vault paths never hit this check.
function isSafeExternalMediaUrl(url: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  const cleaned = url.replace(/[\u0000-\u0020]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  return scheme !== null && /^https?$/i.test(scheme[1]);
}

// Returns null for markdown content or unsupported MIME types. `ownerId`
// is the id of the file embedding the image (local images load from its
// `.<name>.assets/` via `/.file?id=<ownerId>&asset=<filename>`).
export function createMediaElement(
  transclusion: Transclusion,
  ownerId?: string,
): HTMLElement | null {
  // `![[javascript://...]]` etc. must never reach src/data below.
  if (
    !isLocalURL(transclusion.url) &&
    !isSafeExternalMediaUrl(transclusion.url)
  ) {
    return null;
  }
  const mimeType = getMimeTypeFromUrl(transclusion.url, /*allowExternal*/ true);
  if (!mimeType) return null;

  // `display: block` required for `margin: 0 auto` to center inline <img>.
  const alignCss = transclusion.align === "center"
    ? "display: block; margin-left: auto; margin-right: auto;"
    : transclusion.align === "right"
    ? "display: block; margin-left: auto; margin-right: 0;"
    : transclusion.align === "left"
    ? "display: block; margin-left: 0; margin-right: auto;"
    : "";
  const style = `max-width: 100%;` +
    (transclusion.dimension?.width ? `width: ${transclusion.dimension.width}px;` : "") +
    (transclusion.dimension?.height ? `height: ${transclusion.dimension.height}px;` : "") +
    alignCss;
  const src = sanitizeTransclusionUrl(transclusion.url, ownerId);

  if (mimeType.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = transclusion.alias;
    img.style = style;
    // On load failure (CORS / 404 / mixed-content), fall back to text link
    // so the user sees what was requested instead of a broken-image icon.
    img.onerror = () => {
      const a = document.createElement("a");
      a.href = src;
      a.textContent = `[${transclusion.alias || src}]`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "coconote-image-fallback";
      img.replaceWith(a);
    };
    return img;
  }
  // markdown.md documents `![[...]]` as image-only. Non-image targets are
  // not embedded - the caller falls back to the raw text link.
  return null;
}
