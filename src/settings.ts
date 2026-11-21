// Player settings: sound levels, sound propagation and spawn counts.
// Kept in localStorage, so they survive reloads. Code reads `settings` at the
// moment it needs a value, so a change applies from the next round on (music
// and interface volumes apply at once, see onSettingsChange).

/** Sounds with their own volume slider. The first eight are mixed into the recorded clip. */
export const VOLUME_KEYS = [
  'ambulance',
  'police',
  'tram',
  'airplane',
  'construction',
  'bell',
  'traffic',
  'city',
  'music',
  'ui',
] as const;
export type VolumeKey = (typeof VOLUME_KEYS)[number];

/** A [min, max] count; each round picks a number in between. */
export type CountRange = [number, number];

/**
 * Siren vehicles: always `total` on the map; each round picks between
 * `minActive` and `maxActive` of them to have their siren on.
 * Always minActive <= maxActive <= total.
 */
export interface SirenFleet {
  total: number;
  minActive: number;
  maxActive: number;
}

export interface Settings {
  /** 0..100 % of the normal level. */
  volume: Record<VolumeKey, number>;
  propagation: {
    /** How far a pedestrian can hear ground sources, m. */
    hearingRangeM: number;
    /** How far a pedestrian can hear airplanes, m. */
    airplaneRangeM: number;
    /** Level drop per doubling of distance, dB. 6 = inverse square law. */
    falloffDb: number;
    /** High-frequency loss in the spectrogram, dB per kHz per km. */
    airAbsorption: number;
    /** Doppler shift multiplier, 1 = realistic. */
    doppler: number;
    /** Distance at which the audio's low-pass has dropped to half its close-up cutoff, m. */
    muffleM: number;
    /** Reverb starts this far away, m. */
    reverbStartM: number;
    /** Reverb is fully mixed in this far away, m. */
    reverbFullM: number;
    /** Reverb send when fully mixed in, %. */
    reverbPct: number;
    /** How much the direct sound drops when the reverb is fully in, %. */
    reverbDuckPct: number;
  };
  spawn: {
    pedestrians: number;
    ambulance: SirenFleet;
    police: SirenFleet;
    airplane: CountRange;
    construction: CountRange;
  };
}

export const DEFAULTS: Settings = {
  volume: Object.fromEntries(VOLUME_KEYS.map((k) => [k, 100])) as Record<VolumeKey, number>,
  propagation: {
    hearingRangeM: 300,
    airplaneRangeM: 3000,
    falloffDb: 6,
    airAbsorption: 4,
    doppler: 2,
    muffleM: 30,
    reverbStartM: 80,
    reverbFullM: 250,
    reverbPct: 90,
    reverbDuckPct: 50,
  },
  spawn: {
    pedestrians: 500,
    ambulance: { total: 5, minActive: 2, maxActive: 4 },
    police: { total: 6, minActive: 2, maxActive: 5 },
    airplane: [2, 3],
    construction: [2, 3],
  },
};

/** Slider limits, shared by the settings window and the loader (which clamps stored values to them). */
export interface Limits {
  min: number;
  max: number;
  step: number;
}
export const PROPAGATION_LIMITS: Record<keyof Settings['propagation'], Limits> = {
  hearingRangeM: { min: 50, max: 1000, step: 10 },
  airplaneRangeM: { min: 1000, max: 6000, step: 100 },
  falloffDb: { min: 0, max: 12, step: 0.5 },
  airAbsorption: { min: 0, max: 20, step: 0.5 },
  doppler: { min: 1, max: 5, step: 0.1 },
  muffleM: { min: 5, max: 200, step: 5 },
  reverbStartM: { min: 0, max: 500, step: 10 },
  reverbFullM: { min: 10, max: 1000, step: 10 },
  reverbPct: { min: 0, max: 150, step: 5 },
  reverbDuckPct: { min: 0, max: 100, step: 5 },
};
export const VOLUME_LIMITS: Limits = { min: 0, max: 100, step: 1 };
/**
 * Count limits. Airplanes stop at 5: passes are kept 100 s apart inside the
 * clip's middle 8 minutes, so more would not fit. Construction sites are kept
 * 400 m apart, so only so many fit in the play box.
 */
export const SPAWN_LIMITS: Record<keyof Settings['spawn'], Limits> = {
  pedestrians: { min: 50, max: 1500, step: 50 },
  ambulance: { min: 0, max: 10, step: 1 },
  police: { min: 0, max: 10, step: 1 },
  airplane: { min: 0, max: 5, step: 1 },
  construction: { min: 0, max: 8, step: 1 },
};

