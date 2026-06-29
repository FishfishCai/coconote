// Pure force-directed layout for the relation graph (SPEC graph): a
// recursive ego-graph from the current file along `refs` (out-edges) and
// `backrefs` (in-edges), plus the per-frame integrator. No DOM / Preact
// here - the shared SVG renderer (components/force_graph.tsx) owns
// rendering and interaction.

import type { PageMeta } from "coconote/type/page";

export type Node<P = PageMeta> = {
  id: string;
  page: P;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean; // user is dragging or pinned
};

export type Edge = { from: string; to: string };

export type SimParams = {
  /** content.md Graph view "attraction strength" - edge spring constant. */
  attract: number;
  /** content.md Graph view "repulsion strength" - pairwise Coulomb. */
  repulse: number;
};

// Stable starting positions so re-renders don't reshuffle the layout.
// Hash the page path into an angle so the same set of pages always
// fans out the same way before the simulation runs.
function seedPosition(
  name: string,
  i: number,
  n: number,
): { x: number; y: number } {
  // Use index for the dominant angle (uniform around the circle), hash
  // for the radial jitter (so the ring isn't perfectly circular).
  const angle = (i / Math.max(n, 1)) * Math.PI * 2;
  let h = 0;
  for (let j = 0; j < name.length; j++) h = (h * 31 + name.charCodeAt(j)) | 0;
  const jitter = ((h >>> 0) % 100) / 100;
  const r = 200 + jitter * 60;
  return { x: 500 + Math.cos(angle) * r, y: 350 + Math.sin(angle) * r };
}

// Build a recursive ego-graph from `startId`: BFS out along each file's
// `refs` (id list) and in along its `backrefs`, collecting every reachable
// file as a node. Edges are directed referrer -> referenced. Identity is
// the file id.
export function buildGraph(
  startId: string,
  pages: PageMeta[],
): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(pages.map((p) => [p.id, p]));

  const reached = new Set<string>();
  const edgeKey = new Set<string>();
  const edges: Edge[] = [];
  const addEdge = (from: string, to: string) => {
    if (to === from) return;
    const k = `${from}\0${to}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    edges.push({ from, to });
  };

  const queue: string[] = [];
  if (byId.has(startId)) {
    reached.add(startId);
    queue.push(startId);
  }
  while (queue.length) {
    const id = queue.shift()!;
    const page = byId.get(id);
    if (!page) continue;
    const visit = (targetId: string, isOut: boolean) => {
      const target = byId.get(targetId);
      if (!target) return;
      if (isOut) addEdge(id, target.id);
      else addEdge(target.id, id);
      if (!reached.has(target.id)) {
        reached.add(target.id);
        queue.push(target.id);
      }
    };
    for (const r of page.refs ?? []) visit(r, true);
    for (const b of page.backrefs ?? []) visit(b, false);
  }

  const reachedPages = [...reached].map((n) => byId.get(n)!);
  const nodes: Node[] = reachedPages.map((p, i) => {
    const { x, y } = seedPosition(p.id, i, reachedPages.length);
    return { id: p.id, page: p, x, y, vx: 0, vy: 0, fixed: false };
  });
  return { nodes, edges };
}

// One simulation step. Mutates `nodes` in place and returns the max
// per-node displacement applied this tick so the caller can park the
// animation loop once the layout has settled.
export function step<P>(
  nodes: Node<P>[],
  edges: Edge[],
  byId: Map<string, Node<P>>,
  params: SimParams,
): number {
  const REPULSE = params.repulse;
  const SPRING = params.attract;
  const REST_LEN = 110;
  const GRAVITY = 0.001; // weak pull toward centre so disconnected components don't drift off
  const DAMPING = 0.78;
  const MAX_STEP = 18; // clamp per-tick movement to avoid runaway nodes

  // Coulomb repulsion - O(N^2), adequate for single-user vault sizes.
  // Fixed (dragged) nodes must still EXERT force so the layout reacts
  // live - they just don't move themselves. Don't short-circuit with
  // `if (a.fixed) continue`: that drops both halves of every pair where
  // the dragged node is lower-indexed, killing the live drag physics.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy + 0.01;
      const f = REPULSE / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.fixed) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.fixed) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  // Spring attraction along each edge.
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f = SPRING * (d - REST_LEN);
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (!a.fixed) {
      a.vx += fx;
      a.vy += fy;
    }
    if (!b.fixed) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Gravity + damping + integrate.
  let maxMove = 0;
  for (const n of nodes) {
    if (n.fixed) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (500 - n.x) * GRAVITY;
    n.vy += (350 - n.y) * GRAVITY;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    const dx = Math.max(-MAX_STEP, Math.min(MAX_STEP, n.vx));
    const dy = Math.max(-MAX_STEP, Math.min(MAX_STEP, n.vy));
    n.x += dx;
    n.y += dy;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m > maxMove) maxMove = m;
  }
  return maxMove;
}
