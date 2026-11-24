// Searches for a seed that fits the tutorial's script (src/tutorial.ts), with
// the default settings:
//   - a tram passes within a few metres of the target while a sounding
//     ambulance is in the middle distance,
//   - a second close tram pass a few minutes later,
//   - the target is the only person close to a tram at both passes,
//   - the target hears a church bell ring, away from the tram passes,
//   - the target comes within range of a cell tower at some point.
//
// Rerun it whenever round generation changes, since that shifts every seed.
//
//   npx rolldown scripts/find-tutorial-seed.ts --platform node -f esm -o <tmp>/find.mjs
//   node <tmp>/find.mjs [firstSeed] [count]     (from the project root)

import { readFileSync } from 'node:fs';
import { dist, insideBox, type Vec } from '../src/geo';
import type { OsmData } from '../src/osm';
import { buildWorld, generateRound } from '../src/scenario';
import { hearingRangeM } from '../src/sim';
import { BELL_RING_S, CHURCHES, CLIP_SECONDS, positionAt, type SoundSource, type Track } from '../src/sources';
import { inRange } from '../src/towers';

/** The target counts as passed by a tram this close. */
const PASS_M = 10;
/** Any tram this close to the target is a loud pass; only the two passes may come this close. */
const EVENT_M = 15;
/** Decoys: people this close to a tram around a pass. Generous, so a near miss still counts against uniqueness. */
const DECOY_M = 15;
/** Window around each pass in which decoys are looked for, s. */
const DECOY_WINDOW_S = 3;
/** Ambulance in the middle distance at the first pass: clearly heard, clearly not close. */
const AMBULANCE_M: [number, number] = [50, 270];
/** No sounding ambulance comes closer than this within AMBULANCE_CLEAR_S of the first pass. */
const AMBULANCE_MIN_M = 50;
const AMBULANCE_CLEAR_S = 15;
/** Seconds of the clip the target must spend in range of a tower. */
const MIN_TOWER_S = 30;
/** The bell must come at least this close while it rings, so it is plainly heard. */
const BELL_M = 250;
/** Tram passes and the bell ring stay this far apart, s. */
const CLEAR_S = 20;
const STEP_S = 0.5;

const osm = JSON.parse(readFileSync('public/data/sofia-center.json', 'utf8')) as OsmData;
const world = buildWorld(osm);

function minDist(a: Track, b: SoundSource, t0: number, t1: number): { d: number; t: number } {
  let best = { d: Infinity, t: t0 };
  for (let t = Math.max(t0, b.start); t <= Math.min(t1, b.end); t += STEP_S) {
    const d = dist(positionAt(a, t), positionAt(b, t));
    if (d < best.d) best = { d, t };
  }
  return best;
}

/** Closest any tram gets to `p` at each time step. */
function tramProfile(p: Track, trams: SoundSource[]): { t: number; d: number }[] {
  const out: { t: number; d: number }[] = [];
  for (let t = 0; t <= CLIP_SECONDS; t += STEP_S) {
    const here = positionAt(p, t);
    let d = Infinity;
    for (const s of trams) if (t >= s.start && t <= s.end) d = Math.min(d, dist(here, positionAt(s, t)));
    out.push({ t, d });
  }
  return out;
}

/** Stretches where a tram is within EVENT_M, each with its closest moment. */
function tramEvents(profile: { t: number; d: number }[]): { t: number; d: number }[] {
  const events: { t: number; d: number }[] = [];
  let cur: { t: number; d: number } | null = null;
  for (const s of profile) {
    if (s.d <= EVENT_M) {
      if (!cur || s.d < cur.d) cur = { ...s };
    } else if (cur) {
      events.push(cur);
      cur = null;
    }
  }
  if (cur) events.push(cur);
  // Merge events that are only a few seconds apart: one pass, two trams or a wobble
  const merged: { t: number; d: number }[] = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (last && e.t - last.t < 15) {
      if (e.d < last.d) merged[merged.length - 1] = e;
    } else merged.push(e);
  }
  return merged;
}

const nearTram = (p: Track, trams: SoundSource[], t: number) => {
  for (let u = t - DECOY_WINDOW_S; u <= t + DECOY_WINDOW_S; u += STEP_S) {
    const here = positionAt(p, u);
    for (const s of trams) if (u >= s.start && u <= s.end && dist(here, positionAt(s, u)) <= DECOY_M) return true;
  }
  return false;
};

/** How many seeds each check turned away, by check number, to see which one is too strict. */
const rejected: Record<number, number> = {};
const hist: Record<number, number> = {};
const reject = (n: number) => ((rejected[n] = (rejected[n] ?? 0) + 1), null);

