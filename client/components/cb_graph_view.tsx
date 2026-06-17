// Graph view: pages and their `prereq:` declarations as a directed
// graph (A -> B reads "A has B as a prerequisite"). The force-directed
// layout (seeding / edges / integrator) lives in lib/graph_layout.ts,
// the SVG rendering + interaction in the shared force_graph.tsx (also
// used by the exported static site), this file owns the app-specific
// data filtering, the tuner panel, and navigation.

import { useMemo } from "preact/hooks";
import type { NavigationCtx as Client } from "../core/ctx/navigation.ts";
import type { PageMeta } from "coconote/type/page";
import { safeJsonParse } from "../lib/json.ts";
import { useLocalStorageState } from "../lib/dom_hooks.ts";
import { toPath } from "../lib/ref.ts";
import { pageMatchesQuery } from "../lib/page_match.ts";
import { buildGraph, type Node } from "../lib/graph_layout.ts";
import {
  bucketColor,
  ForceGraphSvg,
  type NodeStyle,
  tagBucket,
} from "./force_graph.tsx";

type Props = {
  client: Client;
  allPages: PageMeta[];
  filter: string;
};

const CONTROLS_KEY = "coconote.graphControls";

const TAG_LEVEL_MIN = 1;
const TAG_LEVEL_MAX = 32;

type GraphControls = {
  attract: number;
  repulse: number;
  /** Depth of the tag prefix used for node colouring (1..32). */
  tagLevel: number;
  showIsolated: boolean;
  /** content.md: hide PDF nodes so only markdown pages remain. */
  markdownOnly: boolean;
};

const DEFAULT_CONTROLS: GraphControls = {
  attract: 0.02,
  repulse: 8000,
  tagLevel: 1,
  showIsolated: true,
  markdownOnly: false,
};

// Merge with defaults so a later-added control won't read `undefined`
// from previously-persisted state.
const controlsCodec = {
  parse: (raw: string): GraphControls | undefined => {
    const v = safeJsonParse<Partial<GraphControls>>(raw);
    return v && typeof v === "object"
      ? { ...DEFAULT_CONTROLS, ...v }
      : undefined;
  },
  stringify: (c: GraphControls) => JSON.stringify(c),
};

function nodeColor(p: PageMeta, tagLevel: number): string {
  return p.origin?.kind === "remote"
    ? "#aaa"
    : bucketColor(tagBucket(p.tags, tagLevel));
}

export function CbGraphView({ client, allPages, filter }: Props) {
  const [controls, setControls] = useLocalStorageState<GraphControls>(
    CONTROLS_KEY,
    () => DEFAULT_CONTROLS,
    controlsCodec,
  );
  // Filter the graph DATA (not just rendering) so an excluded node
  // leaves the force simulation. `markdownOnly` drops PDFs first (can
  // newly isolate markdown nodes), then `showIsolated` drops whatever
  // has no remaining edge.
  const { nodes, edges } = useMemo(() => {
    let { nodes, edges } = buildGraph(allPages);
    if (controls.markdownOnly) {
      const isMd = (id: string) => !id.toLowerCase().endsWith(".pdf");
      nodes = nodes.filter((n) => isMd(n.id));
      edges = edges.filter((e) => isMd(e.from) && isMd(e.to));
    }
    if (!controls.showIsolated) {
      const linked = new Set<string>();
      for (const e of edges) {
        linked.add(e.from);
        linked.add(e.to);
      }
      nodes = nodes.filter((n) => linked.has(n.id));
    }
    return { nodes, edges };
  }, [allPages, controls.markdownOnly, controls.showIsolated]);

  const q = filter.replace(/^#+/, "").toLowerCase();
  // Per-node colour + filter match, hoisted so RAF-driven ticks only
  // read the Map. Filter scope shared with Path / Tag views (content.md):
  // folder names, file names, tags at every level, titles, headings.
  const nodeStyle = useMemo(() => {
    const m = new Map<string, NodeStyle>();
    for (const n of nodes) {
      m.set(n.id, {
        color: nodeColor(n.page, controls.tagLevel),
        matched: pageMatchesQuery(n.page, q),
      });
    }
    return m;
  }, [nodes, q, controls.tagLevel]);
  // One stale frame can render nodes that just left the data (the
  // renderer re-seats its refs in an effect): compute those inline.
  const styleOf = (n: Node) =>
    nodeStyle.get(n.id) ?? {
      color: nodeColor(n.page, controls.tagLevel),
      matched: pageMatchesQuery(n.page, q),
    };

  if (nodes.length === 0) {
    return <p className="coconote-cb-empty">No pages found.</p>;
  }

  const setControl = <K extends keyof GraphControls>(
    k: K,
    v: GraphControls[K],
  ) => setControls((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="coconote-cb-graph">
      <aside className="coconote-cb-graph-controls">
        <label>
          Attraction
          <input
            type="range"
            min={0.005}
            max={0.08}
            step={0.005}
            value={controls.attract}
            onInput={(e) =>
              setControl("attract", parseFloat(e.currentTarget.value))}
          />
        </label>
        <label>
          Repulsion
          <input
            type="range"
            min={1000}
            max={20000}
            step={500}
            value={controls.repulse}
            onInput={(e) =>
              setControl("repulse", parseFloat(e.currentTarget.value))}
          />
        </label>
        <label>
          Tag colouring level
          <input
            type="number"
            min={TAG_LEVEL_MIN}
            max={TAG_LEVEL_MAX}
            step={1}
            value={controls.tagLevel}
            onInput={(e) => {
              const raw = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(raw)) return;
              const clamped = Math.min(TAG_LEVEL_MAX, Math.max(TAG_LEVEL_MIN, raw));
              setControl("tagLevel", clamped);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={controls.showIsolated}
            onChange={(e) =>
              setControl("showIsolated", e.currentTarget.checked)}
          />
          Show isolated nodes
        </label>
        <label>
          <input
            type="checkbox"
            checked={controls.markdownOnly}
            onChange={(e) =>
              setControl("markdownOnly", e.currentTarget.checked)}
          />
          Markdown files only
        </label>
      </aside>
      <ForceGraphSvg
        nodes={nodes}
        edges={edges}
        params={{ attract: controls.attract, repulse: controls.repulse }}
        styleOf={styleOf}
        labelOf={(n) =>
          n.page.title || n.page.name.split("/").pop() || n.page.name}
        radiusOf={(n) => (n.page.origin?.kind === "remote" ? 6 : 7)}
        onActivate={(n) => client.navigate({ path: toPath(n.page.name) })}
      />
    </div>
  );
}
