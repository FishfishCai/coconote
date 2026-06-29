// The recent list (Cmd/Ctrl+P): the file-centric model's navigation entry
// point. Lists `recent` + `pin` from the server config (id, path pairs),
// pinned on top. Selecting a row opens that file by id. The search box
// matches file CONTENT only (design.md: "supports file content search").
// Tags and title live inside the file body, so a content match already
// covers them. Bodies are fetched lazily by id and cached (lowercased).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { UICtx } from "../../core/ctx/ui.ts";
import type { NavigationCtx } from "../../core/ctx/navigation.ts";
import type { SpaceCtx } from "../../core/ctx/space.ts";
type Client = UICtx & NavigationCtx & SpaceCtx;
import { Modal } from "../../core/ui";
import { getConfig } from "../../core/config/index.ts";
import { pageById } from "../../capabilities/links/index.ts";
import { basename } from "../../core/util";

type Props = {
  client: Client;
  onClose: () => void;
};

type Entry = { id: string; path: string; pinned: boolean };

const SEARCH_DEBOUNCE_MS = 200;

export function RecentList({ client, onClose }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // id -> lowercased body content, fetched lazily for content search.
  const bodyCache = useRef(new Map<string, string>());
  const [bodyVersion, setBodyVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => {
        if (cancelled) return;
        const pin = cfg.pin ?? [];
        const pinSet = new Set(pin.map((p) => p.id));
        // pin first (always present), then recent minus already-pinned.
        const list: Entry[] = pin.map((p) => ({ ...p, pinned: true }));
        for (const r of cfg.recent ?? []) {
          if (!pinSet.has(r.id)) list.push({ ...r, pinned: false });
        }
        setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [entries]);

  // Debounce the filter so a content search doesn't fire per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filter.trim().toLowerCase()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);

  const pages = client.ui.viewState.allPages;
  const metaOf = (id: string) => pageById(id, pages);

  // Fetch bodies (by id) for content search once a non-empty query is
  // active. Cached, so repeated searches don't refetch.
  useEffect(() => {
    if (!debounced || !entries) return;
    let cancelled = false;
    void (async () => {
      for (const e of entries) {
        if (bodyCache.current.has(e.id)) continue;
        // PDFs have no text body to search; skip them.
        if (metaOf(e.id)?.kind === "pdf") {
          bodyCache.current.set(e.id, "");
          continue;
        }
        try {
          const { text } = await client.space.readPage(e.id, e.path || undefined);
          bodyCache.current.set(e.id, text.toLowerCase());
        } catch {
          bodyCache.current.set(e.id, "");
        }
        if (cancelled) return;
        setBodyVersion((v) => v + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, entries]);

  const shown = useMemo(() => {
    if (!entries) return [];
    const q = debounced;
    if (!q) return entries;
    return entries.filter((e) => {
      // Content-only match. `q` is lowercased (debounce) and the cached
      // body is lowercased, so the compare is case-insensitive.
      const body = bodyCache.current.get(e.id);
      return body?.includes(q) ?? false;
    });
    // bodyVersion in deps so newly-fetched bodies re-filter.
  }, [entries, debounced, bodyVersion]);

  const open = (id: string) => {
    const meta = metaOf(id);
    const entry = entries?.find((e) => e.id === id);
    onClose();
    void client.navigate({ id, title: meta?.title, path: entry?.path });
  };

  return (
    <Modal
      title="Recent"
      size="default"
      onClose={onClose}
      loading={entries === null && !error}
    >
      <div class="coconote-recent">
        <input
          ref={inputRef}
          type="text"
          class="coconote-recent-filter"
          placeholder="Search file content"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown.length > 0) {
              e.preventDefault();
              open(shown[0].id);
            }
          }}
        />
        {error && <div class="coconote-recent-error">{error}</div>}
        {entries?.length === 0 && (
          <div class="coconote-recent-empty">No recent files yet.</div>
        )}
        <div class="coconote-recent-list">
          {shown.map((e) => {
            const meta = metaOf(e.id);
            const label = meta?.title || basename(e.path) || e.id;
            const tags = meta?.tags ?? [];
            return (
              <button
                key={e.id}
                type="button"
                class="coconote-recent-row"
                onClick={() => open(e.id)}
              >
                {e.pinned && (
                  <span class="coconote-recent-pin" title="pinned" aria-hidden="true" />
                )}
                <span class="coconote-recent-name">{label}</span>
                <span class="coconote-recent-path">{e.path}</span>
                {tags.map((t) => (
                  <span key={t} class="coconote-recent-tag">{t}</span>
                ))}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
