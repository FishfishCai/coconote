// Order of attempts:
//   1. Exact match in known files.
//   2. Prepend the current page's root and re-check.
//   3. Basename match across known files (1 hit = resolved; ≥2 = ambiguous;
//      0 = missing).
//
// Keep free of Client/DOM imports so it stays trivially testable.
export type WikiLinkResolveResult =
  | { kind: "resolved"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "ambiguous"; path: string; candidates: string[] };

export function resolveWikiLinkPathDetailed(
  targetPath: string,
  currentPath: string | undefined,
  allKnownFiles: ReadonlySet<string>,
): WikiLinkResolveResult {
  if (!targetPath) return { kind: "resolved", path: targetPath };
  if (allKnownFiles.has(targetPath)) {
    return { kind: "resolved", path: targetPath };
  }
  if (currentPath) {
    const slash = currentPath.indexOf("/");
    if (slash > 0) {
      const candidate = currentPath.slice(0, slash) + "/" + targetPath;
      if (allKnownFiles.has(candidate)) {
        return { kind: "resolved", path: candidate };
      }
    }
  }
  const slashIdx = targetPath.lastIndexOf("/");
  const basename = slashIdx >= 0 ? targetPath.slice(slashIdx + 1) : targetPath;
  const hits: string[] = [];
  for (const f of allKnownFiles) {
    const fSlash = f.lastIndexOf("/");
    if (fSlash < 0) continue;
    if (f.slice(fSlash + 1) === basename) hits.push(f);
  }
  if (hits.length === 1) return { kind: "resolved", path: hits[0] };
  if (hits.length > 1) {
    return { kind: "ambiguous", path: targetPath, candidates: hits };
  }
  return { kind: "missing", path: targetPath };
}

// Returns the resolved path, or the input unchanged.
export function resolveWikiLinkPath(
  targetPath: string,
  currentPath: string | undefined,
  allKnownFiles: ReadonlySet<string>,
): string {
  const r = resolveWikiLinkPathDetailed(
    targetPath,
    currentPath,
    allKnownFiles,
  );
  return r.kind === "resolved" ? r.path : targetPath;
}

/**
 * Resolve a PDF wiki-link path. `allKnownFiles` only carries `.md`
 * entries, so a user-typed `test1.pdf` falls through to the `allPages`
 * basename scan. Returns the input unchanged when nothing matches.
 */
export function resolvePdfWikiLinkPath(
  pdfPath: string,
  currentPath: string | undefined,
  allKnownFiles: ReadonlySet<string>,
  allPages: ReadonlyArray<{ name: string }>,
): string {
  let resolved = resolveWikiLinkPath(pdfPath, currentPath, allKnownFiles);
  if (resolved === pdfPath && pdfPath.toLowerCase().endsWith(".pdf")) {
    const hit = allPages.find((p) =>
      p.name === pdfPath || p.name.endsWith("/" + pdfPath)
    );
    if (hit) resolved = hit.name;
  }
  return resolved;
}
