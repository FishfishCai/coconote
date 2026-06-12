// Shared force-directed graph renderer: the SVG, the RAF simulation
// loop, and the drag / pan / zoom / hover interactions, extracted from
// cb_graph_view.tsx so the exported static site's graph shell
// (client/site/) renders the exact same graph. The pure physics lives
// in lib/graph_layout.ts. Callers own data construction, filtering,
// colour policy, and navigation.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Edge,
  type Node,
  type SimParams,
  step,
} from "../lib/graph_layout.ts";

// Max per-tick displacement (px) below which the layout counts as
// settled and the RAF loop parks.
const SETTLE_EPS = 0.05;

// A click (opens the page) is node mousedown + mouseup within 4px,
// anything farther becomes a drag and never opens.
const CLICK_SLOP_PX = 4;

/** First-tag prefix at the requested depth: `research/algebra` at level
 *  1 -> `research`, level 2 -> `research/algebra`. Untagged pages share
 *  one synthetic "(untagged)" bucket (one colour). */
export function tagBucket(tags: string[] | undefined, level: number): string {
  const first = tags?.[0];
  if (!first) return "(untagged)";
  const parts = first.split("/");
  return parts.slice(0, Math.max(1, level)).join("/");
}

export function bucketColor(bucket: string): string {
  if (bucket === "(untagged)") return "#9aa";
  // Hash -> hue, fixed saturation/lightness for readable contrast.
  let h = 0;
  for (let i = 0; i < bucket.length; i++) {
    h = (h * 31 + bucket.charCodeAt(i)) | 0;
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

export type NodeStyle = {
  color: string;
  /** False dims the node (used for filter misses). */
  matched: boolean;
};

type Props<P> = {
  nodes: Node<P>[];
  edges: Edge[];
  params: SimParams;
  /** Colour + filter match. Called per render, so callers should read
   *  from a memoized map (with an inline fallback: one stale frame can
   *  still render nodes that just left the data). */
  styleOf(n: Node<P>): NodeStyle;
  labelOf(n: Node<P>): string;
  radiusOf?(n: Node<P>): number;
  /** Click (mousedown + mouseup within the slop) on a node. */
  onActivate(n: Node<P>): void;
};

export function ForceGraphSvg<P>(
  { nodes, edges, params, styleOf, labelOf, radiusOf, onActivate }: Props<P>,
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Nodes live in refs so the simulation can mutate them without
  // re-rendering every tick. The monotonic `tick` state forces repaints.
  const nodesRef = useRef<Node<P>[]>(nodes);
  const byIdRef = useRef<Map<string, Node<P>>>(
    new Map(nodes.map((n) => [n.id, n])),
  );
  const edgesRef = useRef<Edge[]>(edges);
  // Re-seat the refs when `nodes` / `edges` change, one O(N) pass that
  // preserves (x, y, vx, vy, fixed) of nodes already in `byIdRef` so a
  // data refresh (fresh arrays, same ids) doesn't reset a settled
  // layout back to the seed ring.
  useEffect(() => {
    const prev = byIdRef.current;
    const nextMap = new Map<string, Node<P>>();
    const merged: Node<P>[] = nodes.map((n) => {
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
  // Set by the simulation effect. Drag handlers poke it so a parked
  // (settled) loop resumes, no-op while already running.
  const wakeRef = useRef<(() => void) | null>(null);

  // Topology signature (node ids + edges) so the simulation restarts on
  // real graph changes, not on every data refresh that rebuilds
  // identical arrays.
  const topoSig = useMemo(() =>
    nodes.map((n) => n.id).sort().join("\n") + "\0" +
    edges.map((e) => `${e.from}\0${e.to}`).sort().join("\n"), [nodes, edges]);

  // Simulation loop: step() runs every frame while the layout moves so
  // drags, knob changes, and new edges show live. Damping in step()
  // bleeds energy out, below SETTLE_EPS the loop parks (no step, no
  // re-render) until woken by a drag (wakeRef), a knob change, or a
  // topology change (effect deps).
  useEffect(() => {
    let raf = 0;
    let running = false;
    const p: SimParams = {
      attract: params.attract,
      repulse: params.repulse,
    };
    const loop = () => {
      const ns = nodesRef.current;
      let moved = 0;
      if (ns.length > 0) {
        moved = step(ns, edgesRef.current, byIdRef.current, p);
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
  }, [topoSig, params.attract, params.repulse]);

  // Client (x,y) inside the SVG -> viewBox coords.
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
      if (n) {
        n.fixed = false;
        // The released node and its neighbours still need to relax.
        wakeRef.current?.();
        if (!d.moved) onActivate(n);
      }
    }
    dragRef.current = null;
  };

  // Hovered node + 1-hop neighbours.
  const highlightSet = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);

  // `tick` is read only to make Preact treat the SVG as dirty - the
  // actual positions live on the mutable nodesRef.
  void tick;
  const ns = nodesRef.current;

  return (
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
        const style = styleOf(n);
        const hot = highlightSet ? highlightSet.has(n.id) : false;
        const dim = (highlightSet && !hot) || !style.matched;
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
              r={radiusOf ? radiusOf(n) : 7}
              fill={hot ? "#ff9500" : style.color}
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
              {labelOf(n)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
