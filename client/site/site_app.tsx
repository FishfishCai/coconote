// Root component of the exported site's viewer: one filter input (the
// app's Content filter scope) over the active view. The view kind is
// fixed per shell page (index.html / tag.html / graph.html), switching
// views is the topbar's plain links.

import { useState } from "preact/hooks";
import type { SitePage, SiteView } from "./manifest.ts";
import { SitePathView, SiteTagView } from "./tree_views.tsx";
import { SiteGraphView } from "./graph_view.tsx";

export function SiteApp(
  { view, pages }: { view: SiteView; pages: SitePage[] },
) {
  const [filter, setFilter] = useState("");
  return (
    <div className="coconote-site-shell">
      <div className="coconote-site-controls">
        <input
          type="search"
          className="coconote-cb-filter"
          placeholder="Filter..."
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <div
        className={"coconote-site-body" +
          (view === "graph" ? " coconote-site-body-graph" : "")}
      >
        {view === "path" && <SitePathView pages={pages} filter={filter} />}
        {view === "tag" && <SiteTagView pages={pages} filter={filter} />}
        {view === "graph" && <SiteGraphView pages={pages} filter={filter} />}
      </div>
    </div>
  );
}
