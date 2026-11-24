// Shapes the tutorial's round so its lesson reads clearly. The round is dealt
// like any other (with the player's settings), then read: the target's two
// closest tram passes are found, and everyone around those trams at those
// moments is taken off the map except the hand-picked candidates the player
// is asked to mark (one of them the target). The tutorial then points at the
// candidates when the playhead is at a pass (tutorial.ts).

import { dist } from './geo';
import type { Pedestrian } from './pedestrians';
import type { Round } from './scenario';
import { hearingRangeM } from './sim';
import { CLIP_SECONDS, positionAt, type SoundSource, type Track } from './sources';

export interface TutorialPlan {
  /** Clip times (s) when a tram comes closest to the target, in order. */
  pass1: number;
  pass2: number;
  targetId: string;
  /** The candidates to mark at the first pass that are in the round, the target among them. */
  candidates: string[];
  /** The candidates to unmark at the second pass: all but the target. */
  decoys: string[];
  /** The church bell the target hears best, if any. */
  bell: { name: string; start: number; end: number } | null;
}

/** A tram this close to the target counts as a pass. */
const PASS_M = 15;
/** Closest moments less than this apart are one pass (two trams back to back, or a wobble). */
const MERGE_S = 15;
/** Around each pass, nobody but the target and the candidates stays within this distance of a tram near the target. */
const CLEAR_RADIUS_M = 50;
/** Trams this close to the target around a pass have their surroundings cleared. */
const NEARBY_TRAM_M = 150;
/** How long before and after a pass the clearing looks, and the tutorial rings people, s. */
export const PASS_WINDOW_S = 6;
const STEP_S = 0.5;

/** Closest `a` comes to `b` between t0 and t1. */
function closest(a: Track, b: SoundSource, t0: number, t1: number): number {
  let best = Infinity;
  for (let t = Math.max(t0, b.start, 0); t <= Math.min(t1, b.end, CLIP_SECONDS); t += STEP_S) {
    best = Math.min(best, dist(positionAt(a, t), positionAt(b, t)));
  }
  return best;
}

/** The target's tram passes: each the moment of closest approach, with the tram. */
function tramPasses(target: Track, trams: SoundSource[]): { t: number; d: number; tram: SoundSource }[] {
  const passes: { t: number; d: number; tram: SoundSource }[] = [];
  let cur: (typeof passes)[number] | null = null;
  for (let t = 0; t <= CLIP_SECONDS; t += STEP_S) {
    const here = positionAt(target, t);
    let near: (typeof passes)[number] | null = null;
    for (const tram of trams) {
      if (t < tram.start || t > tram.end) continue;
      const d = dist(here, positionAt(tram, t));
      if (d <= PASS_M && (!near || d < near.d)) near = { t, d, tram };
    }
    if (near) {
      if (!cur || near.d < cur.d) cur = near;
    } else if (cur) {
      passes.push(cur);
      cur = null;
    }
  }
  if (cur) passes.push(cur);
  const merged: typeof passes = [];
  for (const p of passes) {
    const last = merged[merged.length - 1];
    if (last && p.t - last.t < MERGE_S) {
      if (p.d < last.d) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  return merged;
}

/**
 * Finds the tutorial's moments in `round` and clears the crowd around them
 * (changes round.pedestrians), keeping the target and the people in
 * `candidates`. The people in `removed` are taken off the map in any case. Null when the target has fewer than two tram passes, which
 * leaves the round as dealt.
 */
export function prepareTutorialRound(round: Round, candidates: readonly string[], removed: readonly string[] = []): TutorialPlan | null {
  const { target } = round;
  round.pedestrians = round.pedestrians.filter((p) => p === target || !removed.includes(p.id));
  const trams = round.sources.filter((s) => s.kind === 'tram');
  const passes = tramPasses(target, trams);
  if (passes.length < 2) {
    console.warn(`Tutorial: the target has ${passes.length} tram passes, the script needs two`);
    return null;
  }
  const [p1, p2] = passes;
  const window = (t: number, w: number) => [t - w, t + w] as const;
  const keep = new Set<Pedestrian>([target, ...round.pedestrians.filter((p) => candidates.includes(p.id))]);
  const missing = candidates.filter((id) => !round.pedestrians.some((p) => p.id === id));
  if (missing.length) console.warn(`Tutorial: candidates not in this round (other settings?): ${missing.join(', ')}`);
  if (!candidates.includes(target.id)) console.warn(`Tutorial: the target ${target.id} is not among the candidates`);

  // Everyone else is cleared from around the trams near the target at either pass
  const nearby = [p1, p2].map((pass) => ({
    t: pass.t,
    trams: trams.filter((tram) => closest(target, tram, ...window(pass.t, PASS_WINDOW_S)) <= NEARBY_TRAM_M),
  }));
  round.pedestrians = round.pedestrians.filter(
    (p) =>
      keep.has(p) ||
      nearby.every(({ t, trams }) => trams.every((tram) => closest(p, tram, ...window(t, PASS_WINDOW_S)) > CLEAR_RADIUS_M)),
  );

  // The bell the target hears best: closest approach while it rings
  let bell: TutorialPlan['bell'] = null;
  let bellD = hearingRangeM();
  for (const s of round.sources) {
    if (s.kind !== 'bell') continue;
    const d = closest(target, s, s.start, s.end);
    if (d < bellD) {
      bellD = d;
      bell = { name: s.name, start: Math.max(0, s.start), end: Math.min(CLIP_SECONDS, s.end) };
    }
  }

  const ids = [...keep].map((p) => p.id);
  const plan = { pass1: p1.t, pass2: p2.t, targetId: target.id, candidates: ids, decoys: ids.filter((id) => id !== target.id), bell };
  console.info('Tutorial plan', plan);
  return plan;
}
