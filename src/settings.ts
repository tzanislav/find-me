// Player settings: sound levels, sound propagation and spawn counts.
// Kept in localStorage, so they survive reloads. Until the player changes
// something (and again after Reset), the defaults come from
// public/data/default-settings.json, fetched at startup (loadDefaultSettings).
// DEFAULTS below is only the fallback for that file and for missing fields. Code reads `settings` at the
// moment it needs a value, so a change applies from the next round on (music
// and interface volumes apply at once, see onSettingsChange).

import { parseSeed } from './rng';

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

/** Sounds drawn in the spectrogram, each with a visual multiplier beside its volume. */
export const VISUAL_KEYS = ['ambulance', 'police', 'tram', 'airplane', 'construction', 'bell', 'traffic', 'city'] as const;
export type VisualKey = (typeof VISUAL_KEYS)[number];
export const isVisualKey = (k: string): k is VisualKey => (VISUAL_KEYS as readonly string[]).includes(k);

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
  /**
   * How bright each sound is drawn in the spectrogram, as an amplitude factor
   * on top of its volume (2 = +6 dB, 0 = not drawn). The audio is unaffected.
   */
  visual: Record<VisualKey, number>;
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
  display: {
    /** Spectrogram frequency axis on a log scale, so low pitches get more room. */
    logFrequency: boolean;
  };
}

export const DEFAULTS: Settings = {
  volume: Object.fromEntries(VOLUME_KEYS.map((k) => [k, 100])) as Record<VolumeKey, number>,
  visual: Object.fromEntries(VISUAL_KEYS.map((k) => [k, 1])) as Record<VisualKey, number>,
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
  display: {
    logFrequency: true,
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
export const VISUAL_LIMITS: Limits = { min: 0, max: 10, step: 0.1 };
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

/** The defaults in use: the default settings file once it has loaded, else DEFAULTS. */
let defaults: Settings = structuredClone(DEFAULTS);

/** `base` overlaid with whatever valid values `raw` has; unknown or bad entries are dropped. */
function sanitize(raw: unknown, base: Settings = defaults): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, Record<string, unknown>>>;
  const out = structuredClone(base);
  for (const k of VOLUME_KEYS) out.volume[k] = clamp(r.volume?.[k], VOLUME_LIMITS, base.volume[k]);
  for (const k of VISUAL_KEYS) out.visual[k] = clamp(r.visual?.[k], VISUAL_LIMITS, base.visual[k]);
  for (const k of Object.keys(PROPAGATION_LIMITS) as (keyof Settings['propagation'])[]) {
    out.propagation[k] = clamp(r.propagation?.[k], PROPAGATION_LIMITS[k], base.propagation[k]);
  }
  out.spawn.pedestrians = Math.round(clamp(r.spawn?.pedestrians, SPAWN_LIMITS.pedestrians, base.spawn.pedestrians));
  for (const k of ['ambulance', 'police'] as const) {
    out.spawn[k] = clampFleet(r.spawn?.[k], SPAWN_LIMITS[k], base.spawn[k]);
  }
  for (const k of ['airplane', 'construction'] as const) {
    out.spawn[k] = clampRange(r.spawn?.[k], SPAWN_LIMITS[k], base.spawn[k]);
  }
  const logFrequency = r.display?.logFrequency;
  if (typeof logFrequency === 'boolean') out.display.logFrequency = logFrequency;
  return out;
}

/** The player's saved settings, or null if they have none (never changed anything, or reset). */
function loadSaved(): Settings | null {
  try {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    return stored ? sanitize(JSON.parse(stored)) : null;
  } catch (err) {
    console.error('Settings failed to load, using defaults', err);
    return null;
  }
}

const load = (): Settings => loadSaved() ?? structuredClone(defaults);

/** The live settings. Read from it; change it only through updateSettings / resetSettings. */
export const settings: Settings = load();

const listeners = new Set<() => void>();

/** Calls `fn` after every change, e.g. to apply a volume right away. */
export function onSettingsChange(fn: () => void) {
  listeners.add(fn);
}

const notify = () => listeners.forEach((fn) => fn());

/**
 * Settings the tutorial put in place for its round without saving them (see
 * borrowSettings); the player's own come back with restoreOwnSettings.
 */
let borrowed = false;

function commit() {
  Object.assign(settings, sanitize(settings));
  borrowed = false; // a change the player makes is theirs now, whatever was in place before
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error('Settings failed to save', err);
  }
  notify();
}

