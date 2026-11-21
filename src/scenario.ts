// Builds the routing graphs once, then generates each round: vehicles, pedestrians and the target.

import { HALF_SIZE_M, type Vec } from './geo';
import { buildGraph, cellEdges, pointOnEdge, randomRoute, routeFrom, spotInCell, type Graph } from './graph';
import type { OsmData } from './osm';
import { mulberry32, pick, randInt, range, shuffle, type Rng } from './rng';
import { PEDESTRIAN_STREET_TAG, generatePedestrians, type Pedestrian } from './pedestrians';
import { AIRPLANE_RANGE_M } from './sim';
import { CLIP_SECONDS, FIXED_SOURCES, PREHEAT_SECONDS, KINDS, makeSource, positionAt, type SoundSource, type SourceKind } from './sources';

export interface World {
  road: Graph; // directed, cars
  tram: Graph;
  walk: Graph; // undirected, all streets incl. pedestrian ones; edge tag = road class
}

export interface Round {
  seed: number;
  sources: SoundSource[];
  pedestrians: Pedestrian[];
  target: Pedestrian; // whose phone recorded the spectrogram
}

// Emergency vehicles prefer arterials: minor streets cost more per metre.
const ROAD_COST_BY_RANK = [1, 1.15, 1.6];
const NOT_DRIVABLE = new Set(['pedestrian']);

export function buildWorld(osm: OsmData): World {
  const road = buildGraph(
    osm.roads
      .filter((r) => !NOT_DRIVABLE.has(r.h))
      .map((r) => ({ p: r.p, oneway: r.o ?? 0, costFactor: ROAD_COST_BY_RANK[r.r] ?? 1.6 })),
  );
  // Trams ignore direction: tracks are often mapped as one way per direction anyway.
  const tram = buildGraph(osm.rails.filter((r) => r.t === 'tram').map((r) => ({ p: r.p })));
  const walk = buildGraph(osm.roads.map((r) => ({ p: r.p, tag: r.h === 'pedestrian' ? PEDESTRIAN_STREET_TAG : r.r })));
  return { road, tram, walk };
}

interface VehicleSpec {
  kind: SourceKind;
  network: 'road' | 'tram';
  concurrent: [number, number]; // min/max vehicles of this kind on the map at any moment
  speed: [number, number]; // m/s
  levelDb: number;
  spawn: 'area' | 'edge'; // anywhere around the play box, or only at the outer edge of the map data
  /**
   * 'even': the first vehicle of each slot is already on the network at t = 0,
   * spread evenly over the play box (one per grid cell, like pedestrians).
   * Later vehicles still come in by the `spawn` rule. Without it, first
   * departures are spread over the pre-heat instead.
   */
  firstSpread?: 'even';
}

// Tune the mix here.
const VEHICLES: VehicleSpec[] = [
  { kind: 'ambulance', network: 'road', concurrent: [3, 4], speed: [12, 17], levelDb: 120, spawn: 'area' },
  { kind: 'police', network: 'road', concurrent: [3, 5], speed: [11, 16], levelDb: 118, spawn: 'area' },
  { kind: 'tram', network: 'tram', concurrent: [8, 10], speed: [6, 9], levelDb: 102, spawn: 'edge', firstSpread: 'even' },
];

/** Grid for 'even' starts: 4 x 4 cells of 500 m over the play box. 12 of them contain tram track. */
const EVEN_GRID = 4;
/** Two evenly started vehicles are never closer than this, even across a cell border. */
const EVEN_MIN_SPACING_M = 200;

const SPAWN_MARGIN = 1.15; // spawn inside the play box plus a little margin
const MIN_TRIP_M = 900; // destinations closer than this are rejected
const RESPAWN_DELAY_S: [number, number] = [0, 15]; // pause before a slot sends out its next vehicle

// Map data reaches 1.35x the play box half-size (scripts/fetch-osm.mjs); the edge band is its outer rim.
const EDGE_BAND_START = HALF_SIZE_M * 1.2;

const SPAWN_RULES: Record<VehicleSpec['spawn'], (v: Vec) => boolean> = {
  area: (v) => Math.abs(v.x) <= HALF_SIZE_M * SPAWN_MARGIN && Math.abs(v.y) <= HALF_SIZE_M * SPAWN_MARGIN,
  edge: (v) => Math.max(Math.abs(v.x), Math.abs(v.y)) >= EDGE_BAND_START,
};

const ROUTE_ATTEMPTS = 10;

/** True if the source is inside the play box at some point during the clip. */
function visibleInPlayBox(src: SoundSource): boolean {
  for (let t = Math.max(0, src.start); t <= Math.min(CLIP_SECONDS, src.end); t += 1) {
    const p = positionAt(src, t);
    if (Math.abs(p.x) <= HALF_SIZE_M && Math.abs(p.y) <= HALF_SIZE_M) return true;
  }
  return false;
}

