// Graph view for the exported static site: the same directed force
// graph as the app's Content browser (shared renderer + simulation in
// components/force_graph.tsx / lib/graph_layout.ts). Edges come from
// the manifest's pre-resolved `links` + `prereqs` vault paths, node
// colour from the first tag, click navigates to the page's html.

import { useMemo } from "preact/hooks";
import {
  type Edge,
  type Node,
  seedPosition,
} from "../lib/graph_layout.ts";
import {
  bucketColor,
  ForceGraphSvg,
  type NodeStyle,
  tagBucket,
} from "../components/force_graph.tsx";
import { pageMatchesQuery } from "../lib/page_match.ts";
import { pageBasename, pageHref, type SitePage } from "./manifest.ts";

// Same defaults as the app's tuner panel (cb_graph_view.tsx) - the
// panel itself is app-only, the site uses the resting values.
const SIM_PARAMS = { attract: 0.02, repulse: 8000 };

function buildSiteGraph(
  pages: SitePage[],
): { nodes: Node<SitePage>[]; edges: Edge[] } {
  const byPath = new Set(pages.map((p) => p.path));
  const nodes: Node<SitePage>[] = pages.map((p, i) => {
    const { x, y } = seedPosition(p.path, i, pages.length);
    return { id: p.path, page: p, x, y, vx: 0, vy: 0, fixed: false };
  });
  const edges: Edge[] = [];
  const edgeKey = new Set<string>();
  for (const p of pages) {
    // Manifest links/prereqs are already vault paths: an edge exists
    // when the target is itself an exported page. Dedup so a target
    // named in both prereq and the body counts once.
    for (const to of [...p.links, ...p.prereqs]) {
      if (to === p.path || !byPath.has(to)) continue;
      const k = `${p.path}\0${to}`;
      if (edgeKey.has(k)) continue;
      edgeKey.add(k);
      edges.push({ from: p.path, to });
    }
  }
  return { nodes, edges };
}

function styleFor(p: SitePage, q: string): NodeStyle {
  return {
    color: bucketColor(tagBucket(p.tags, 1)),
    matched: pageMatchesQuery(
      { name: p.path, title: p.title, tags: p.tags, headings: p.headings },
      q,
    ),
  };
}

export function SiteGraphView(
  { pages, filter }: { pages: SitePage[]; filter: string },
) {
  const { nodes, edges } = useMemo(() => buildSiteGraph(pages), [pages]);
  const q = filter.replace(/^#+/, "").toLowerCase();
  // Hoisted per-node styles so RAF-driven ticks only read the Map, with
  // an inline fallback for the one stale frame after a data change.
  const nodeStyle = useMemo(() => {
    const m = new Map<string, NodeStyle>();
    for (const n of nodes) m.set(n.id, styleFor(n.page, q));
    return m;
  }, [nodes, q]);

  if (nodes.length === 0) {
    return <p className="coconote-cb-empty">No pages found.</p>;
  }
  return (
    <div className="coconote-cb-graph coconote-site-graph">
      <ForceGraphSvg
        nodes={nodes}
        edges={edges}
        params={SIM_PARAMS}
        styleOf={(n) => nodeStyle.get(n.id) ?? styleFor(n.page, q)}
        labelOf={(n) => n.page.title || pageBasename(n.page)}
        onActivate={(n) => {
          window.location.href = pageHref(n.page);
        }}
      />
    </div>
  );
}