/** Applies `change` to the live settings, then validates, saves and notifies. */
export function updateSettings(change: (s: Settings) => void) {
  change(settings);
  commit();
}

/**
 * Back to the defaults. The saved settings are dropped rather than overwritten,
 * so the player follows the default settings file again, changes to it included.
 */
export function resetSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Settings failed to reset', err);
  }
  borrowed = false;
  Object.assign(settings, structuredClone(defaults));
  notify();
}

/**
 * Fetches the default settings file and makes it the defaults. A player without
 * saved settings gets them at once. If the file is missing or bad, DEFAULTS stay.
 */
export async function loadDefaultSettings(): Promise<void> {
  try {
    // A settings file, as Export writes it
    const res = await fetch(`${import.meta.env.BASE_URL}data/default-settings.json`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    defaults = sanitize(settingsBody(await res.text()), DEFAULTS);
  } catch (err) {
    console.error('Default settings failed to load, using the built-in ones', err);
    return;
  }
  if (!borrowed && !loadSaved()) {
    Object.assign(settings, structuredClone(defaults));
    notify();
  }
}

/** Puts `change` in place for now without saving it, e.g. the tutorial's settings for its round. */
export function borrowSettings(change: (s: Settings) => void) {
  change(settings);
  Object.assign(settings, sanitize(settings));
  borrowed = true;
  notify();
}

/** Undoes borrowSettings: the player's saved settings, or the defaults if they have none. */
export function restoreOwnSettings() {
  if (!borrowed) return;
  borrowed = false;
  Object.assign(settings, load());
  notify();
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
  Object.assign(settings, sanitize(settingsBody(text)));
  commit();
}

/** The settings object in a settings file's text (exported, or bare). Throws with a readable message if there is none. */
function settingsBody(text: string): unknown {
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
  if (!('volume' in b || 'visual' in b || 'propagation' in b || 'spawn' in b || 'display' in b)) throw new Error('The file does not contain settings.');
  return body;
}

/** A volume setting as a linear amplitude factor (0..1). */
export const volumeGain = (k: VolumeKey) => settings.volume[k] / 100;

/** A volume setting in dB, or null when it is muted. */
export const volumeDb = (k: VolumeKey): number | null =>
  settings.volume[k] > 0 ? 20 * Math.log10(settings.volume[k] / 100) : null;

/** The spectrogram brightness change for a sound in dB, or null when it is not drawn. */
export const visualDb = (k: VisualKey): number | null =>
  settings.visual[k] > 0 ? 20 * Math.log10(settings.visual[k]) : null;

// ---------- Scenario strings ----------
// A round can be shared as "<seed>-<code>": the code carries every setting that
// shapes the round (spawns, propagation, the clip's sound levels and the
// spectrogram multipliers), so someone else gets the same round. Music, interface
// volume and the display options stay the player's own. Not meant to be secure:
// each setting is its slider step number in two base-36 digits, in the order
// below, after a version digit. Never reorder the fields; add new ones at the
// end under a new version.

const SCENARIO_VERSION = '1';
const DIGITS = 2;

interface ScenarioField {
  limits: Limits;
  get: (s: Settings) => number;
  set: (s: Settings, v: number) => void;
}

const PROPAGATION_ORDER: (keyof Settings['propagation'])[] = [
  'hearingRangeM',
  'airplaneRangeM',
  'falloffDb',
  'airAbsorption',
  'doppler',
  'muffleM',
  'reverbStartM',
  'reverbFullM',
  'reverbPct',
  'reverbDuckPct',
];

const SCENARIO_FIELDS: ScenarioField[] = [
  ...VISUAL_KEYS.map((k) => ({ limits: VOLUME_LIMITS, get: (s: Settings) => s.volume[k], set: (s: Settings, v: number) => (s.volume[k] = v) })),
  ...VISUAL_KEYS.map((k) => ({ limits: VISUAL_LIMITS, get: (s: Settings) => s.visual[k], set: (s: Settings, v: number) => (s.visual[k] = v) })),
  ...PROPAGATION_ORDER.map((k) => ({
    limits: PROPAGATION_LIMITS[k],
    get: (s: Settings) => s.propagation[k],
    set: (s: Settings, v: number) => (s.propagation[k] = v),
  })),
  { limits: SPAWN_LIMITS.pedestrians, get: (s) => s.spawn.pedestrians, set: (s, v) => (s.spawn.pedestrians = v) },
  ...(['ambulance', 'police'] as const).flatMap((k) =>
    (['total', 'minActive', 'maxActive'] as const).map((f) => ({
      limits: SPAWN_LIMITS[k],
      get: (s: Settings) => s.spawn[k][f],
      set: (s: Settings, v: number) => (s.spawn[k][f] = v),
    })),
  ),
  ...(['airplane', 'construction'] as const).flatMap((k) =>
    [0, 1].map((i) => ({
      limits: SPAWN_LIMITS[k],
      get: (s: Settings) => s.spawn[k][i],
      set: (s: Settings, v: number) => (s.spawn[k][i] = v),
    })),
  ),
];

const CODE_LENGTH = 1 + SCENARIO_FIELDS.length * DIGITS;
const MAX_STEP = 36 ** DIGITS - 1;

/** The live settings as a scenario code (no seed). */
export function scenarioCode(s: Settings = settings): string {
  const parts = SCENARIO_FIELDS.map(({ limits: l, get }) => {
    const step = Math.min(MAX_STEP, Math.max(0, Math.round((get(s) - l.min) / l.step)));
    return step.toString(36).padStart(DIGITS, '0');
  });
  return (SCENARIO_VERSION + parts.join('')).toUpperCase();
}

/** Seed plus the live settings, as shown in game and copied to share. */
export const scenarioString = (seed: number) => `${seed}-${scenarioCode()}`;

/** A change that sets the settings in `code`, or null if it isn't a valid code. */
function decodeScenario(code: string): ((s: Settings) => void) | null {
  const c = code.toLowerCase();
  if (c.length !== CODE_LENGTH || c[0] !== SCENARIO_VERSION || !/^[0-9a-z]+$/.test(c)) return null;
  const values = SCENARIO_FIELDS.map(({ limits: l }, i) => {
    const step = parseInt(c.slice(1 + i * DIGITS, 1 + (i + 1) * DIGITS), 36);
    return Math.round((l.min + step * l.step) * 1000) / 1000; // 0.1-steps would leave float dust
  });
  return (s) => SCENARIO_FIELDS.forEach((f, i) => f.set(s, values[i]));
}

export interface Scenario {
  seed: number;
  /** Sets the shared settings (pass to updateSettings), or null for a bare seed, which keeps the player's own. */
  settings: ((s: Settings) => void) | null;
}

/** Splits a typed or pasted "<seed>" or "<seed>-<code>", or null if it isn't one. */
export function parseScenario(text: string): Scenario | null {
  const [seedText, code, ...rest] = text.trim().split('-');
  if (rest.length) return null;
  const seed = parseSeed(seedText);
  if (seed === null) return null;
  if (code === undefined) return { seed, settings: null };
  const apply = decodeScenario(code);
  return apply ? { seed, settings: apply } : null;
}
