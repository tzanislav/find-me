// Pedestrians: white dots that wander the sidewalks.
// Movement is a random walk on the street graph, offset to one side of the
// centre line. Each step becomes an offset segment; consecutive segments are
// joined by straight interpolation, so corners get cut and street crossings
// or U-turns become a short straight glide across the road. Not realistic,
// just believable.

import { HALF_SIZE_M, type Vec } from './geo';
import type { Graph } from './graph';
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
const SPAWN_AREA = 0.95; // fraction of the play box half-size

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

function sidewalkWalk(g: Graph, rnd: Rng, start: number, minLength: number): Vec[] {
  let side = rnd() < 0.5 ? 1 : -1;
  const lateral = range(rnd, [-1.5, 1.5]); // so people don't all walk on one line
  const pts: Vec[] = [];
  let prev = -1;
  let cur = start;
  let walked = 0;

  while (walked < minLength && pts.length < 4000) {
    const edges = g.adj[cur];
    if (edges.length === 0) break;
    const forward = edges.filter((e) => e.to !== prev);
    const turnBack = prev >= 0 && rnd() < U_TURN_CHANCE;
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

export function generatePedestrians(walk: Graph, rnd: Rng, count: number): Pedestrian[] {
  const limit = HALF_SIZE_M * SPAWN_AREA;
  const startable = walk.nodes
    .map((_, i) => i)
    .filter((i) => walk.adj[i].length > 0 && Math.abs(walk.nodes[i].x) <= limit && Math.abs(walk.nodes[i].y) <= limit);

  const people: Pedestrian[] = [];
  for (let i = 0; i < count; i++) {
    const node = pick(rnd, startable);
    const profile = randomProfile(rnd);
    let track: Track;

    if (rnd() < STANDING_SHARE) {
      const edge = pick(rnd, walk.adj[node]);
      const off = (rnd() < 0.5 ? 1 : -1) * (SIDEWALK_OFFSET_M[edge.tag] ?? 5);
      const [p] = offsetSegment(walk.nodes[node], walk.nodes[edge.to], edge.len, off);
      track = makeTrack([p]);
    } else {
      const speed = range(rnd, WALK_SPEED);
      const path = sidewalkWalk(walk, rnd, node, speed * CLIP_SECONDS + 10);
      track = makeTrack(path, path.length > 1 ? speed : 0);
    }
    people.push({ ...track, id: `p${i + 1}`, profile });
  }
  return people;
}
