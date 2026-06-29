// Floating right-side timeline for one file. History lives in-place at the
// file's `.<name>.assets/.history/` and is addressed by id, so renames
// (moving the assets folder alongside) don't break the chain. Restore /
// delete / keep all address by id.

import { useEffect, useState } from "preact/hooks";
import type { UICtx as Client } from "../../core/ctx/ui.ts";
import { Modal } from "../../core/ui";
import { authedFetch, fileUrl, historyUrl } from "../../core/transport";
import { lineDiff } from "./line_diff.ts";

type SaveType = "create" | "edit" | "push" | "pull" | "keep";

type Version = {
  ts: number;
  save_type: SaveType;
};

type Props = {
  client: Client;
  /** File id: the history join key (`?id=`), the restore target, and the
   *  file the diff is taken against. */
  targetId: string;
  onClose: () => void;
  onRestored: () => void;
  /** When set, Restore hands the snapshot text to this callback instead of
   *  the server restore endpoint. The PDF viewer uses it so a restore flows
   *  through the live sidecar session rather than a raw disk write. */
  applyRestore?: (snapshotText: string) => void;
  /** When set, supplies the "current" text the diff is taken against instead
   *  of fetching `/.file?id=` (which for a pdf returns the binary, not the
   *  sidecar json). The PDF viewer passes its live serialized sidecar. */
  currentText?: () => string | Promise<string>;
};

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

// One ASCII glyph per save type (all flat single-color). `keep` is the
// renamed `pin`.
const TYPE_GLYPH: Record<SaveType, string> = {
  create: "+",
  edit: "~",
  push: "^",
  pull: "v",
  keep: "*",
};

export function HistoryPanel(
  { client, targetId, onClose, onRestored, applyRestore, currentText }: Props,
) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [keeping, setKeeping] = useState(false);

  const hasSelection = selectedTs !== null;

  const reloadVersions = async () => {
    const ls = await authedFetch(historyUrl(targetId));
    if (ls.ok) setVersions(await ls.json());
  };

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setError(null);
    authedFetch(historyUrl(targetId))
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
  }, [targetId]);

  useEffect(() => {
    if (!hasSelection) {
      setPreview("");
      setCurrent("");
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    // Diff against the current content (design.md Diff). Refetch
    // per-selection so a save mid-session shows up. `currentText` overrides
    // the on-disk fetch (a pdf's /.file is the binary, not the sidecar json).
    Promise.all([
      authedFetch(historyUrl(targetId, `&ts=${selectedTs}`))
        .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText))),
      currentText
        ? Promise.resolve(currentText())
        : authedFetch(fileUrl(targetId))
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
  }, [selectedTs, hasSelection, targetId]);

  const restore = async () => {
    if (!hasSelection) return;
    setRestoring(true);
    try {
      if (applyRestore) {
        const r = await authedFetch(historyUrl(targetId, `&ts=${selectedTs}`));
        if (!r.ok) throw new Error(await r.text());
        applyRestore(await r.text());
        onRestored();
        onClose();
        return;
      }
      const r = await authedFetch(
        `/.history/restore?id=${encodeURIComponent(targetId)}&ts=${selectedTs}`,
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
    const ok = await client.ui.confirm(
      "Delete this version row from the history database? This cannot be undone.",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await authedFetch(
        historyUrl(targetId, `&ts=${selectedTs}`),
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(await r.text());
      await reloadVersions();
      setSelectedTs(null);
    } catch (e) {
      setError(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  };

  // design.md keep: clone the latest content as a `keep` row, never pruned.
  const keep = async () => {
    setKeeping(true);
    try {
      const r = await authedFetch(
        `/.history/keep?id=${encodeURIComponent(targetId)}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(await r.text());
      await reloadVersions();
    } catch (e) {
      setError(`Keep failed: ${e}`);
    } finally {
      setKeeping(false);
    }
  };

  // Preview-centric orientation (design.md Version history panel): GREEN
  // (add) marks lines the selected version would bring back on Restore, RED
  // (del) marks lines only in the current on-disk text it would replace.
  const diff = hasSelection ? lineDiff(current, preview) : [];

  return (
    <Modal
      title="Version history"
      size="large"
      onClose={onClose}
      loading={versions === null && !error}
    >
      <div class="coconote-history-body">
          <div class="coconote-history-list">
            {error && <div class="coconote-history-error">{error}</div>}
            <div class="coconote-history-toolbar">
              <button
                type="button"
                class="coconote-history-keep"
                disabled={keeping}
                onClick={keep}
                title="Keep this version (never pruned)"
              >
                {keeping ? "Keeping..." : "Keep this version"}
              </button>
            </div>
            {versions?.length === 0 && (
              <div class="coconote-history-empty">No versions recorded yet.</div>
            )}
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
              ? (
                <div class="coconote-history-preview-empty">
                  Click a snapshot to preview it.
                </div>
              )
              : previewLoading
              ? <div class="coconote-history-preview-empty">Loading...</div>
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
                      {restoring ? "Restoring..." : "Restore this version"}
                    </button>
                    <button
                      type="button"
                      class="coconote-history-delete"
                      disabled={restoring || deleting}
                      onClick={remove}
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </>
              )}
          </div>
      </div>
    </Modal>
  );
}
