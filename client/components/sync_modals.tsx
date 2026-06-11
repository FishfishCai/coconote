// Push / Pull modals for the content-browser right-click menu (content.md
// push/pull): push picks (url, root) on a remote, pull picks a local root.
// Folder batches reuse them - the first item picks the target, later items
// auto-run, collisions offer "apply to the rest" (history.md Push / Pull).

import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import { authedFetch } from "../lib/authed_fetch.ts";
import { errMessage } from "../lib/constants.ts";
import { toPath } from "../lib/ref.ts";
import { listRemoteVaults, probeRemoteVault } from "../lib/remote_vaults.ts";
import {
  pushLocalToRemote,
  type PushOutcome,
  type PushTarget,
} from "../lib/sync_push.ts";
import { pullRemoteToLocal, type PullOutcome } from "../lib/sync_pull.ts";
import type { SyncListings } from "../lib/sync_core.ts";
import { MergeView } from "./merge_view.tsx";
import { ModalActions } from "./modal_actions.tsx";
import { Modal } from "./modal.tsx";

/** Shared overwrite/skip memory for a batch queue, set when the user
 *  ticks "apply the same choice to the rest" (history.md). */
export type BatchChoice = { current: "overwrite" | "skip" | null };

/** The push target the user picked. A batch remembers it so items
 *  after the first auto-run without re-prompting. */
export type PushTargetChoice = { url: string; token?: string; rootName: string };

type ProbeState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ok"; roots: string[] }
  | { kind: "error"; message: string };

type CollisionPrompt = {
  text: string;
  resolve: (overwrite: boolean, applyToRest: boolean) => void;
};

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function probeRemoteRoots(
  url: string,
  token: string | undefined,
): Promise<string[]> {
  const r = await probeRemoteVault(normalizeUrl(url), token);
  if (!r.ok) throw new Error(r.error);
  return Object.keys(r.rootPath ?? {});
}

/** Per-file overwrite confirmation with the spec's "apply the same
 *  choice to the rest" option (checkbox only shown in batch context). */
function CollisionSection(
  { prompt, batch }: { prompt: CollisionPrompt; batch: boolean },
) {
  const [applyRest, setApplyRest] = useState(false);
  return (
    <div className="coconote-modal-collision">
      <p className="coconote-modal-error">{prompt.text}</p>
      {batch && (
        <label className="coconote-modal-apply-rest">
          <input
            type="checkbox"
            checked={applyRest}
            onInput={(e) => setApplyRest(e.currentTarget.checked)}
          />
          Apply the same choice to the rest
        </label>
      )}
      <ModalActions
        onCancel={() => prompt.resolve(false, applyRest)}
        cancelLabel="Skip"
        onConfirm={() => prompt.resolve(true, applyRest)}
        confirmLabel="Overwrite"
      />
    </div>
  );
}

