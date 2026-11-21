// Routing graph built from OSM polylines, plus A* search.
// OSM ways meet at shared nodes, so identical coordinates become one graph node.

import { dist, toLocal, type Vec } from './geo';
import type { Pt } from './osm';
import type { Rng } from './rng';

export interface Edge {
  to: number;
  cost: number; // what A* minimises: length × preference multiplier
  len: number; // metres
  tag: number; // free per-line label, e.g. road class
}

export interface Graph {
  nodes: Vec[];
  adj: Edge[][];
}

export interface GraphLine {
  p: Pt[];
  oneway?: 0 | 1 | -1;
  costFactor?: number; // >= 1, keeps the straight-line heuristic admissible
  tag?: number;
}

export function buildGraph(lines: GraphLine[]): Graph {
  const index = new Map<string, number>();
  const nodes: Vec[] = [];
  const adj: Edge[][] = [];

  const nodeId = ([lat, lng]: Pt) => {
    const key = `${lat},${lng}`;
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      index.set(key, i);
      nodes.push(toLocal({ lat, lng }));
      adj.push([]);
    }
    return i;
  };

  for (const line of lines) {
    const factor = Math.max(1, line.costFactor ?? 1);
    const tag = line.tag ?? 0;
    let prev = -1;
    for (const pt of line.p) {
      const cur = nodeId(pt);
      if (prev >= 0 && prev !== cur) {
        const len = dist(nodes[prev], nodes[cur]);
        const cost = len * factor;
        if (line.oneway !== -1) adj[prev].push({ to: cur, cost, len, tag });
        if (line.oneway !== 1) adj[cur].push({ to: prev, cost, len, tag });
      }
      prev = cur;
    }
  }
  return { nodes, adj };
}

/** Binary min-heap keyed by priority, storing node ids. */
class MinHeap {
  private ids: number[] = [];
  private pri: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, p: number) {
    const { ids, pri } = this;
    let i = ids.length;
    ids.push(id);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      ids[i] = ids[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    ids[i] = id;
    pri[i] = p;
  }

  pop(): number {
    const { ids, pri } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastP = pri.pop()!;
    if (ids.length > 0) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mp = lastP;
        if (l < n && pri[l] < mp) (m = l), (mp = pri[l]);
        if (r < n && pri[r] < mp) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        pri[i] = pri[m];
        i = m;
      }
      ids[i] = lastId;
      pri[i] = lastP;
    }
    return top;
  }
}

/** A* from start to goal. Returns node ids along the path, or null if unreachable. */
export function aStar(g: Graph, start: number, goal: number): number[] | null {
  const n = g.nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const goalPos = g.nodes[goal];
  const h = (i: number) => dist(g.nodes[i], goalPos);

  const open = new MinHeap();
  best[start] = 0;
  open.push(start, h(start));

  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) {
      const path = [cur];
      for (let i = came[cur]; i !== -1; i = came[i]) path.push(i);
      return path.reverse();
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    for (const e of g.adj[cur]) {
      const cost = best[cur] + e.cost;
      if (cost < best[e.to]) {
        best[e.to] = cost;
        came[e.to] = cur;
        open.push(e.to, cost + h(e.to));
      }
    }
  }
  return null;
}

/**
 * Random start inside `spawnArea`, routed to a destination chosen to be far away.
 * Retries when the pair is unreachable (one-way streets, network cut at the data edge).
 */
export function randomRoute(
  g: Graph,
  rnd: Rng,
  opts: { spawnArea: (v: Vec) => boolean; minDistance: number; candidates?: number; tries?: number },
): Vec[] | null {
  const startable = g.nodes.map((_, i) => i).filter((i) => g.adj[i].length > 0 && opts.spawnArea(g.nodes[i]));
  if (startable.length === 0) return null;

  for (let attempt = 0; attempt < (opts.tries ?? 12); attempt++) {
    const start = startable[Math.floor(rnd() * startable.length)];
    const path = routeFrom(g, rnd, start, opts);
    if (path) return path.map((i) => g.nodes[i]);
  }
  return null;
}

/**
 * Route from `start` to a destination chosen to be far away (node ids), or null.
 * `notVia`: reject routes whose first step goes to this node, e.g. to stop a
 * vehicle placed mid-street from turning straight back the way it faces.
 */
export function routeFrom(
  g: Graph,
  rnd: Rng,
  start: number,
  opts: { minDistance: number; candidates?: number; notVia?: number },
): number[] | null {
  const from = g.nodes[start];
  // Sample destinations, try the farthest ones first.
  const candidates: number[] = [];
  for (let k = 0; k < (opts.candidates ?? 40); k++) candidates.push(Math.floor(rnd() * g.nodes.length));
  candidates.sort((a, b) => dist(g.nodes[b], from) - dist(g.nodes[a], from));

  for (const goal of candidates.slice(0, 5)) {
    if (dist(g.nodes[goal], from) < opts.minDistance) break;
    const path = aStar(g, start, goal);
    if (path && path.length > 1 && path[1] !== opts.notVia) return path;
  }
  return null;
}

// ---------- Spreading things evenly over an area ----------
// The square [-half, half]² is split into grid × grid cells. Each cell lists the
// graph edges that pass through it, so things can be placed one per cell.

export interface EdgeRef {
  from: number;
  edge: Edge;
}

/** A point `f` of the way along an edge. */
export const pointOnEdge = (g: Graph, ref: EdgeRef, f: number): Vec => {
  const a = g.nodes[ref.from];
  const b = g.nodes[ref.edge.to];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
};

/** Cell index of a point, or -1 outside the grid. */
export function cellIndex(v: Vec, grid: number, half: number): number {
  const cx = Math.floor(((v.x + half) / (2 * half)) * grid);
  const cy = Math.floor(((v.y + half) / (2 * half)) * grid);
  if (cx < 0 || cy < 0 || cx >= grid || cy >= grid) return -1;
  return cy * grid + cx;
}

const cellEdgesCache = new WeakMap<Graph, Map<string, EdgeRef[][]>>();

/** For every grid cell, the edges that pass through it. Cached per graph and grid. */
export function cellEdges(g: Graph, grid: number, half: number): EdgeRef[][] {
  const key = `${grid}/${half}`;
  let byGrid = cellEdgesCache.get(g);
  if (!byGrid) cellEdgesCache.set(g, (byGrid = new Map()));
  const cached = byGrid.get(key);
  if (cached) return cached;

  const cells: EdgeRef[][] = Array.from({ length: grid * grid }, () => []);
  g.adj.forEach((edges, from) => {
    for (const edge of edges) {
      const seen = new Set<number>();
      const steps = Math.ceil(edge.len / 5) + 1; // sample every ~5 m
      for (let k = 0; k <= steps; k++) {
        const c = cellIndex(pointOnEdge(g, { from, edge }, k / steps), grid, half);
        if (c >= 0 && !seen.has(c)) {
          seen.add(c);
          cells[c].push({ from, edge });
        }
      }
    }
  });
  byGrid.set(key, cells);
  return cells;
}

/** A random point on an edge inside cell c: the edge and how far along it, or null if none. */
export function spotInCell(
  g: Graph,
  rnd: Rng,
  refs: EdgeRef[],
  c: number,
  grid: number,
  half: number,
): { ref: EdgeRef; f: number } | null {
  if (refs.length === 0) return null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const ref = refs[Math.floor(rnd() * refs.length)];
    const f = rnd();
    if (cellIndex(pointOnEdge(g, ref, f), grid, half) === c) return { ref, f };
  }
  return null;
}
