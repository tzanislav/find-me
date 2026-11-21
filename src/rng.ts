// Small seeded RNG so a round (spawns, routes, noise) can be reproduced from its seed.

export type Rng = () => number;

/** Seeds are whole numbers 0..MAX_SEED, so they fit a 32-bit int and are easy to type. */
export const MAX_SEED = 2 ** 31 - 1;

/** A fresh seed for a new round. The only place the game uses Math.random. */
export const randomSeed = () => Math.floor(Math.random() * (MAX_SEED + 1));

/** The seed typed in `text`, or null if it isn't a whole number in range. */
export function parseSeed(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_SEED ? n : null;
}

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

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(rnd: Rng, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
