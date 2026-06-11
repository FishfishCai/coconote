// Content browser shell - owns the view selector (Path / Tag / Graph),
// the shared filter input, and the Settings button. Each view lives in
// cb_<name>_view.tsx and is switched in-place.

import { useEffect, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import { CbTagView } from "./cb_tag_view.tsx";
import { CbPathView } from "./cb_path_view.tsx";
import { CbGraphView } from "./cb_graph_view.tsx";

type ViewMode = "path" | "tag" | "graph";
const VIEW_KEY = "coconote.contentBrowserView";

export function loadView(): ViewMode {
  // The URL is authoritative when the user landed on /.content/<view>.
  // Otherwise fall back to whatever they last picked (localStorage).
  if (location.pathname === "/.content/tag") return "tag";
  if (location.pathname === "/.content/graph") return "graph";
  if (
    location.pathname === "/.content/path" ||
    location.pathname === "/.content" ||
    location.pathname === "/.content/"
  ) {
    return "path";
  }
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw === "path" || raw === "tag" || raw === "graph") return raw;
  } catch { /* private browsing */ }
  return "path";
}

// `view` is controlled by MainUI so URL changes (back/forward,
// Cmd+Shift+C, a tag chip) switch the view even while mounted. MainUI
// owns the state + localStorage persistence (setContentBrowserView).
type Props = { client: Client; view: ViewMode; initialFilter: string };

export function ContentBrowser({ client, view, initialFilter }: Props) {
  const [filter, setFilter] = useState(initialFilter);

  // Tag chips set initialFilter. Sync prop -> state so a second chip
  // click works while the browser is already mounted.
  useEffect(() => setFilter(initialFilter), [initialFilter]);

  const allPages = client.ui.viewState.allPages;

  return (
    <div className="coconote-content-browser">
      <header className="coconote-cb-header">
        <h1 className="coconote-cb-title">Content</h1>
        <div className="coconote-cb-view-tabs" role="tablist">
          {(["path", "tag", "graph"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={"coconote-cb-view-tab" + (view === v ? " active" : "")}
              role="tab"
              aria-selected={view === v}
              onClick={() => {
                // Reflect in the URL, the navigator routes back through
                // setContentBrowserView which updates the view (content.md).
                client.navigateRoute({ kind: "content", view: v });
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="coconote-cb-actions">
          <input
            type="text"
            placeholder="filter"
            className="coconote-cb-filter"
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <button
            type="button"
            className="coconote-cb-settings"
            onClick={() => client.navigateRoute({ kind: "setting" })}
            title="Setting"
          >
            setting
          </button>
        </div>
      </header>
      <div className={"coconote-cb-body coconote-cb-body-" + view}>
        {view === "path" && (
          <CbPathView client={client} allPages={allPages} filter={filter} />
        )}
        {view === "tag" && (
          <CbTagView client={client} allPages={allPages} filter={filter} />
        )}
        {view === "graph" && (
          <CbGraphView client={client} allPages={allPages} filter={filter} />
        )}
      </div>
    </div>
  );
}