const STORAGE_KEY = 'for-your-safety.settings.v1';

const clamp = (v: unknown, l: Limits, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, v)) : fallback;

function clampRange(v: unknown, l: Limits, fallback: CountRange): CountRange {
  if (!Array.isArray(v)) return [...fallback];
  const lo = Math.round(clamp(v[0], l, fallback[0]));
  const hi = Math.round(clamp(v[1], l, fallback[1]));
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/**
 * Older saves stored a [min, max] range here, or no maxActive; missing or bad
 * fields fall back to the default. Then squeezed so minActive <= maxActive <= total.
 */
function clampFleet(v: unknown, l: Limits, fallback: SirenFleet): SirenFleet {
  const f = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Partial<Record<keyof SirenFleet, unknown>>;
  const total = Math.round(clamp(f.total, l, fallback.total));
  const maxActive = Math.min(total, Math.round(clamp(f.maxActive, l, fallback.maxActive)));
  const minActive = Math.min(maxActive, Math.round(clamp(f.minActive, l, fallback.minActive)));
  return { total, minActive, maxActive };
}

/** Defaults overlaid with whatever valid values `raw` has; unknown or bad entries are dropped. */
function sanitize(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, Record<string, unknown>>>;
  const out = structuredClone(DEFAULTS);
  for (const k of VOLUME_KEYS) out.volume[k] = clamp(r.volume?.[k], VOLUME_LIMITS, DEFAULTS.volume[k]);
  for (const k of Object.keys(PROPAGATION_LIMITS) as (keyof Settings['propagation'])[]) {
    out.propagation[k] = clamp(r.propagation?.[k], PROPAGATION_LIMITS[k], DEFAULTS.propagation[k]);
  }
  out.spawn.pedestrians = Math.round(clamp(r.spawn?.pedestrians, SPAWN_LIMITS.pedestrians, DEFAULTS.spawn.pedestrians));
  for (const k of ['ambulance', 'police'] as const) {
    out.spawn[k] = clampFleet(r.spawn?.[k], SPAWN_LIMITS[k], DEFAULTS.spawn[k]);
  }
  for (const k of ['airplane', 'construction'] as const) {
    out.spawn[k] = clampRange(r.spawn?.[k], SPAWN_LIMITS[k], DEFAULTS.spawn[k]);
  }
  return out;
}

function load(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return sanitize(stored ? JSON.parse(stored) : null);
  } catch (err) {
    console.error('Settings failed to load, using defaults', err);
    return structuredClone(DEFAULTS);
  }
}

/** The live settings. Read from it; change it only through updateSettings / resetSettings. */
export const settings: Settings = load();

const listeners = new Set<() => void>();

/** Calls `fn` after every change, e.g. to apply a volume right away. */
export function onSettingsChange(fn: () => void) {
  listeners.add(fn);
}

function commit() {
  Object.assign(settings, sanitize(settings));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error('Settings failed to save', err);
  }
  for (const fn of listeners) fn();
}

/** Applies `change` to the live settings, then validates, saves and notifies. */
export function updateSettings(change: (s: Settings) => void) {
  change(settings);
  commit();
}

export function resetSettings() {
  Object.assign(settings, structuredClone(DEFAULTS));
  commit();
}

/** Marks an exported settings file, so importing some other JSON is caught. */
const EXPORT_APP = 'for-your-safety';
const EXPORT_VERSION = 1;

/** The live settings as the text of a settings file. */
export function exportSettings(): string {
  return JSON.stringify({ app: EXPORT_APP, version: EXPORT_VERSION, settings }, null, 2);
}

/**
 * Replaces the live settings with those in a settings file's text, then saves
 * and notifies. Takes an exported file, or a bare settings object (as kept in
 * localStorage). Values are checked as on load: bad or missing ones get their
 * default. Throws with a readable message if the text isn't a settings file.
 */
export function importSettings(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!obj) throw new Error('The file does not contain settings.');
  if ('app' in obj && obj.app !== EXPORT_APP) throw new Error('The file is from a different app.');
  const body = 'settings' in obj ? obj.settings : obj;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!('volume' in b || 'propagation' in b || 'spawn' in b)) throw new Error('The file does not contain settings.');
  Object.assign(settings, sanitize(body));
  commit();
}

/** A volume setting as a linear amplitude factor (0..1). */
export const volumeGain = (k: VolumeKey) => settings.volume[k] / 100;

/** A volume setting in dB, or null when it is muted. */
export const volumeDb = (k: VolumeKey): number | null =>
  settings.volume[k] > 0 ? 20 * Math.log10(settings.volume[k] / 100) : null;
