// Shared `refs` gate. A `[[title]]` link is jumpable ONLY when its
// resolved target id is listed in the current file's frontmatter `refs`.
// Both the render layer (codemirror wiki_link) and the navigation layer
// route every jump decision through here so they can never disagree.
//
// Reachability contract (pinned cross-end): this gate is ONE HOP - a link
// is jumpable iff the target id is directly in THIS file's `refs`. The
// server's access-control boundary (boundary.rs `id_closure`) is the
// TRANSITIVE closure of `refs` from the entry set (recent U pin). The two
// are deliberately different scopes: the client gates a single authored
// link, the server decides which ids a remote session may touch. They
// share the same per-file `refs` id edges, so neither can resolve an edge
// the other wouldn't. If the spec ever moves jumpability to multi-hop,
// this gate and refs_gate.test.ts must change together with the server.

/** True when `targetId` is directly listed in this file's `refs` (an id
 *  list). refs/backrefs are ids now, so this is a plain membership test. */
export function isInRefs(
  targetId: string | undefined,
  refs: readonly string[] | undefined,
): boolean {
  if (!targetId || !refs || refs.length === 0) return false;
  return refs.includes(targetId);
}
