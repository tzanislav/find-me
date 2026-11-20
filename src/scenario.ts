// Builds the routing graphs once, then generates each round: vehicles, pedestrians and the target.

import { HALF_SIZE_M, type Vec } from './geo';
import { buildGraph, randomRoute, type Graph } from './graph';
import type { OsmData } from './osm';
import { mulberry32, pick, randInt, range, type Rng } from './rng';
import { PEDESTRIAN_STREET_TAG, generatePedestrians, type Pedestrian } from './pedestrians';
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
}

// Tune the mix here.
const VEHICLES: VehicleSpec[] = [
  { kind: 'ambulance', network: 'road', concurrent: [3, 4], speed: [12, 17], levelDb: 120, spawn: 'area' },
  { kind: 'police', network: 'road', concurrent: [3, 5], speed: [11, 16], levelDb: 118, spawn: 'area' },
  { kind: 'tram', network: 'tram', concurrent: [8, 10], speed: [6, 9], levelDb: 102, spawn: 'edge' },
];

const PEDESTRIAN_COUNT = 200;
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
 * Fleet model: each slot always has one vehicle out. When it arrives, the slot
 * sends a new one after a short pause. First departures are spread over the
 * pre-heat (negative clip time, never shown or heard), so at t = 0 vehicles are
 * already mid-route all over the map and the density stays flat for the clip.
 */
function spawnFleet(world: World, rnd: Rng, spec: VehicleSpec): SoundSource[] {
  const out: SoundSource[] = [];
  const slots = randInt(rnd, spec.concurrent);
  for (let slot = 0; slot < slots; slot++) {
    let t = -range(rnd, [0, PREHEAT_SECONDS]);
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

export function generateRound(world: World, seed: number): Round {
  const rnd = mulberry32(seed);
  const sources = [...FIXED_SOURCES];
  for (const spec of VEHICLES) sources.push(...spawnFleet(world, rnd, spec));
  const pedestrians = generatePedestrians(world.walk, rnd, PEDESTRIAN_COUNT);
  return { seed, sources, pedestrians, target: pick(rnd, pedestrians) };
}
