// Floating right-side timeline for one page id. History is id-keyed,
// so renames don't break the chain; Restore writes back to the current
// on-disk path.

import { useEffect, useState } from "preact/hooks";
import { authedFetch } from "../lib/authed_fetch.ts";
import { encodePathSegments } from "../lib/path_url.ts";
import { lineDiff } from "../lib/line_diff.ts";

type SaveType = "create" | "edit" | "push" | "pull" | "pin";

type Version = {
  ts: number;
  save_type: SaveType;
};

type Props = {
  /** Frontmatter `id:` — history's join key. */
  id: string;
  /** Current on-disk path; restore writes back here. */
  targetPath: string;
  onClose: () => void;
  onRestored: () => void;
};

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

// One monochrome typographic glyph per save type — pin uses a star rather
// than the 📌 emoji so all five share the same flat, single-color style.
const TYPE_GLYPH: Record<SaveType, string> = {
  create: "✱",
  edit: "•",
  push: "↑",
  pull: "↓",
  pin: "★",
};

export function HistoryPanel({ id, targetPath, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
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
      return;
    }
    let cancelled = false;
    // Diff against the current on-disk content (history.md §Diff).
    // Refetch per-selection so a save mid-session shows up.
    Promise.all([
      authedFetch(`/.history/${encodeURIComponent(id)}?ts=${selectedTs}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText))),
      authedFetch(`/.file/${encodePathSegments(targetPath)}`)
        .then((r) => (r.ok ? r.text() : "")),
    ])
      .then(([snap, disk]) => {
        if (cancelled) return;
        setPreview(snap);
        setCurrent(disk);
      })
      .catch(() => {
        if (!cancelled) setPreview("(failed to load)");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTs, id, hasSelection, targetPath]);

  const restore = async () => {
    if (!hasSelection) return;
    setRestoring(true);
    try {
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
    // Same modal path the context menus use (client.ui.confirm) instead
    // of the bare window.confirm. The panel receives no `client` prop —
    // its call site predates one — so reach through the boot-time
    // global (core/client.ts `declare global`).
    const ok = await globalThis.client.ui.confirm(
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
      // Re-fetch the list so the deleted row drops out + selection clears.
      const ls = await authedFetch(`/.history/${encodeURIComponent(id)}`);
      if (ls.ok) setVersions(await ls.json());
      setSelectedTs(null);
    } catch (e) {
      setError(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  };

  // Preview-centric orientation (history.md §Version history panel):
  // GREEN (add) marks lines the selected version would bring back on
  // Restore; RED (del) marks lines that exist only in the current
  // on-disk text and would be replaced.
  const diff = hasSelection ? lineDiff(current, preview) : [];

  return (
    <div class="coconote-history-overlay" onClick={onClose}>
      <div class="coconote-history-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <span>Version history — {targetPath}</span>
          <button
            type="button"
            class="coconote-history-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div class="coconote-history-body">
          <div class="coconote-history-list">
            {error && <div class="coconote-history-error">{error}</div>}
            {versions === null && !error && <div>Loading…</div>}
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
      </div>
    </div>
  );
}
