// Pedestrians: white dots that wander the sidewalks.
// Movement is a random walk on the street graph, offset to one side of the
// centre line. Each step becomes an offset segment; consecutive segments are
// joined by straight interpolation, so corners get cut and street crossings
// or U-turns become a short straight glide across the road. Not realistic,
// just believable.

import { HALF_SIZE_M, type Vec } from './geo';
import { cellEdges, spotInCell, type Edge, type Graph } from './graph';
import { randomProfile, type Profile } from './people';
import { pick, range, type Rng } from './rng';
import { CLIP_SECONDS, makeTrack, type Track } from './sources';

export interface Pedestrian extends Track {
  id: string;
  profile: Profile;
}

/** Walk-graph edge tags: 0 major, 1 secondary, 2 minor road, 3 pedestrian street. */
export const PEDESTRIAN_STREET_TAG = 3;
const SIDEWALK_OFFSET_M = [11, 8, 5.5, 2.5];

const WALK_SPEED: [number, number] = [0.9, 1.6]; // m/s
const STANDING_SHARE = 0.15; // waiting at a bus stop, sitting in a cafe, ...
const U_TURN_CHANCE = 0.02; // per graph node passed
const CROSS_CHANCE = 0.04; // per graph node passed: switch to the other sidewalk
/** The play box is split into this many cells per side for spawning (100 m cells). */
const SPAWN_GRID = 20;
/** Chance that a cell gets a person. 400 cells x 0.65 = ~260 people. */
const SPAWN_CHANCE = 0.65;

function offsetSegment(a: Vec, b: Vec, len: number, off: number): [Vec, Vec] {
  // Right-hand normal of a->b (x east, y north)
  const nx = (b.y - a.y) / len;
  const ny = -(b.x - a.x) / len;
  return [
    { x: a.x + nx * off, y: a.y + ny * off },
    { x: b.x + nx * off, y: b.y + ny * off },
  ];
}

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.3) out.push(p);
  }
  return out;
}

/**
 * Random walk along the sidewalks, starting a fraction `f` of the way along
 * the edge `first` from node `from`.
 */
function sidewalkWalk(g: Graph, rnd: Rng, from: number, first: Edge, f: number, minLength: number): Vec[] {
  let side = rnd() < 0.5 ? 1 : -1;
  const lateral = range(rnd, [-1.5, 1.5]); // so people don't all walk on one line
  const pts: Vec[] = [];
  let prev = from;
  let cur = first.to;
  let walked = first.len * (1 - f);
  {
    const [a, b] = offsetSegment(g.nodes[from], g.nodes[first.to], first.len, side * (SIDEWALK_OFFSET_M[first.tag] ?? 5) + lateral);
    pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, b);
  }

  while (walked < minLength && pts.length < 4000) {
    const edges = g.adj[cur];
    if (edges.length === 0) break;
    const forward = edges.filter((e) => e.to !== prev);
    const turnBack = rnd() < U_TURN_CHANCE;
    const edge = forward.length === 0 || turnBack ? (edges.find((e) => e.to === prev) ?? edges[0]) : pick(rnd, forward);
    if (rnd() < CROSS_CHANCE) side = -side;

    const off = side * (SIDEWALK_OFFSET_M[edge.tag] ?? 5) + lateral;
    pts.push(...offsetSegment(g.nodes[cur], g.nodes[edge.to], edge.len, off));
    walked += edge.len;
    prev = cur;
    cur = edge.to;
  }
  return dedupe(pts);
}

/**
 * Spreads people evenly: the play box is split into a SPAWN_GRID x SPAWN_GRID
 * grid, and each cell gets one person with SPAWN_CHANCE, at a random point on
 * a street inside it. Cells with no streets stay empty.
 */
export function generatePedestrians(walk: Graph, rnd: Rng): Pedestrian[] {
  const cells = cellEdges(walk, SPAWN_GRID, HALF_SIZE_M);
  const people: Pedestrian[] = [];

  cells.forEach((refs, c) => {
    if (rnd() >= SPAWN_CHANCE) return;
    const spot = spotInCell(walk, rnd, refs, c, SPAWN_GRID, HALF_SIZE_M);
    if (!spot) return;
    const { ref, f } = spot;
    const profile = randomProfile(rnd);
    let track: Track;

    if (rnd() < STANDING_SHARE) {
      const off = (rnd() < 0.5 ? 1 : -1) * (SIDEWALK_OFFSET_M[ref.edge.tag] ?? 5);
      const [a, b] = offsetSegment(walk.nodes[ref.from], walk.nodes[ref.edge.to], ref.edge.len, off);
      track = makeTrack([{ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }]);
    } else {
      const speed = range(rnd, WALK_SPEED);
      const path = sidewalkWalk(walk, rnd, ref.from, ref.edge, f, speed * CLIP_SECONDS + 10);
      track = makeTrack(path, path.length > 1 ? speed : 0);
    }
    people.push({ ...track, id: `p${people.length + 1}`, profile });
  });
  return people;
}
