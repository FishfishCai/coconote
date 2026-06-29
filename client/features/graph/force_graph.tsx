// Shared force-directed graph renderer: the SVG and the RAF simulation
// loop. The relation graph overlay (graph_overlay.tsx) feeds it the
// ego-graph. The pure physics lives in lib/graph_layout.ts. Callers own
// data construction, colour policy, and navigation.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Edge,
  type Node,
  type SimParams,
  step,
} from "./layout.ts";

// Max per-tick displacement (px) below which the layout counts as
// settled and the RAF loop parks.
const SETTLE_EPS = 0.05;

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
};

type Props<P> = {
  nodes: Node<P>[];
  edges: Edge[];
  params: SimParams;
  /** Colour for the node. Called per render, so callers should read from a
   *  memoized map (with an inline fallback: one stale frame can still
   *  render nodes that just left the data). */
  styleOf(n: Node<P>): NodeStyle;
  labelOf(n: Node<P>): string;
  radiusOf?(n: Node<P>): number;
  /** Click on a node (opens the page). */
  onActivate(n: Node<P>): void;
};

export function ForceGraphSvg<P>(
  { nodes, edges, params, styleOf, labelOf, radiusOf, onActivate }: Props<P>,
) {
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

  // Topology signature (node ids + edges) so the simulation restarts on
  // real graph changes, not on every data refresh that rebuilds
  // identical arrays.
  const topoSig = useMemo(() =>
    nodes.map((n) => n.id).sort().join("\n") + "\0" +
    edges.map((e) => `${e.from}\0${e.to}`).sort().join("\n"), [nodes, edges]);

  // Simulation loop: step() runs every frame while the layout moves so
  // knob changes and new edges show live. Damping in step() bleeds energy
  // out; below SETTLE_EPS the loop parks (no step, no re-render) until a
  // knob change or a topology change (effect deps) restarts it.
  useEffect(() => {
    let raf = 0;
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
      if (moved < SETTLE_EPS) return;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [topoSig, params.attract, params.repulse]);

  // `tick` is read only to make Preact treat the SVG as dirty - the
  // actual positions live on the mutable nodesRef.
  void tick;
  const ns = nodesRef.current;

  return (
    <svg
      className="coconote-cb-graph-svg"
      viewBox="0 0 1000 700"
      preserveAspectRatio="xMidYMid meet"
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
        return (
          <line
            key={`${e.from}\0${e.to}`}
            x1={a.x}
            y1={a.y}
            x2={tx}
            y2={ty}
            stroke="#888"
            strokeOpacity={0.55}
            strokeWidth={1}
            markerEnd="url(#cb-graph-arrow)"
          />
        );
      })}
      {ns.map((n) => (
        <g key={n.id} className="coconote-cb-graph-node">
          <circle
            cx={n.x}
            cy={n.y}
            r={radiusOf ? radiusOf(n) : 7}
            fill={styleOf(n).color}
            strokeWidth={0.8}
            // A halo in the page background separates the node from edges in
            // either theme (a hardcoded dark stroke vanished in dark mode).
            style={{ cursor: "pointer", stroke: "var(--background-primary)" }}
            onClick={() => onActivate(n)}
          />
          <text
            x={n.x + 10}
            y={n.y + 4}
            fontSize="11"
            pointerEvents="none"
            // Theme text colour, so labels stay legible in dark mode.
            style={{ fill: "var(--text-normal)" }}
          >
            {labelOf(n)}
          </text>
        </g>
      ))}
    </svg>
  );
}
