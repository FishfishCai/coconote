import type { ClientContext as Client } from "../../core/context.ts";
import type { PageMeta } from "coconote/type/page";
import { encodePageURI, toPath } from "../../lib/ref.ts";
import { getConfig, patchConfig } from "../../lib/config_api.ts";
import { errMessage } from "../../lib/constants.ts";
import { useEffect, useState } from "preact/hooks";

type Root = { name: string; path: string };

// setting.md §Local: + opens a (name, absolute path) modal, − drops the
// row, and either path round-trips through PATCH /.config which
// rewrites coconote.yaml atomically and reloads the file index without
// restarting the server.

async function fetchRoots(): Promise<Root[]> {
  const map = (await getConfig()).root ?? {};
  return Object.entries(map).map(([name, path]) => ({ name, path }));
}

function groupPagesByRoot(pages: PageMeta[]): Map<string, PageMeta[]> {
  const m = new Map<string, PageMeta[]>();
  for (const p of pages) {
    const i = p.name.indexOf("/");
    const root = i > 0 ? p.name.slice(0, i) : "/";
    if (!m.has(root)) m.set(root, []);
    m.get(root)!.push(p);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return m;
}

export function PagesSection(props: { client: Client }) {
  const { client } = props;
  const [openRoots, setOpenRoots] = useState<Set<string>>(new Set());
  // setting.md §Local covers ONLY the yaml-configured local roots.
  // Remote-vault pages (origin kind "remote", names prefixed
  // "@<label>/") belong to the Remote section, so drop them before
  // grouping or every "@label" shows up as a bogus local root.
  const localPages = client.ui.viewState.allPages.filter(
    (p) => p.origin?.kind !== "remote" && !p.name.startsWith("@"),
  );
  const groups = groupPagesByRoot(localPages);

  const [roots, setRoots] = useState<Root[]>([]);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPath, setAddPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);

  const reload = () => {
    fetchRoots()
      .then((rs) => {
        setRoots(rs);
        setRootsError(null);
      })
      .catch((e) => setRootsError(String(e?.message ?? e)));
  };

  useEffect(reload, []);

  const toggleRoot = (root: string) => {
    setOpenRoots((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const onAdd = async () => {
    setAddError(null);
    const name = addName.trim();
    const path = addPath.trim();
    if (!name || !path) {
      setAddError("Name and absolute path required.");
      return;
    }
    setAddingBusy(true);
    try {
      await patchConfig({ addRoot: { name, path } });
      setAdding(false);
      setAddName("");
      setAddPath("");
      reload();
    } catch (e: unknown) {
      setAddError(errMessage(e));
    } finally {
      setAddingBusy(false);
    }
  };

  const onRemove = async (name: string) => {
    try {
      await patchConfig({ removeRoot: name });
      setRemovingName(null);
      reload();
    } catch (e: unknown) {
      setRootsError(errMessage(e));
    }
  };

  const displayRoots = roots.length > 0
    ? [
      ...roots.map((r) => r.name),
      ...[...groups.keys()].filter((n) => !roots.some((r) => r.name === n)),
    ]
    : [...groups.keys()].sort();

  return (
    <section>
      <div className="coconote-pages-head">
        <h2>Local</h2>
        {!adding && (
          <button
            type="button"
            className="coconote-pages-add"
            title="Add a local root"
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
            void onAdd();
          }}
        >
          <label>
            <span>Name</span>
            <input
              type="text"
              autoFocus
              placeholder="papers"
              value={addName}
              onInput={(e) => setAddName(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>Absolute path</span>
            <input
              type="text"
              placeholder="/Users/me/notes"
              value={addPath}
              onInput={(e) => setAddPath(e.currentTarget.value)}
            />
          </label>
          {addError && <div className="coconote-pages-error">{addError}</div>}
          <div className="coconote-pages-add-actions">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setAddName("");
                setAddPath("");
                setAddError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={addingBusy || !addName.trim() || !addPath.trim()}
            >
              {addingBusy ? "Adding…" : "Add root"}
            </button>
          </div>
        </form>
      )}
      {rootsError && (
        <p className="coconote-pages-error">
          {rootsError}
        </p>
      )}
      <div className="coconote-pages-list">
        {displayRoots.length === 0 && (
          <p className="coconote-settings-hint">No roots configured.</p>
        )}
        {displayRoots.map((root) => {
          const isOpen = openRoots.has(root);
          const pages = groups.get(root) ?? [];
          const rootInfo = roots.find((r) => r.name === root);
          return (
            <div key={root} className="coconote-pages-root">
              <div
                className="coconote-pages-root-head"
                onClick={() => toggleRoot(root)}
                role="button"
                aria-expanded={isOpen}
              >
                <span className="coconote-pages-chevron">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="coconote-pages-root-name">{root}</span>
                {rootInfo && (
                  <span className="coconote-pages-root-path">
                    {rootInfo.path}
                  </span>
                )}
                <span className="coconote-pages-root-count">{pages.length}</span>
                {removingName !== root && rootInfo && (
                  <button
                    type="button"
                    className="coconote-pages-remove"
                    title="Remove this root"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRemovingName(root);
                    }}
                  >
                    −
                  </button>
                )}
                {removingName === root && (
                  <span
                    className="coconote-pages-remove-confirm"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="coconote-pages-remove-prompt">Remove?</span>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onRemove(root)}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemovingName(null)}
                    >
                      No
                    </button>
                  </span>
                )}
              </div>
              {isOpen && (
                <ul className="coconote-pages-files">
                  {pages.map((p) => (
                    <li key={p.name}>
                      <a
                        href={"/" + encodePageURI(p.name)}
                        onClick={(e) => {
                          e.preventDefault();
                          client.navigate({ path: toPath(p.name) });
                        }}
                      >
                        {p.title || p.name}
                      </a>
                    </li>
                  ))}
                  {pages.length === 0 && (
                    <li className="coconote-pages-empty">
                      (no indexed pages)
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