/** One trip starting at `start`. Prefers routes that pass through the play box during the clip. */
function planTrip(world: World, rnd: Rng, spec: VehicleSpec, start: number): SoundSource | null {
  const speed = range(rnd, spec.speed);
  let fallback: SoundSource | null = null;
  for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
    const path = randomRoute(world[spec.network], rnd, { spawnArea: SPAWN_RULES[spec.spawn], minDistance: MIN_TRIP_M });
    if (!path) continue;
    const src = makeSource(spec.kind, spec.kind, KINDS[spec.kind].label, path, { speed, start, levelDb: spec.levelDb });
    if (visibleInPlayBox(src)) return src;
    fallback ??= src;
  }
  return fallback;
}

/**
 * First trips for 'even' starts: `count` vehicles already on the network at
 * t = 0, one per grid cell that has track or road in it (cells in random order,
 * wrapping round if there are more vehicles than cells). Each starts at a random
 * point inside its cell, facing a random way, routed on to a far destination.
 */
function startEvenly(world: World, rnd: Rng, spec: VehicleSpec, count: number): SoundSource[] {
  const g = world[spec.network];
  const cells = cellEdges(g, EVEN_GRID, HALF_SIZE_M);
  const order = shuffle(
    rnd,
    cells.map((refs, c) => (refs.length > 0 ? c : -1)).filter((c) => c >= 0),
  );
  if (order.length === 0) return [];

  const trips: SoundSource[] = [];
  const placed: Vec[] = [];
  for (let k = 0; k < count; k++) {
    const c = order[k % order.length];
    for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
      const spot = spotInCell(g, rnd, cells[c], c, EVEN_GRID, HALF_SIZE_M);
      if (!spot) break;
      const p = pointOnEdge(g, spot.ref, spot.f);
      if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < EVEN_MIN_SPACING_M)) continue;
      // Face either way along the track, and don't turn straight back
      const forward = rnd() < 0.5;
      const ahead = forward ? spot.ref.edge.to : spot.ref.from;
      const behind = forward ? spot.ref.from : spot.ref.edge.to;
      const route = routeFrom(g, rnd, ahead, { minDistance: MIN_TRIP_M, notVia: behind });
      if (!route) continue;
      const path = [p, ...route.map((i) => g.nodes[i])];
      trips.push(makeSource(spec.kind, spec.kind, KINDS[spec.kind].label, path, { speed: range(rnd, spec.speed), start: 0, levelDb: spec.levelDb }));
      placed.push(p);
      break;
    }
  }
  return trips;
}

/**
 * Fleet model: each slot always has one vehicle out. When it arrives, the slot
 * sends a new one after a short pause. First departures are spread over the
 * pre-heat (negative clip time, never shown or heard), so at t = 0 vehicles are
 * already mid-route all over the map and the density stays flat for the clip.
 * With firstSpread 'even', the first vehicles are instead placed evenly at t = 0.
 */
function spawnFleet(world: World, rnd: Rng, spec: VehicleSpec): SoundSource[] {
  const out: SoundSource[] = [];
  const wanted = randInt(rnd, spec.concurrent);
  const firstTrips = spec.firstSpread === 'even' ? startEvenly(world, rnd, spec, wanted) : null;
  const slots = firstTrips ? firstTrips.length : wanted;
  for (let slot = 0; slot < slots; slot++) {
    let t = -range(rnd, [0, PREHEAT_SECONDS]);
    const first = firstTrips?.[slot];
    if (first) {
      out.push({ ...first, id: `${spec.kind}${out.length + 1}`, name: `${KINDS[spec.kind].label} ${out.length + 1}` });
      t = first.end + range(rnd, RESPAWN_DELAY_S);
    }
    while (t < CLIP_SECONDS) {
      const trip = planTrip(world, rnd, spec, t);
      if (!trip) break;
      if (trip.end >= 0) {
        const n = out.length + 1;
        out.push({ ...trip, id: `${spec.kind}${n}`, name: `${KINDS[spec.kind].label} ${n}` });
      }
      t = trip.end + range(rnd, RESPAWN_DELAY_S);
    }
  }
  return out;
}

/** The target must come at least this close to an ambulance or police car during the clip. */
const TARGET_SIREN_DISTANCE_M = 200;
const SIREN_KINDS = new Set<SourceKind>(['ambulance', 'police']);

/** True if the person is within `maxDist` of an active siren vehicle at some moment of the clip. */
function nearSiren(p: Pedestrian, sirens: SoundSource[], maxDist: number): boolean {
  for (let t = 0; t <= CLIP_SECONDS; t += 1) {
    const here = positionAt(p, t);
    for (const s of sirens) {
      if (t < s.start || t > s.end) continue;
      const v = positionAt(s, t);
      if (Math.hypot(v.x - here.x, v.y - here.y) <= maxDist) return true;
    }
  }
  return false;
}

