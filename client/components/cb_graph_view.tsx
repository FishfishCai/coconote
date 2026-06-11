// Graph view: pages and their `prereq:` declarations as a directed
// graph (A → B reads "A has B as a prerequisite"). The hand-rolled
// force-directed layout (seeding / edge construction / integrator)
// lives in lib/graph_layout.ts; this file owns rendering + interaction.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ClientContext as Client } from "../core/context.ts";
import type { PageMeta } from "coconote/type/page";
import { safeJsonParse } from "../lib/json.ts";
import { useLocalStorageState } from "../lib/dom_hooks.ts";
import { toPath } from "../lib/ref.ts";
import { pageMatchesQuery } from "../lib/page_match.ts";
import {
  buildGraph,
  type Edge,
  type Node,
  type SimParams,
  step,
} from "../lib/graph_layout.ts";

type Props = {
  client: Client;
  allPages: PageMeta[];
  filter: string;
};

// Max per-tick displacement (px) below which the layout counts as
// settled and the RAF loop parks itself.
const SETTLE_EPS = 0.05;

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

// Merge-with-defaults codec so adding a new control later won't read
// `undefined` from previously-persisted state.
const controlsCodec = {
  parse: (raw: string): GraphControls | undefined => {
    const v = safeJsonParse<Partial<GraphControls>>(raw);
    return v && typeof v === "object"
      ? { ...DEFAULT_CONTROLS, ...v }
      : undefined;
  },
  stringify: (c: GraphControls) => JSON.stringify(c),
};

/** First-tag root at the requested depth. `tag: research/algebra` with
 *  level 1 → `research`; with level 2 → `research/algebra`. Pages with
 *  no tag get a synthetic "(untagged)" bucket so they share one colour. */
function tagBucket(p: PageMeta, level: number): string {
  const first = p.tags?.[0];
  if (!first) return "(untagged)";
  const parts = first.split("/");
  return parts.slice(0, Math.max(1, level)).join("/");
}

function bucketColor(bucket: string): string {
  if (bucket === "(untagged)") return "#9aa";
  // Hash → hue; fixed saturation/lightness for readable contrast.
  let h = 0;
  for (let i = 0; i < bucket.length; i++) {
    h = (h * 31 + bucket.charCodeAt(i)) | 0;
  }
  const hue = ((h >>> 0) % 360);
  return `hsl(${hue}, 60%, 55%)`;
}

