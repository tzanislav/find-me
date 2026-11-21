import { dist, toLocal, type Vec } from './geo';

export type SourceKind = 'ambulance' | 'police' | 'airplane' | 'bell' | 'construction' | 'tram';

/**
 * Placeholder presentation for each source type: neon outline icons in the
 * style of DEFCON. `svg` is the inner markup of a 28x28 viewBox, stroked in
 * the kind's colour.
 */
export const KINDS: Record<SourceKind, { label: string; color: string; svg: string }> = {
  ambulance: {
    label: 'Ambulance',
    color: '#ff3b5c',
    svg: '<rect x="3" y="7" width="22" height="14" rx="2"/><path d="M14 10v8M10 14h8"/>',
  },
  police: {
    label: 'Police car',
    color: '#2ee6ff',
    svg: '<path d="M14 3l9 4v6c0 6-4 10-9 12-5-2-9-6-9-12V7z"/><path d="M14 9l1.5 3.2 3.5.4-2.6 2.4.7 3.5-3.1-1.8-3.1 1.8.7-3.5-2.6-2.4 3.5-.4z"/>',
  },
  airplane: {
    label: 'Airplane',
    color: '#f2f6ff',
    svg: '<path d="M14 3l8 22-8-5-8 5z"/>',
  },
  bell: {
    label: 'Church bells',
    color: '#ffd23f',
    svg: '<path d="M8 20v-7a6 6 0 0 1 12 0v7l2 2H6z"/><path d="M12 25h4M14 4v3"/>',
  },
  construction: {
    label: 'Construction',
    color: '#ff8a1f',
    svg: '<path d="M14 4l11 20H3z"/><path d="M14 11v6M14 20v1"/>',
  },
  tram: {
    label: 'Tram',
    color: '#45ff9c',
    svg: '<rect x="7" y="8" width="14" height="14" rx="2"/><path d="M10 8l4-4 4 4M7 16h14M10 22l-2 3M18 22l2 3"/>',
  },
};

export function iconSvg(kind: SourceKind, size = 28): string {
  const k = KINDS[kind];
  return `<svg viewBox="0 0 28 28" width="${size}" height="${size}" fill="none" stroke="${k.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${k.svg}</svg>`;
}

/** Anything that moves along a polyline at constant speed: sound sources and pedestrians. */
export interface Track {
  path: Vec[]; // local metres; a single point means stationary
  cum: number[]; // cumulative distance at each path point
  length: number; // total path length in metres
  speed: number; // m/s along the path, 0 when stationary
  start: number; // clip time (s) it starts moving; negative means already under way when the clip starts
}

export interface SoundSource extends Track {
  id: string;
  kind: SourceKind;
  name: string;
  altitude: number; // metres above the listener
  end: number; // clip time (s) it stops emitting or reaches its destination
  levelDb: number; // sound level at 1 m
  /** Siren off: the vehicle drives its route (and shows on the map) but makes no sound. */
  silent?: boolean;
}

export const CLIP_SECONDS = 600; // playable clip
/** Simulated before the clip so traffic is already spread out at t = 0. Never shown or heard. */
export const PREHEAT_SECONDS = 90;

export function makeTrack(path: Vec[], speed = 0, start = 0): Track {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
  return { path, cum, length: cum[cum.length - 1], speed, start };
}

export function makeSource(
  id: string,
  kind: SourceKind,
  name: string,
  path: Vec[],
  opts: { speed?: number; start?: number; end?: number; altitude?: number; levelDb: number },
): SoundSource {
  const track = makeTrack(path, opts.speed ?? 0, opts.start ?? 0);
  let end = opts.end ?? CLIP_SECONDS;
  if (track.speed > 0) end = Math.min(end, track.start + track.length / track.speed); // despawns at its destination
  return { ...track, id, kind, name, end, altitude: opts.altitude ?? 0, levelDb: opts.levelDb };
}

/**
 * Kinds whose location is public knowledge: on the map from the start of the
 * round, no data to buy. Their icon never shows whether they are sounding, so
 * when they sound has to be read from the recording.
 */
export const PUBLIC_KINDS = new Set<SourceKind>(['bell']);

/** Churches with bells, hand-placed from a user-marked screenshot. Each rings once per round (scenario.ts). */
export const CHURCHES: { name: string; lat: number; lng: number }[] = [
  { name: 'Sveta Nedelya Cathedral', lat: 42.6968, lng: 23.32136 },
  { name: 'Alexander Nevsky Cathedral', lat: 42.6959, lng: 23.3328 },
  { name: 'Southwest Church', lat: 42.68979, lng: 23.31616 },
  { name: 'South Church', lat: 42.69004, lng: 23.3276 },
];

/** Length of public/audio/church-bell.mp3, which rings once from the bell's start time. */
export const BELL_RING_S = 41;
export const BELL_LEVEL_DB = 122;

/** A church's bell, ringing once from `start`. */
export function makeBell(k: number, start: number): SoundSource {
  const c = CHURCHES[k];
  return makeSource(`bell${k + 1}`, 'bell', c.name, [toLocal(c)], { start, end: start + BELL_RING_S, levelDb: BELL_LEVEL_DB });
}

export const isMoving = (src: Track) => src.speed > 0 && src.path.length > 1;

/** Where a source physically is at clip time t. */
export function positionAt(src: Track, t: number): Vec {
  if (!isMoving(src)) return src.path[0];
  const s = Math.min(Math.max(0, t - src.start) * src.speed, src.length);
  // Binary search for the path segment containing distance s
  let lo = 0;
  let hi = src.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (src.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = src.path[lo];
  const b = src.path[hi];
  const seg = src.cum[hi] - src.cum[lo];
  const k = seg === 0 ? 0 : (s - src.cum[lo]) / seg;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

export function isActive(src: SoundSource, t: number): boolean {
  return t >= src.start && t <= src.end;
}

/** Direction of travel in degrees clockwise from north. */
export function headingAt(src: Track, t: number): number {
  const a = positionAt(src, t - 0.5);
  const b = positionAt(src, t + 0.5);
  if (a.x === b.x && a.y === b.y) return 0;
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
}
