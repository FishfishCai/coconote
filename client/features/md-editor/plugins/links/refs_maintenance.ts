// In-buffer refs / backrefs maintenance (design.md frontmatter: "refs and
// backrefs are kept in place. When you insert a link to B in A's body, the
// editor writes B's id into A's refs and A's id into B's backrefs"). Entries
// are NOT auto-removed when a link disappears; they are pruned only when the
// target id is no longer in `recent`. Done entirely client-side.
//
// One update listener reconciles the whole picture: the set of resolved
// wikilink target IDS in the buffer is the source of truth for which refs
// must be present. On each doc change it:
//   - resolves every [[title]] in the buffer to a target id,
//   - adds any new target id to this file's `refs` (in place),
//   - prunes refs/backrefs entries whose id is neither currently linked nor
//     in `recent`,
//   - for each newly added target, adds THIS file's id to its `backrefs`.

import { EditorView } from "@codemirror/view";
import { externalUpdate } from "../../editor_state.ts";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
import {
  addToFrontmatterList,
  extractFrontmatter,
  removeFromFrontmatterList,
  setFrontmatterList,
  stripFrontmatter,
} from "../../../../core/file";
import { parseToRef } from "../../../../capabilities/links/index.ts";
import { wikiLinkRegex } from "../../../../capabilities/markdown/index.ts";
import { resolveTitle } from "../../../../capabilities/links/index.ts";
import { getConfig } from "../../../../core/config/index.ts";
import type { PageMeta } from "coconote/type/page";

type Client = EditorCtx & SpaceCtx & UICtx;

/** Every resolved wikilink target id in the buffer (the desired `refs`
 *  set). External URLs and in-page (`[[#heading]]`) links are excluded;
 *  ambiguous / missing titles resolve to nothing and are skipped. */
function bufferLinkTargetIds(text: string, pages: readonly PageMeta[]): string[] {
  const out = new Set<string>();
  wikiLinkRegex.lastIndex = 0;
  for (let m = wikiLinkRegex.exec(text); m; m = wikiLinkRegex.exec(text)) {
    const stringRef = m.groups?.stringRef ?? "";
    if (!stringRef || /^https?:\/\//i.test(stringRef)) continue;
    const ref = parseToRef(stringRef);
    if (!ref || ref.title === "") continue;
    const resolved = resolveTitle(ref.title, pages);
    if (resolved.state === "hit") out.add(resolved.id);
  }
  return [...out];
}

/** Add or remove THIS file's id in the target file's `backrefs`, writing
 *  the target back (addressed by id). Best effort: a missing or read-only
 *  target is skipped, not surfaced. */
async function updateBackref(
  client: Client,
  targetId: string,
  selfId: string,
  add: boolean,
): Promise<void> {
  if (!targetId || targetId === selfId) return;
  try {
    const { text, meta } = await client.space.readPage(targetId);
    if (meta.kind !== "md") return; // pdf backrefs live in the sidecar
    const next = add
      ? addToFrontmatterList(text, "backrefs", selfId)
      : removeFromFrontmatterList(text, "backrefs", selfId);
    if (next === text) return;
    await client.space.writePage(
      targetId,
      next,
      Date.parse(meta.lastModified) || undefined,
    );
  } catch {
    // Target absent / read-only / stale - leave its backrefs alone.
  }
}

/** The refs/backrefs maintenance extension. Reconciles on every doc
 *  change. The buffer edit it makes converges, so it cannot loop. */
export function refsMaintenancePlugin(client: Client) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || update.view.composing) return;
    // Only the LOCAL user's edits maintain refs (under collab the
    // frontmatter is remote-read-only). Skip remote collab replays /
    // programmatic edits.
    const localEdit = update.transactions.some((t) =>
      !t.annotation(externalUpdate) &&
      (t.isUserEvent("input") || t.isUserEvent("delete") ||
        t.isUserEvent("move"))
    );
    if (!localEdit) return;
    if (client.isReadOnlyMode()) return;
    const selfId = client.currentId();
    if (!selfId || client.currentPageMeta()?.kind !== "md") return;

    const pages = client.ui.viewState.allPages;
    const text = update.state.sliceDoc();
    const want = bufferLinkTargetIds(text, pages);
    const have = extractFrontmatter(text).refs ?? [];
    const added = want.filter((id) => !have.includes(id));
    if (added.length === 0) return;

    // Reconcile the buffer's `refs` (and prune) against the LIVE doc, then
    // maintain the backref on each newly added target. The buffer rewrite
    // touches only the frontmatter region (body + cursor untouched). The
    // convergent edit carries no user event, so it cannot re-trigger this.
    void (async () => {
      let recentIds: Set<string>;
      try {
        const cfg = await getConfig();
        recentIds = new Set(
          [...(cfg.recent ?? []), ...(cfg.pin ?? [])].map((e) => e.id),
        );
      } catch {
        recentIds = new Set();
      }
      const view = update.view;
      if (view.composing) return;
      const live = view.state.sliceDoc();
      const liveWant = bufferLinkTargetIds(live, pages);
      // Keep an id when it is currently linked OR still in recent; drop
      // the stale, unlinked, non-recent ones (spec prune rule).
      const haveNow = extractFrontmatter(live).refs ?? [];
      const merged = [...new Set([...haveNow, ...liveWant])];
      const nextRefs = merged.filter((id) =>
        liveWant.includes(id) || recentIds.has(id)
      );
      const next = sameSet(haveNow, nextRefs)
        ? live
        : setFrontmatterList(live, "refs", nextRefs);
      if (next !== live) {
        const oldHead = stripFrontmatter(live).offset;
        const newHead = stripFrontmatter(next).offset;
        view.dispatch({
          changes: { from: 0, to: oldHead, insert: next.slice(0, newHead) },
          annotations: [externalUpdate.of(true)],
        });
      }
      // Maintain the other side: this file's id in each added target's
      // backrefs (only for targets that survived the prune).
      for (const id of added) {
        if (!nextRefs.includes(id)) continue;
        await updateBackref(client, id, selfId, true);
      }
      // The page list's refs/backrefs changed - rebuild the index.
      void client.updatePageListCache();
    })();
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}