export function CbGraphView({ client, allPages, filter }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [controls, setControls] = useLocalStorageState<GraphControls>(
    CONTROLS_KEY,
    () => DEFAULT_CONTROLS,
    controlsCodec,
  );
  // Apply the panel filters to the graph DATA (not just rendering) so an
  // excluded node leaves the force simulation entirely. `markdownOnly`
  // drops PDF pages first, which can newly isolate markdown nodes, then
  // `showIsolated` drops whatever has no remaining edge.
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
  // We keep the nodes array as a ref so we can mutate during the
  // simulation without re-rendering on every tick. A monotonic `tick`
  // state forces React to repaint.
  const nodesRef = useRef<Node[]>(nodes);
  const byIdRef = useRef<Map<string, Node>>(
    new Map(nodes.map((n) => [n.id, n])),
  );
  const edgesRef = useRef<Edge[]>(edges);
  // Re-seat the mutable refs whenever `nodes` / `edges` change, building
  // the merged array + Map in one O(N) pass and preserving (x, y, vx,
  // vy, fixed) of nodes already in `byIdRef` — so the 10s allPages
  // refresh (fresh arrays, same ids) doesn't reset a settled layout
  // back to the seed ring.
  useEffect(() => {
    const prev = byIdRef.current;
    const nextMap = new Map<string, Node>();
    const merged: Node[] = nodes.map((n) => {
      const old = prev.get(n.id);
      const next = old
        ? {
          ...n,
          x: old.x,
          y: old.y,
          vx: old.vx,
          vy: old.vy,
          fixed: old.fixed,
        }
        : n;
      nextMap.set(n.id, next);
      return next;
    });
    nodesRef.current = merged;
    byIdRef.current = nextMap;
    edgesRef.current = edges;
  }, [nodes, edges]);

  const [tick, setTick] = useState(0);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1000, h: 700 });
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<
    | {
        kind: "node";
        id: string;
        offX: number;
        offY: number;
        downX: number;
        downY: number;
        moved: boolean;
      }
    | { kind: "pan"; startX: number; startY: number; vbX: number; vbY: number }
    | null
  >(null);
  // Set by the simulation effect; drag handlers poke it so a parked
  // (settled) loop resumes integrating. No-op while already running.
  const wakeRef = useRef<(() => void) | null>(null);

  // Stable signature of the topology (node id set + edge set) so the
  // simulation restarts on real graph changes, not on every 10s
  // `allPages` refresh tick that re-builds the arrays with the same
  // contents.
  const topoSig = useMemo(() =>
    nodes.map((n) => n.id).sort().join("\n") + "\0" +
    edges.map((e) => `${e.from}\0${e.to}`).sort().join("\n"), [nodes, edges]);

  // Simulation loop: step() runs every frame while the layout is in
  // motion, so drag, knob changes, and new edges show up in real time.
  // Damping inside step() bleeds energy out; once the max per-tick
  // displacement falls below SETTLE_EPS the loop parks itself (no
  // step(), no re-render) and is woken again by a drag (wakeRef), a
  // knob change, or a topology change (effect deps).
  useEffect(() => {
    let raf = 0;
    let running = false;
    const params: SimParams = {
      attract: controls.attract,
      repulse: controls.repulse,
    };
    const loop = () => {
      const ns = nodesRef.current;
      let moved = 0;
      if (ns.length > 0) {
        moved = step(ns, edgesRef.current, byIdRef.current, params);
        setTick((t) => (t + 1) & 0xfff);
      }
      // Never park mid node-drag: the grabbed node is fixed (so it may
      // report ~zero motion) but neighbours must keep reacting.
      if (moved < SETTLE_EPS && dragRef.current?.kind !== "node") {
        running = false;
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    wake();
    return () => {
      wakeRef.current = null;
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [topoSig, controls.attract, controls.repulse]);


  // Map a client (x,y) inside the SVG to viewBox coords.
  const toVb = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: viewBox.x + ((clientX - r.left) / r.width) * viewBox.w,
      y: viewBox.y + ((clientY - r.top) / r.height) * viewBox.h,
    };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x: vx, y: vy } = toVb(e.clientX, e.clientY);
    const factor = Math.exp(e.deltaY * 0.001);
    const w = Math.max(200, Math.min(8000, viewBox.w * factor));
    const h = Math.max(140, Math.min(5600, viewBox.h * factor));
    // Anchor zoom around the cursor.
    const nx = vx - (vx - viewBox.x) * (w / viewBox.w);
    const ny = vy - (vy - viewBox.y) * (h / viewBox.h);
    setViewBox({ x: nx, y: ny, w, h });
  };

  // A "click" (open the page) is a node mousedown + mouseup with <4px
  // movement. Anything farther becomes a drag and never opens.
  const CLICK_SLOP_PX = 4;
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as SVGElement;
    const idAttr = t.getAttribute("data-node-id");
    const vb = toVb(e.clientX, e.clientY);
    if (idAttr) {
      const n = byIdRef.current.get(idAttr);
      if (n) {
        dragRef.current = {
          kind: "node",
          id: idAttr,
          offX: vb.x - n.x,
          offY: vb.y - n.y,
          downX: e.clientX,
          downY: e.clientY,
          moved: false,
        };
        n.fixed = true;
        wakeRef.current?.();
      }
    } else {
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        vbX: viewBox.x,
        vbY: viewBox.y,
      };
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "node") {
      const dist = Math.hypot(e.clientX - d.downX, e.clientY - d.downY);
      if (dist > CLICK_SLOP_PX) d.moved = true;
      const vb = toVb(e.clientX, e.clientY);
      const n = byIdRef.current.get(d.id);
      if (n) {
        n.x = vb.x - d.offX;
        n.y = vb.y - d.offY;
        wakeRef.current?.();
        setTick((t) => (t + 1) & 0xfff);
      }
    } else {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - d.startX) / r.width) * viewBox.w;
      const dy = ((e.clientY - d.startY) / r.height) * viewBox.h;
      setViewBox((vb) => ({ ...vb, x: d.vbX - dx, y: d.vbY - dy }));
    }
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    if (d?.kind === "node") {
      const n = byIdRef.current.get(d.id);
      if (n) n.fixed = false;
      // The released node and its neighbours still need to relax.
      wakeRef.current?.();
      // No movement → treat as a click and open the page.
      if (!d.moved) navigateToNode(d.id);
    }
    dragRef.current = null;
  };

  const navigateToNode = (id: string) => {
    const page = byIdRef.current.get(id)?.page;
    if (!page) return;
    client.navigate({ path: toPath(page.name) });
  };

  // Compute the highlight set (hovered node + 1-hop neighbours).
  const highlightSet = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);

  const q = filter.replace(/^#+/, "").toLowerCase();
  // Shared filter scope (content.md): folder names, file names, tags
  // at every level, titles, and headings — same predicate as the
  // Path / Tag views.
  const filterMatches = (n: Node) => pageMatchesQuery(n.page, q);

  // `tick` is read here only to make React treat the SVG as dirty —
  // the actual positions live on the mutable nodesRef.
  void tick;
  const ns = nodesRef.current;

  if (ns.length === 0) {
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
      <svg
        ref={svgRef}
        className="coconote-cb-graph-svg"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <defs>
          <marker
            id="cb-graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#888" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = byIdRef.current.get(e.from);
          const b = byIdRef.current.get(e.to);
          if (!a || !b) return null;
          // Trim the line so the arrowhead sits outside the target node.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const tx = b.x - (dx / d) * 14;
          const ty = b.y - (dy / d) * 14;
          const hot = highlightSet
            ? highlightSet.has(e.from) && highlightSet.has(e.to)
            : false;
          return (
            <line
              key={`${e.from}\0${e.to}`}
              x1={a.x}
              y1={a.y}
              x2={tx}
              y2={ty}
              stroke={hot ? "#ff9500" : "#888"}
              strokeOpacity={highlightSet && !hot ? 0.15 : 0.55}
              strokeWidth={hot ? 1.6 : 1}
              markerEnd="url(#cb-graph-arrow)"
            />
          );
        })}
        {ns.map((n) => {
          const isRemote = n.page.origin?.kind === "remote";
          const matched = filterMatches(n);
          const hot = highlightSet ? highlightSet.has(n.id) : false;
          const dim = (highlightSet && !hot) || (q && !matched);
          const baseFill = isRemote
            ? "#aaa"
            : bucketColor(tagBucket(n.page, controls.tagLevel));
          return (
            <g
              key={n.id}
              className="coconote-cb-graph-node"
              opacity={dim ? 0.22 : 1}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
            >
              <circle
                data-node-id={n.id}
                cx={n.x}
                cy={n.y}
                r={isRemote ? 6 : 7}
                fill={hot ? "#ff9500" : baseFill}
                stroke="#222"
                strokeWidth={hot ? 1.4 : 0.8}
                style={{ cursor: "pointer" }}
              />
              <text
                x={n.x + 10}
                y={n.y + 4}
                fontSize="11"
                fill="#222"
                pointerEvents="none"
              >
                {n.page.title || n.page.name.split("/").pop() || n.page.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
