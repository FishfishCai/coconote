// Push / Pull modal (design.md sync & remote). Addressing is by id: the
// same id on the chosen remote instance is the same file (the pairing key).
// The remote target is a URL from the config `url` list. ONE entry point,
// two directions: push lands on the remote, pull lands locally. The user
// picks the remote and the direction here; conflicts open MergeView.

import { useEffect, useState } from "preact/hooks";
import type { EditorCtx } from "../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../core/ctx/space.ts";
type Client = EditorCtx & SpaceCtx;
import { errMessage } from "../../core/util";
import { getConfig } from "../../core/config/index.ts";
import { type PushOutcome, pushLocalToRemote } from "./push.ts";
import { type PullOutcome, pullRemoteToLocal } from "./pull.ts";
import { MergeView } from "./merge_view.tsx";
import { Modal, ModalActions } from "../../core/ui";

type Direction = "push" | "pull";

// A conflict carried into MergeView, tagged with the direction it came from
// so the column labels and the merge submit match. The push and pull
// conflict payloads are structurally identical, so the common fields are
// copied out explicitly.
type ConflictState = {
  direction: Direction;
  baseText: string;
  localText: string;
  remoteText: string;
  commitMerged: (merged: Uint8Array) => Promise<void>;
};

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The config `url` list - push / pull targets (design.md config). */
function useRemoteUrls(): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    void getConfig().then((c) => setUrls((c.url ?? []).map((u) => u.url)))
      .catch(() => {});
  }, []);
  return urls;
}

export function SyncModal({
  client,
  fileId,
  title,
  onClose,
}: {
  client: Client;
  fileId: string;
  title: string;
  onClose(): void;
}) {
  const remoteUrls = useRemoteUrls();
  const [direction, setDirection] = useState<Direction>("push");
  const [url, setUrl] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<ConflictState | null>(null);

  useEffect(() => {
    if (!url && remoteUrls.length > 0) setUrl(remoteUrls[0]);
  }, [remoteUrls]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = { url: normalizeUrl(url), token: token || undefined };
      const outcome: PushOutcome | PullOutcome = direction === "push"
        ? await pushLocalToRemote(fileId, target)
        : await pullRemoteToLocal(fileId, target);
      switch (outcome.kind) {
        case "clean":
        case "autoMerged":
        case "noop":
          onClose();
          return;
        case "conflict":
          setMerge({
            direction,
            baseText: outcome.baseText,
            localText: outcome.localText,
            remoteText: outcome.remoteText,
            commitMerged: outcome.commitMerged,
          });
          return;
        case "remoteMissing":
          setError(
            direction === "push"
              ? "Remote URL unreachable."
              : "Source remote unreachable.",
          );
          return;
      }
    } catch (e: unknown) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (merge) {
    return (
      <MergeView
        label={title}
        baseText={merge.baseText}
        localText={merge.localText}
        remoteText={merge.remoteText}
        direction={merge.direction}
        commitMerged={async (bytes) => {
          await merge.commitMerged(bytes);
          void client.contentManager.loadPage({ id: fileId });
        }}
        onClose={() => {
          setMerge(null);
          onClose();
        }}
      />
    );
  }

  const canRun = /^https?:\/\//i.test(normalizeUrl(url)) && !busy;
  const verb = direction === "push" ? "Push" : "Pull";

  return (
    <Modal title={`${verb} ${title}`} size="wide" onClose={onClose}>
      <div className="coconote-sync-form">
        <label>
          Direction
          <select
            value={direction}
            onChange={(e) => setDirection(e.currentTarget.value as Direction)}
          >
            <option value="push">Push (local to remote)</option>
            <option value="pull">Pull (remote to local)</option>
          </select>
        </label>
        <label>
          {direction === "push" ? "Target URL" : "Source URL"}
          <input
            type="text"
            placeholder="http://host:port"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            list="coconote-remote-urls"
            autoFocus
          />
          <datalist id="coconote-remote-urls">
            {remoteUrls.map((u) => <option key={u} value={u} />)}
          </datalist>
        </label>
        {remoteUrls.length === 0 && (
          <p className="coconote-modal-hint">
            No remote instances configured. Add URLs to the config `url` list,
            or type a target above.
          </p>
        )}
        <label>
          Token
          <input
            type="password"
            placeholder="optional bearer token"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
          />
        </label>
        {error && <p className="coconote-modal-error">{error}</p>}
        <ModalActions
          onCancel={onClose}
          busy={busy}
          onConfirm={() => void run()}
          disabled={!canRun}
          confirmLabel={busy ? `${verb}ing...` : verb}
        />
      </div>
    </Modal>
  );
}
