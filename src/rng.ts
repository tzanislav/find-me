// Small seeded RNG so a round (spawns, routes, noise) can be reproduced from its seed.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rnd: Rng, [lo, hi]: [number, number]) => lo + (hi - lo) * rnd();
export const randInt = (rnd: Rng, [lo, hi]: [number, number]) => lo + Math.floor((hi - lo + 1) * rnd());
export const pick = <T>(rnd: Rng, arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
