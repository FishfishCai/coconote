import type { Path } from "coconote/lib/ref";

export function isLocalURL(url: string): boolean {
  return (
    !url.includes("://") &&
    !url.startsWith("mailto:") &&
    !url.startsWith("tel:")
  );
}

const builtinPrefixes = ["tag:", "search:"];

export function isBuiltinPath(path: Path): boolean {
  return builtinPrefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * Won't resolve above the base of the absolute path; excess `..` is
 * dropped. Only leading `..` is processed.
 */
export function resolveMarkdownLink(
  absolute: string,
  relative: string,
): string {
  // Commonmark spec: urls with spaces are wrapped in `<...>`.
  if (relative.startsWith("<") && relative.endsWith(">")) {
    relative = relative.slice(1, -1);
  }

  if (relative.startsWith("/")) {
    return relative.slice(1);
  } else {
    const splitAbsolute = absolute.split("/").slice(0, -1);
    const splitRelative = relative.split("/");

    while (splitRelative && splitRelative[0] === "..") {
      splitAbsolute.pop();
      splitRelative.shift();
    }

    return [...splitAbsolute, ...splitRelative].join("/") as Path;
  }
}