// ---- Construction sites ----
const CONSTRUCTION_SITES: [number, number] = [2, 3]; // per round
const CONSTRUCTION_LEVEL_DB = 112;
const CONSTRUCTION_AREA = 0.85; // fraction of the play box half-size they can be placed in
const CONSTRUCTION_MIN_SPACING_M = 400; // keeps sites apart so each is its own clue
const CONSTRUCTION_SETBACK_M = 15; // off the street centre line, on the building side

/** 2-3 sites at random spots beside streets in the play box, kept well apart. Active all clip. */
function placeConstructionSites(world: World, rnd: Rng): SoundSource[] {
  const g = world.walk;
  const limit = HALF_SIZE_M * CONSTRUCTION_AREA;
  const nodes = g.nodes
    .map((_, i) => i)
    .filter((i) => g.adj[i].length > 0 && Math.abs(g.nodes[i].x) <= limit && Math.abs(g.nodes[i].y) <= limit);
  const want = randInt(rnd, CONSTRUCTION_SITES);
  const sites: Vec[] = [];
  for (let attempt = 0; attempt < 200 && sites.length < want; attempt++) {
    const i = pick(rnd, nodes);
    const edge = pick(rnd, g.adj[i]);
    const a = g.nodes[i];
    const b = g.nodes[edge.to];
    // A point partway along the street, set back to one side of it
    const f = rnd();
    const side = rnd() < 0.5 ? 1 : -1;
    const nx = ((b.y - a.y) / edge.len) * side;
    const ny = (-(b.x - a.x) / edge.len) * side;
    const p = { x: a.x + (b.x - a.x) * f + nx * CONSTRUCTION_SETBACK_M, y: a.y + (b.y - a.y) * f + ny * CONSTRUCTION_SETBACK_M };
    if (sites.every((s) => Math.hypot(s.x - p.x, s.y - p.y) >= CONSTRUCTION_MIN_SPACING_M)) sites.push(p);
  }
  return sites.map((p, k) =>
    makeSource(`construction${k + 1}`, 'construction', `Construction site ${k + 1}`, [p], {
      start: 0,
      end: CLIP_SECONDS,
      levelDb: CONSTRUCTION_LEVEL_DB,
    }),
  );
}

// ---- Airplane ----
const AIRPLANE_SPEED_MS = 75;
const AIRPLANE_ALTITUDE_M = 700;
const AIRPLANE_LEVEL_DB = 140;
/** It passes overhead at a random time this far from either end of the clip. */
const AIRPLANE_TIME_MARGIN_S = 60;
/** Its line runs this far either side of the pass point: past its hearing range, so it fades in and out. */
const AIRPLANE_HALF_PATH_M = AIRPLANE_RANGE_M + 500;

/**
 * One airliner per round: a straight line through a random point of the play
 * box, at a random heading, passing that point at a random time between the
 * first and last minute of the clip.
 */
function placeAirplane(rnd: Rng): SoundSource {
  const passTime = range(rnd, [AIRPLANE_TIME_MARGIN_S, CLIP_SECONDS - AIRPLANE_TIME_MARGIN_S]);
  const p = { x: range(rnd, [-HALF_SIZE_M, HALF_SIZE_M]), y: range(rnd, [-HALF_SIZE_M, HALF_SIZE_M]) };
  const heading = rnd() * 2 * Math.PI;
  const dx = Math.sin(heading) * AIRPLANE_HALF_PATH_M;
  const dy = Math.cos(heading) * AIRPLANE_HALF_PATH_M;
  return makeSource('air1', 'airplane', 'Airliner', [{ x: p.x - dx, y: p.y - dy }, { x: p.x + dx, y: p.y + dy }], {
    speed: AIRPLANE_SPEED_MS,
    start: passTime - AIRPLANE_HALF_PATH_M / AIRPLANE_SPEED_MS, // reaches p at passTime
    altitude: AIRPLANE_ALTITUDE_M,
    levelDb: AIRPLANE_LEVEL_DB,
  });
}

export function generateRound(world: World, seed: number): Round {
  const rnd = mulberry32(seed);
  const sources = [...FIXED_SOURCES, placeAirplane(rnd), ...placeConstructionSites(world, rnd)];
  for (const spec of VEHICLES) sources.push(...spawnFleet(world, rnd, spec));
  const pedestrians = generatePedestrians(world.walk, rnd);
  // Pick the target among people who pass near a siren, so the clip has a clue to place them.
  const sirens = sources.filter((s) => SIREN_KINDS.has(s.kind));
  const candidates = pedestrians.filter((p) => nearSiren(p, sirens, TARGET_SIREN_DISTANCE_M));
  return { seed, sources, pedestrians, target: pick(rnd, candidates.length > 0 ? candidates : pedestrians) };
}
