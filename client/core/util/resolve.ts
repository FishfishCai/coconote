// Classifies an image embed url as a local asset (a flat filename inside
// the owner's `.<name>.assets/`) vs an external http(s) / mailto / tel
// URL. Used by the image render path (inline.ts, transclusion_resolver.ts).
export function isLocalURL(url: string): boolean {
  return (
    !url.includes("://") &&
    !url.startsWith("mailto:") &&
    !url.startsWith("tel:")
  );
}

