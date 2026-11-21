// Phone cell towers. Positions are fixed (hand-placed on the map); IDs and
// call counts are rolled per round. A tower sees every phone within its range,
// so it knows who is around it without knowing exactly where they are. Ranges
// overlap, so one phone can be seen by several towers at once.

import { dist, toLocal, type Vec } from './geo';
import { randInt, type Rng } from './rng';

export interface Tower {
  id: string;
  pos: Vec;
  callsToday: number;
}

/** Coverage radius: a tower sees (and can reveal) every phone within this distance. */
export const TOWER_RANGE_M = 400;
export const TOWER_COLOR = '#d16bff';

/** [lat, lng], placed by hand over central Sofia. Spread evenly, at least ~320 m apart, so ranges overlap. */
const SITES: [number, number][] = [
  [42.70184, 23.31501],
  [42.70166, 23.31943],
  [42.70162, 23.3244],
  [42.70265, 23.32833],
  [42.69928, 23.317],
  [42.69918, 23.33084],
  [42.69708, 23.31961],
  [42.69778, 23.32499],
  [42.6959, 23.33423],
  [42.69552, 23.31547],
  [42.69284, 23.32183],
  [42.69271, 23.32596],
  [42.69258, 23.33091],
  [42.69258, 23.31603],
];

const CALLS_TODAY: [number, number] = [600, 7400];
const HEX = '0123456789ABCDEF';

export function generateTowers(rnd: Rng): Tower[] {
  const used = new Set<string>();
  return SITES.map(([lat, lng]) => {
    let id: string;
    do id = `BTS-${Array.from({ length: 4 }, () => HEX[Math.floor(rnd() * 16)]).join('')}`;
    while (used.has(id));
    used.add(id);
    return { id, pos: toLocal({ lat, lng }), callsToday: randInt(rnd, CALLS_TODAY) };
  });
}

/** Whether `p` is within range of tower `t`. */
export function inRange(t: Tower, p: Vec): boolean {
  return dist(t.pos, p) <= TOWER_RANGE_M;
}

/** Lattice mast with radio waves, in the 28x28 outline style of the source icons. */
export function towerIconSvg(size = 28): string {
  return `<svg viewBox="0 0 28 28" width="${size}" height="${size}" fill="none" stroke="${TOWER_COLOR}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M14 11L9 25M14 11l5 14M11.3 19h5.4M10.2 22l6.8-3"/><circle cx="14" cy="9" r="1.6"/><path d="M9.8 5a6 6 0 0 0 0 8M18.2 5a6 6 0 0 1 0 8M6.8 2.5a10 10 0 0 0 0 13M21.2 2.5a10 10 0 0 1 0 13"/></svg>`;
}
