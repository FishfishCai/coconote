import { useEffect, useState } from "preact/hooks";
import {
  listRemoteVaults,
  probeRemoteVault,
  type RemoteVault,
  removeRemoteVault,
  upsertRemoteVault,
} from "../../lib/remote_vaults.ts";
import { newUuid } from "../../lib/uuid.ts";
import { getConfig, patchConfig } from "../../lib/config_api.ts";
import { errMessage } from "../../lib/constants.ts";

// setting.md §Remote: + opens a (URL, optional token) modal. The URL
// itself round-trips through PATCH /.config (added to coconote.yaml's
// `url:` list); the optional token stays in localStorage so it's never
// committed to a yaml on disk (welcome.md `url:` is just URLs).

async function fetchYamlUrls(): Promise<string[]> {
  return (await getConfig()).url ?? [];
}

export function RemoteVaultsSection() {
  const [yamlUrls, setYamlUrls] = useState<string[]>([]);
  const [vaults, setVaults] = useState<RemoteVault[]>([]);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const reload = () => {
    setVaults(listRemoteVaults());
    fetchYamlUrls()
      .then(setYamlUrls)
      .catch(() => setYamlUrls([]));
  };

  useEffect(reload, [adding, removingId]);

  const submit = async () => {
    setError(null);
    if (!url.trim()) {
      setError("URL is required.");
      return;
    }
    setProbing(true);
    const u = url.trim().replace(/\/+$/, "");
    const r = await probeRemoteVault(u, token.trim() || undefined);
    setProbing(false);
    if (!r.ok) {
      setError(`Probe failed: ${r.error}`);
      return;
    }
    try {
      await patchConfig({ addUrl: u });
    } catch (e: unknown) {
      setError(errMessage(e));
      return;
    }
    // setting.md: the spec only asks for URL + optional token. The
    // display label is derived deterministically from the URL hostname
    // so listings stay scannable; no extra user input needed.
    const v: RemoteVault = {
      id: newUuid(),
      label: safeHostname(u),
      url: u,
      token: token.trim() || undefined,
    };
    upsertRemoteVault(v);
    setAdding(false);
    setUrl("");
    setToken("");
  };

  const cancelAdd = () => {
    setAdding(false);
    setUrl("");
    setToken("");
    setError(null);
  };

  const confirmRemove = async (v: RemoteVault) => {
    try {
      await patchConfig({ removeUrl: v.url });
    } catch (e: unknown) {
      setError(errMessage(e));
    }
    removeRemoteVault(v.id);
    setRemovingId(null);
  };

  // Merge: anything in coconote.yaml that isn't in localStorage gets
  // surfaced as a token-less vault — keeps "real" yaml authoritative.
  const merged: RemoteVault[] = [
    ...vaults,
    ...yamlUrls
      .filter((u) => !vaults.some((v) => v.url === u))
      .map((u) => ({ id: u, label: safeHostname(u), url: u })),
  ];

  return (
    <section>
      <div className="coconote-pages-head">
        <h2>Remote</h2>
        {!adding && (
          <button
            type="button"
            className="coconote-pages-add"
            title="Add a remote server"
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )}
      </div>
      {adding && (
        <form
          className="coconote-pages-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            <span>URL</span>
            <input
              type="text"
              autoFocus
              placeholder="http://host:40704"
              value={url}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>Token</span>
            <input
              type="password"
              placeholder="optional bearer token"
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
          </label>
          {error && <div className="coconote-pages-error">{error}</div>}
          <div className="coconote-pages-add-actions">
            <button type="button" onClick={cancelAdd}>Cancel</button>
            <button
              type="submit"
              className="primary"
              disabled={probing || !url.trim()}
            >
              {probing ? "Probing…" : "Add remote"}
            </button>
          </div>
        </form>
      )}
      <div className="coconote-pages-list">
        {merged.length === 0 && !adding && (
          <p className="coconote-settings-hint">No remote servers yet.</p>
        )}
        {merged.map((v) => (
          <div key={v.id} className="coconote-pages-root">
            <div className="coconote-pages-root-head">
              <span className="coconote-pages-chevron">▸</span>
              <span className="coconote-pages-root-name">{v.label}</span>
              <span className="coconote-pages-root-path">{v.url}</span>
              {removingId !== v.id && (
                <button
                  type="button"
                  className="coconote-pages-remove"
                  title="Remove this remote"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemovingId(v.id);
                  }}
                >
                  −
                </button>
              )}
              {removingId === v.id && (
                <span
                  className="coconote-pages-remove-confirm"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="coconote-pages-remove-prompt">Remove?</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => confirmRemove(v)}
                  >
                    Yes
                  </button>
                  <button type="button" onClick={() => setRemovingId(null)}>
                    No
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// new URL(...) throws on malformed input — a hand-edited yaml line like
// `localhost:40704` (no scheme) would otherwise crash the entire
// settings tree. Fall back to the raw string as a label.
function safeHostname(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}
