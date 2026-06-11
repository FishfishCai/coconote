// Three-way merge UI. Renders the merged stream from diff3, with each
// conflict chunk shown as (local | base | remote) plus per-chunk
// resolution buttons. The merged buffer is editable so the user can
// tweak the auto-merged segments before committing. Pure UI: the sync
// flow that opened the merge supplies `commitMerged`, which writes the
// result to both sides with the right save_type (history.md §MergeView).

import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { errMessage } from "../lib/constants.ts";
import { merge3 } from "../lib/diff3.ts";
import type { Chunk } from "../lib/diff3.ts";
import { ModalActions } from "./modal_actions.tsx";
import { Modal } from "./modal.tsx";

export type MergeViewProps = {
  /** Page label shown in the header (the local path being merged). */
  localPath: string;
  baseText: string;
  localText: string;
  remoteText: string;
  baseHash: string;        // for the header — last common ancestor hash
  /** Which flow opened the merge; drives button copy. The writes
   *  themselves live in `commitMerged`. */
  direction?: "push" | "pull";
  /** Writes the merged result to the trigger side, then the other side,
   *  each tagged with the flow's save_type (history.md §MergeView). */
  commitMerged(merged: Uint8Array): Promise<void>;
  onClose(): void;
};

type ChunkChoice = "auto" | "local" | "remote" | "base";


export function MergeView(
  {
    localPath,
    baseText,
    localText,
    remoteText,
    baseHash,
    direction = "push",
    commitMerged,
    onClose,
  }: MergeViewProps,
) {
  const chunks = useMemo(
    () => merge3(baseText, localText, remoteText),
    [baseText, localText, remoteText],
  );
  const [choices, setChoices] = useState<ChunkChoice[]>(() =>
    chunks.map(() => "auto")
  );
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  // True once the user hand-edits the buffer; from then on `edited` is
  // authoritative regardless of the <details> open/close state, so
  // collapsing the panel no longer discards their edits.
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const auto = useMemo(() => assemble(chunks, choices), [chunks, choices]);

  // Reseed the textarea from the auto-merge until the user hand-edits it
  // (history.md §MergeView: the hand-edited buffer wins).
  useEffect(() => {
    if (!dirty) setEdited(auto);
  }, [auto, dirty]);

  const merged = dirty ? edited : auto;
  const conflictCount = chunks.filter((c) => c.kind === "conflict").length;
  // Block commit while the effective buffer still carries conflict
  // markers: per-chunk resolution clears them from `auto`, hand-editing
  // clears them from `edited`. Gating on this (not the panel-open flag)
  // stops merely opening the editor from bypassing unresolved conflicts.
  const hasConflictMarkers = merged.includes("<<<<<<< local\n");

  const setChoice = (i: number, c: ChunkChoice) => {
    setChoices((prev) => prev.map((x, k) => (k === i ? c : x)));
  };

  const commit = async () => {
    setBusy(direction === "pull" ? "writing local…" : "pushing to remote…");
    setErr(null);
    try {
      await commitMerged(new TextEncoder().encode(merged));
      onClose();
    } catch (e: unknown) {
      setErr(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={`Merge — ${localPath}`}
      size="wide"
      className="coconote-merge-modal"
      onClose={onClose}
    >
      <div className="coconote-merge-body">
        <header className="coconote-merge-head">
          <p>
            {baseHash && (
              <>Base: <code>{baseHash.slice(0, 12)}…</code> · </>
            )}
            {conflictCount} conflict{conflictCount === 1 ? "" : "s"}
            {" "}({choices.filter(
              (c, i) => chunks[i].kind === "conflict" && c !== "auto",
            ).length}{" "}
            resolved)
          </p>
        </header>

        <div className="coconote-merge-chunks">
          {chunks.map((c, i) => {
            if (c.kind === "ok") {
              return <pre key={i} className="coconote-merge-ok">{c.text}</pre>;
            }
            const cur = choices[i];
            return (
              <div key={i} className="coconote-merge-conflict">
                <div className="coconote-merge-cols">
                  <div
                    className={"coconote-merge-col" +
                      (cur === "local" ? " picked" : "")}
                  >
                    <div className="coconote-merge-col-head">local</div>
                    <pre>{c.local || "<empty>"}</pre>
                  </div>
                  {/* history.md §MergeView: fixed local | base | remote
                      columns — an empty base still gets its column. */}
                  <div className="coconote-merge-col">
                    <div className="coconote-merge-col-head">base</div>
                    <pre>{c.base || "<empty>"}</pre>
                  </div>
                  <div
                    className={"coconote-merge-col" +
                      (cur === "remote" ? " picked" : "")}
                  >
                    <div className="coconote-merge-col-head">remote</div>
                    <pre>{c.remote || "<empty>"}</pre>
                  </div>
                </div>
                <div className="coconote-merge-actions-row">
                  <button
                    type="button"
                    onClick={() => setChoice(i, "local")}
                    disabled={cur === "local"}
                  >
                    ← take local
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(i, "remote")}
                    disabled={cur === "remote"}
                  >
                    take remote →
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(i, "base")}
                    disabled={cur === "base"}
                  >
                    reset (revert to base)
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <details
          className="coconote-merge-edit-panel"
          open={editing}
          onToggle={(e: JSX.TargetedEvent<HTMLDetailsElement>) =>
            setEditing(e.currentTarget.open)}
        >
          <summary>Edit merged buffer directly</summary>
          <textarea
            className="coconote-merge-textarea"
            value={merged}
            onInput={(e) => {
              setEdited(e.currentTarget.value);
              setDirty(true);
            }}
            rows={20}
          />
        </details>

        {err && <p className="coconote-modal-error">{err}</p>}

        <ModalActions
          onCancel={onClose}
          busy={!!busy}
          onConfirm={commit}
          disabled={!!busy || hasConflictMarkers}
          confirmTitle={hasConflictMarkers
            ? "Resolve all conflicts (or hand-edit the buffer) first"
            : direction === "pull"
            ? "Write the merged result locally AND push it back to the remote"
            : "Push the merged result to the remote AND overwrite local"}
          confirmLabel={busy ??
            (direction === "pull"
              ? "Save merged & sync remote"
              : "Push merged & save local")}
        />
      </div>
    </Modal>
  );
}

/** Build the merged text from chunks + per-chunk choices.
 *  - `auto`  → emit git-style conflict markers so the textarea shows
 *              something even when the user opens edit mode without
 *              resolving each chunk.
 *  - `base`  → revert to base text (the spec's "reset" action).
 *  - `local` / `remote` → take that side. */
function assemble(chunks: Chunk[], choices: ChunkChoice[]): string {
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.kind === "ok") {
      out.push(c.text);
      continue;
    }
    const ch = choices[i];
    if (ch === "local") out.push(c.local);
    else if (ch === "remote") out.push(c.remote);
    else if (ch === "base") out.push(c.base);
    else {
      out.push(
        "<<<<<<< local\n" + c.local +
          (c.base ? "||||||| base\n" + c.base : "") +
          "=======\n" + c.remote +
          ">>>>>>> remote\n",
      );
    }
  }
  return out.join("");
}