export function PushModal({
  client,
  localPath,
  onClose,
  initialTarget,
  autoRun = false,
  batchChoice,
  listings,
  onTargetChosen,
}: {
  client: Client;
  localPath: string;
  onClose(): void;
  /** Prefill from a previous batch item. */
  initialTarget?: PushTargetChoice;
  /** Run immediately with `initialTarget` (batch items after the first). */
  autoRun?: boolean;
  /** Shared overwrite/skip memory across a batch queue. */
  batchChoice?: BatchChoice;
  /** Shared listing cache across a batch queue. */
  listings?: SyncListings;
  /** Reports the target actually used, so the batch can remember it. */
  onTargetChosen?(t: PushTargetChoice): void;
}) {
  const saved = useMemo(() => listRemoteVaults(), []);
  const [url, setUrl] = useState<string>(initialTarget?.url ?? saved[0]?.url ?? "");
  const [token, setToken] = useState<string>(
    initialTarget?.token ?? saved[0]?.token ?? "",
  );
  const [rootName, setRootName] = useState<string>(initialTarget?.rootName ?? "");
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collision, setCollision] = useState<CollisionPrompt | null>(null);
  const [merge, setMerge] = useState<
    Extract<PushOutcome, { kind: "conflict" }> | null
  >(null);

  // Re-probe on URL/token change so the "Target root" dropdown tracks
  // the URL the user is typing / picking.
  useEffect(() => {
    const u = normalizeUrl(url);
    if (!u || !/^https?:\/\//i.test(u)) {
      setProbe({ kind: "idle" });
      setRootName("");
      return;
    }
    let cancelled = false;
    setProbe({ kind: "probing" });
    void (async () => {
      try {
        const roots = await probeRemoteRoots(u, token || undefined);
        if (cancelled) return;
        setProbe({ kind: "ok", roots });
        setRootName((prev) =>
          prev && roots.includes(prev) ? prev : roots[0] ?? ""
        );
      } catch (e: unknown) {
        if (cancelled) return;
        setProbe({ kind: "error", message: errMessage(e) });
        setRootName("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, token]);

  const onPickSaved = (id: string) => {
    const v = saved.find((x) => x.id === id);
    if (!v) return;
    setUrl(v.url);
    setToken(v.token ?? "");
  };

  const handleOutcome = async (outcome: PushOutcome): Promise<void> => {
    switch (outcome.kind) {
      case "clean":
      case "autoMerged":
      case "noop":
        onClose();
        return;
      case "conflict":
        setMerge(outcome);
        return;
      case "pathCollision": {
        // Batch memory short-circuits the prompt (history.md "apply the
        // same choice to the rest").
        if (batchChoice?.current === "overwrite") {
          await handleOutcome(await outcome.confirmOverwrite());
          return;
        }
        if (batchChoice?.current === "skip") {
          onClose();
          return;
        }
        setCollision({
          text:
            `${outcome.remotePath} already exists on ${outcome.remoteLabel}. Overwrite?`,
          resolve: (overwrite, applyToRest) => {
            setCollision(null);
            if (applyToRest && batchChoice) {
              batchChoice.current = overwrite ? "overwrite" : "skip";
            }
            if (!overwrite) {
              onClose();
              return;
            }
            void (async () => {
              setBusy(true);
              try {
                await handleOutcome(await outcome.confirmOverwrite());
              } catch (e: unknown) {
                setError(errMessage(e));
              } finally {
                setBusy(false);
              }
            })();
          },
        });
        return;
      }
      case "remoteMissing":
        setError("Remote URL unreachable.");
        return;
      case "idMissing":
        setError(
          "Source has no page id yet — save the markdown once, or include the PDF first.",
        );
        return;
    }
  };

  const onPush = async (explicit?: PushTargetChoice) => {
    setBusy(true);
    setError(null);
    try {
      const u = normalizeUrl(explicit?.url ?? url);
      const tok = (explicit?.token ?? token) || undefined;
      const root = explicit?.rootName ?? rootName;
      // Use the saved vault id when the URL exactly matches a saved
      // entry (preserves identity for the in-memory cache), otherwise
      // treat it as a typed URL.
      const matched = saved.find((v) => v.url === u);
      const target: PushTarget = matched
        ? { kind: "saved", vaultId: matched.id }
        : { kind: "url", url: u, token: tok };
      onTargetChosen?.({ url: u, token: tok, rootName: root });
      await handleOutcome(
        await pushLocalToRemote(localPath, target, root, listings),
      );
    } catch (e: unknown) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Batch items after the first run straight away with the remembered
  // target, the modal stays up only as a progress/conflict surface.
  useEffect(() => {
    if (autoRun && initialTarget) void onPush(initialTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  if (merge) {
    return (
      <MergeView
        localPath={localPath}
        baseText={merge.baseText}
        localText={merge.localText}
        remoteText={merge.remoteText}
        direction="push"
        commitMerged={async (bytes) => {
          await merge.commitMerged(bytes);
          void client.contentManager.loadPage({ path: toPath(localPath) });
        }}
        onClose={() => {
          setMerge(null);
          onClose();
        }}
      />
    );
  }

  const canPush = probe.kind === "ok" && !!rootName && !busy;

  return (
    <Modal title={`Push ${localPath}`} size="wide" onClose={onClose}>
      <div className="coconote-sync-form">
        <label>
          Target URL
          <input
            type="text"
            placeholder="http://host:port"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            autoFocus
          />
        </label>
        {saved.length > 0 && (
          <label>
            Saved remotes
            <select
              value={saved.find((v) => v.url === normalizeUrl(url))?.id ?? ""}
              onChange={(e) => onPickSaved(e.currentTarget.value)}
            >
              <option value="">— pick to fill —</option>
              {saved.map((v) => (
                <option key={v.id} value={v.id}>{v.label} · {v.url}</option>
              ))}
            </select>
          </label>
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
        <label>
          Target root
          <select
            value={rootName}
            onChange={(e) => setRootName(e.currentTarget.value)}
            disabled={probe.kind !== "ok"}
          >
            {probe.kind === "ok"
              ? probe.roots.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))
              : <option value="">{
                probe.kind === "probing" ? "probing…" : "—"
              }</option>}
          </select>
        </label>
        {probe.kind === "error" && (
          <p className="coconote-modal-error">Probe failed: {probe.message}</p>
        )}
        {error && <p className="coconote-modal-error">{error}</p>}
        {collision
          ? <CollisionSection prompt={collision} batch={!!batchChoice} />
          : (
            <ModalActions
              onCancel={onClose}
              busy={busy}
              onConfirm={() => void onPush()}
              disabled={!canPush}
              confirmLabel={busy ? "Pushing…" : "Push"}
            />
          )}
      </div>
    </Modal>
  );
}

export function PullModal({
  client,
  remotePrefixedPath,
  onClose,
  initialRoot,
  autoRun = false,
  batchChoice,
  listings,
  onRootChosen,
}: {
  client: Client;
  /** Prefixed `@<label>/<root>/...` path from the browser tree. */
  remotePrefixedPath: string;
  onClose(): void;
  /** Prefill from a previous batch item. */
  initialRoot?: string;
  /** Run immediately with `initialRoot` (batch items after the first). */
  autoRun?: boolean;
  /** Shared overwrite/skip memory across a batch queue. */
  batchChoice?: BatchChoice;
  /** Shared listing cache across a batch queue. */
  listings?: SyncListings;
  /** Reports the root actually used, so the batch can remember it. */
  onRootChosen?(root: string): void;
}) {
  const [localRoots, setLocalRoots] = useState<string[]>([]);
  const [rootName, setRootName] = useState<string>(initialRoot ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collision, setCollision] = useState<CollisionPrompt | null>(null);
  const [merge, setMerge] = useState<
    Extract<PullOutcome, { kind: "conflict" }> | null
  >(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await authedFetch("/.health");
        if (!r.ok) return;
        const body = await r.json();
        const names = Object.keys(body?.rootPath ?? {});
        setLocalRoots(names);
        if (names.length > 0) setRootName((prev) => prev || names[0]);
      } catch {/* ignore */}
    })();
  }, []);

  const handleOutcome = async (outcome: PullOutcome): Promise<void> => {
    switch (outcome.kind) {
      case "clean":
      case "autoMerged":
      case "noop":
        onClose();
        return;
      case "conflict":
        setMerge(outcome);
        return;
      case "pathCollision": {
        if (batchChoice?.current === "overwrite") {
          await handleOutcome(await outcome.confirmOverwrite());
          return;
        }
        if (batchChoice?.current === "skip") {
          onClose();
          return;
        }
        setCollision({
          text: `${outcome.localPath} already exists locally. Overwrite?`,
          resolve: (overwrite, applyToRest) => {
            setCollision(null);
            if (applyToRest && batchChoice) {
              batchChoice.current = overwrite ? "overwrite" : "skip";
            }
            if (!overwrite) {
              onClose();
              return;
            }
            void (async () => {
              setBusy(true);
              try {
                await handleOutcome(await outcome.confirmOverwrite());
              } catch (e: unknown) {
                setError(errMessage(e));
              } finally {
                setBusy(false);
              }
            })();
          },
        });
        return;
      }
      case "remoteMissing":
        setError("Source remote vault is not registered.");
        return;
      case "idMissing":
        setError(
          "Source has no page id — markdown needs an id: in its frontmatter, PDFs an included sidecar.",
        );
        return;
    }
  };

  const onPull = async (explicitRoot?: string) => {
    setBusy(true);
    setError(null);
    try {
      const root = explicitRoot ?? rootName;
      onRootChosen?.(root);
      await handleOutcome(
        await pullRemoteToLocal(remotePrefixedPath, root, listings),
      );
    } catch (e: unknown) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoRun && initialRoot) void onPull(initialRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  if (merge) {
    return (
      <MergeView
        localPath={merge.localPath}
        baseText={merge.baseText}
        localText={merge.localText}
        remoteText={merge.remoteText}
        direction="pull"
        commitMerged={async (bytes) => {
          await merge.commitMerged(bytes);
          void client.contentManager.loadPage({ path: toPath(merge.localPath) });
        }}
        onClose={() => {
          setMerge(null);
          onClose();
        }}
      />
    );
  }

  return (
    <Modal title={`Pull ${remotePrefixedPath}`} size="wide" onClose={onClose}>
      <div className="coconote-sync-form">
        <label>
          Target root (local)
          <select
            value={rootName}
            onChange={(e) => setRootName(e.currentTarget.value)}
          >
            {localRoots.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {error && <p className="coconote-modal-error">{error}</p>}
        {collision
          ? <CollisionSection prompt={collision} batch={!!batchChoice} />
          : (
            <ModalActions
              onCancel={onClose}
              busy={busy}
              onConfirm={() => void onPull()}
              disabled={busy || !rootName}
              confirmLabel={busy ? "Pulling…" : "Pull"}
            />
          )}
      </div>
    </Modal>
  );
}
