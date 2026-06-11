import { getPathExtension, parseToRef } from "coconote/lib/ref";
import { isLocalURL } from "coconote/lib/resolve";
import mime from "mime";
import { fsEndpoint } from "../../spaces/constants.ts";
import type { Transclusion } from "coconote/lib/transclusion";

// Bare page names default to text/markdown so wiki transclusions work.
function getMimeTypeFromUrl(
  url: string,
  allowExternal: boolean,
): string | null {
  if (!isLocalURL(url) && allowExternal) {
    const pathname = URL.parse(url)?.pathname ?? "";
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
  const ref = parseToRef(url);
  if (!ref) throw Error(`Failed to parse url: ${url}`);
  return mime.getType(getPathExtension(ref.path)) ?? "text/markdown";
}

function sanitizeTransclusionUrl(url: string): string {
  return isLocalURL(url)
    ? `${fsEndpoint.slice(1)}/${url.replace(":", "%3A")}`
    : url;
}

// External media URLs land in `src` / `<object data>`, so a
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

// Returns null for markdown content or unsupported MIME types.
export function createMediaElement(
  transclusion: Transclusion,
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
  const src = sanitizeTransclusionUrl(transclusion.url);

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
  if (mimeType.startsWith("video/")) {
    const v = document.createElement("video");
    v.src = src;
    v.title = transclusion.alias;
    v.controls = true;
    v.style = style;
    return v;
  }
  if (mimeType.startsWith("audio/")) {
    const a = document.createElement("audio");
    a.src = src;
    a.title = transclusion.alias;
    a.controls = true;
    a.style = style;
    return a;
  }
  if (mimeType === "application/pdf") {
    const o = document.createElement("object");
    o.type = mimeType;
    o.data = src;
    o.style.width = "100%";
    o.style.height = "20em";
    return o;
  }
  return null;
}