function check(seed: number) {
  const round = generateRound(world, seed);
  const { target, sources, pedestrians, towers } = round;
  const trams = sources.filter((s) => s.kind === 'tram');

  const events = tramEvents(tramProfile(target, trams));
  hist[events.length] = (hist[events.length] ?? 0) + 1;
  if (events.length !== 2) return reject(1);
  const [p1, p2] = events;
  if (p1.d > PASS_M || p2.d > PASS_M) return reject(2);
  if (p1.t < 45 || p1.t > 360 || p2.t < p1.t + 120 || p2.t > CLIP_SECONDS - 20) return reject(3);
  // On the map at both passes, not out past its edge
  if (!insideBox(positionAt(target, p1.t)) || !insideBox(positionAt(target, p2.t))) return reject(4);

  // A sounding ambulance in the middle distance around the first pass, and no police car close by
  const amb = sources
    .filter((s) => s.kind === 'ambulance' && !s.silent)
    .map((s) => ({ s, d: minDist(target, s, p1.t - 10, p1.t + 10).d }))
    .sort((a, b) => a.d - b.d)[0];
  if (!amb || amb.d < AMBULANCE_M[0] || amb.d > AMBULANCE_M[1]) return reject(5);
  // ...and it stays there: no siren vehicle drives right up to the target around the pass
  const sirenClose = sources.some(
    (s) => s.kind === 'ambulance' && !s.silent && minDist(target, s, p1.t - AMBULANCE_CLEAR_S, p1.t + AMBULANCE_CLEAR_S).d < AMBULANCE_MIN_M,
  );
  if (sirenClose) return reject(6);
  const policeNear = sources.some(
    (s) => s.kind === 'police' && !s.silent && minDist(target, s, p1.t - 15, p1.t + 15).d < hearingRangeM(),
  );
  if (policeNear) return reject(7);

  // Bells heard plainly, away from the tram passes
  const bells = sources
    .filter((s) => s.kind === 'bell')
    .map((s) => ({ s, ...minDist(target, s, s.start, s.end) }))
    .filter((b) => b.d <= BELL_M)
    .filter((b) => [p1.t, p2.t].every((t) => t < b.s.start - CLEAR_S || t > b.s.end + CLEAR_S));
  if (bells.length === 0) return reject(8);
  const bell = bells.sort((a, b) => a.d - b.d)[0];

  // Only the target is near a tram at both passes
  const at1 = pedestrians.filter((p) => nearTram(p, trams, p1.t));
  const at2 = new Set(pedestrians.filter((p) => nearTram(p, trams, p2.t)));
  const both = at1.filter((p) => at2.has(p));
  if (both.length !== 1 || both[0] !== target) return reject(9);
  if (at1.length < 3) return reject(10); // the first pass should leave a few people to choose from

  // In range of a tower for a while, so the player can find the moment
  const towerTimes: number[] = [];
  for (let t = 0; t <= CLIP_SECONDS; t += 1) {
    if (towers.some((tw) => inRange(tw, positionAt(target, t)))) towerTimes.push(t);
  }
  if (towerTimes.length < MIN_TOWER_S) return reject(11);

  const church = CHURCHES.find((c) => c.name === bell.s.name);
  const startPos: Vec = positionAt(target, 0);
  return {
    seed,
    pass1: `${fmt(p1.t)} (${p1.d.toFixed(1)} m)`,
    pass2: `${fmt(p2.t)} (${p2.d.toFixed(1)} m)`,
    ambulance: `${amb.s.name} at ${amb.d.toFixed(0)} m`,
    bell: `${church?.name} ${fmt(bell.s.start)}-${fmt(bell.s.start + BELL_RING_S)}, closest ${bell.d.toFixed(0)} m`,
    decoys: `${at1.length} near pass 1, ${at2.size} near pass 2`,
    tower: `${towerTimes.length} s in range, ${fmt(towerTimes[0])}-${fmt(towerTimes[towerTimes.length - 1])}`,
    target: `${target.id} ${target.profile.sex} ${target.profile.age} ${target.profile.occupation}, clues: ${round.clues.join('+')}`,
    start: `(${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)}) m from centre`,
  };
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const first = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 2000);
let found = 0;
const t0 = Date.now();
for (let seed = first; seed < first + count; seed++) {
  const hit = check(seed);
  if (hit) {
    found++;
    console.log(JSON.stringify(hit, null, 1));
  }
}
console.error('rejected by check:', JSON.stringify(rejected));
console.error("tram passes per target:", JSON.stringify(hist));
console.error(`${found} of ${count} seeds fit, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
