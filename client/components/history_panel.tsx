// Floating right-side timeline for one page id. History is id-keyed so
// renames don't break the chain. Restore writes back to the current
// on-disk path.

import { useEffect, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import { Modal } from "./modal.tsx";
import { authedFetch } from "../lib/authed_fetch.ts";
import { fileUrl } from "../spaces/constants.ts";
import { lineDiff } from "../lib/line_diff.ts";

type SaveType = "create" | "edit" | "push" | "pull" | "pin";

type Version = {
  ts: number;
  save_type: SaveType;
};

type Props = {
  client: Client;
  /** Frontmatter `id:` - history's join key. */
  id: string;
  /** Current on-disk path: restore writes back here, and the diff is
   *  taken against this file's live content. */
  targetPath: string;
  onClose: () => void;
  onRestored: () => void;
  /** When set, Restore hands the snapshot text to this callback instead
   *  of the server restore endpoint. The PDF viewer uses it so a restore
   *  flows through the live collab session rather than a disk write
   *  that would conflict with the open room. */
  applyRestore?: (snapshotText: string) => void;
};

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

// One monochrome typographic glyph per save type - pin uses a star, not
// the pin emoji, so all five share the same flat single-color style.
const TYPE_GLYPH: Record<SaveType, string> = {
  create: "✱",
  edit: "•",
  push: "↑",
  pull: "↓",
  pin: "★",
};

export function HistoryPanel(
  { client, id, targetPath, onClose, onRestored, applyRestore }: Props,
) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const hasSelection = selectedTs !== null;

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setError(null);
    authedFetch(`/.history/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data: Version[]) => {
        if (!cancelled) setVersions(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!hasSelection) {
      setPreview("");
      setCurrent("");
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    // Diff against the current on-disk content (history.md Diff).
    // Refetch per-selection so a save mid-session shows up.
    Promise.all([
      authedFetch(`/.history/${encodeURIComponent(id)}?ts=${selectedTs}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText))),
      authedFetch(fileUrl(targetPath))
        .then((r) => (r.ok ? r.text() : "")),
    ])
      .then(([snap, disk]) => {
        if (cancelled) return;
        setPreview(snap);
        setCurrent(disk);
        setPreviewLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPreview("(failed to load)");
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTs, id, hasSelection, targetPath]);

  const restore = async () => {
    if (!hasSelection) return;
    setRestoring(true);
    try {
      if (applyRestore) {
        // Hand the snapshot to the caller (PDF collab session) instead
        // of a server-side disk write. Re-fetch so we restore the exact
        // bytes even if the preview is still loading.
        const r = await authedFetch(
          `/.history/${encodeURIComponent(id)}?ts=${selectedTs}`,
        );
        if (!r.ok) throw new Error(await r.text());
        applyRestore(await r.text());
        onRestored();
        onClose();
        return;
      }
      const r = await authedFetch(
        `/.history/${encodeURIComponent(id)}/restore?ts=${selectedTs}&path=${
          encodeURIComponent(targetPath)
        }`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(await r.text());
      onRestored();
      onClose();
    } catch (e) {
      setError(`Restore failed: ${e}`);
    } finally {
      setRestoring(false);
    }
  };

  const remove = async () => {
    if (!hasSelection) return;
    // Same modal path the context menus use, not the bare
    // window.confirm (which Electron no-ops by default).
    const ok = await client.ui.confirm(
      "Delete this version row from the history database? This cannot be undone.",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await authedFetch(
        `/.history/${encodeURIComponent(id)}?ts=${selectedTs}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(await r.text());
      const ls = await authedFetch(`/.history/${encodeURIComponent(id)}`);
      if (ls.ok) setVersions(await ls.json());
      setSelectedTs(null);
    } catch (e) {
      setError(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  };

  // Preview-centric orientation (history.md Version history panel):
  // GREEN (add) marks lines the selected version would bring back on
  // Restore, RED (del) marks lines only in the current on-disk text
  // that would be replaced.
  const diff = hasSelection ? lineDiff(current, preview) : [];

  return (
    <Modal
      title={`Version history — ${targetPath}`}
      size="large"
      onClose={onClose}
      loading={versions === null && !error}
    >
      <div class="coconote-history-body">
          <div class="coconote-history-list">
            {error && <div class="coconote-history-error">{error}</div>}
            {versions?.length === 0 && <div>No versions recorded yet.</div>}
            {versions?.map((v) => (
              <button
                key={v.ts}
                type="button"
                class={"coconote-history-row " +
                  (selectedTs === v.ts ? "selected" : "") +
                  ` kind-${v.save_type}`}
                onClick={() => setSelectedTs(v.ts)}
              >
                <span class="coconote-history-chip" title={v.save_type}>
                  {TYPE_GLYPH[v.save_type]} {v.save_type}
                </span>
                <span class="coconote-history-time">{fmtTs(v.ts)}</span>
              </button>
            ))}
          </div>
          <div class="coconote-history-preview">
            {!hasSelection
              ? <em>Click a snapshot to preview it.</em>
              : previewLoading
              ? <em>Loading…</em>
              : (
                <>
                  <pre class="coconote-history-diff">
                    {diff.map((d, i) => (
                      <span
                        key={i}
                        class={"coconote-history-diff-line coconote-history-diff-" + d.kind}
                      >
                        {d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  "}
                        {d.text}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                  <div class="coconote-history-actions">
                    <button
                      type="button"
                      class="coconote-history-restore"
                      disabled={restoring || deleting}
                      onClick={restore}
                    >
                      {restoring ? "Restoring…" : "Restore this version"}
                    </button>
                    <button
                      type="button"
                      class="coconote-history-delete"
                      disabled={restoring || deleting}
                      onClick={remove}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </>
              )}
          </div>
      </div>
    </Modal>
  );
}
