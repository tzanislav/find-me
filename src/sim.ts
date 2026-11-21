// Placeholder "acoustics": builds spectrogram data directly from the scenario
// instead of synthesising audio and running an FFT. Good enough to prototype
// the puzzle; real audio synthesis can replace it later.

import type { Vec } from './geo';
import { mulberry32 } from './rng';
import { AMBULANCE_SIREN, wailHz, yelpHz } from './audio/siren';
import { CITY_BACKGROUND_DB, cityOffsetS, voiceOffsetS } from './audio/constants';
import type { SampleProfile } from './audio/profile';
import { CLIP_SECONDS, isActive, positionAt, type SoundSource, type SourceKind, type Track } from './sources';

export const COLS_PER_SEC = 10;
export const COLS = CLIP_SECONDS * COLS_PER_SEC;
export const BINS = 160;
export const MAX_HZ = 5000;
export const HZ_PER_BIN = MAX_HZ / BINS;

const SPEED_OF_SOUND = 343;
const AIR_ABSORPTION_DB_PER_KHZ_KM = 4; // crude high-frequency loss with distance

/** How far a pedestrian can hear. Sources beyond this are silent. */
export const HEARING_RANGE_M = 300;
/** The plane flies at 700 m, so it is exempt from the normal range. */
export const AIRPLANE_RANGE_M = 3000;
/** Fade out over the last stretch of the range so sources don't pop in and out. */
const RANGE_FADE_FRACTION = 1 / 6;

/**
 * Doppler shift is this many times stronger than real, so pass-bys are easy to
 * hear and see. 1 = realistic.
 */
export const DOPPLER_EXAGGERATION = 2;

export function hearingRange(src: SoundSource): number {
  return src.kind === 'airplane' ? AIRPLANE_RANGE_M : HEARING_RANGE_M;
}

/**
 * Level change from distance alone. Geometric spreading of a point source
 * (inverse square law, -6 dB per doubling of distance, 0 dB at 1 m), then a
 * smooth fade to silence at the edge of the hearing range.
 * Returns null when the source is out of range.
 */
export function distanceGainDb(d: number, range = HEARING_RANGE_M): number | null {
  if (d >= range) return null;
  const spreading = -20 * Math.log10(Math.max(d, 1));
  const k = Math.min(1, (range - d) / (range * RANGE_FADE_FRACTION));
  const fade = k * k * (3 - 2 * k); // smoothstep, as a power factor
  return spreading + 10 * Math.log10(fade);
}

export interface Spectrogram {
  cols: number;
  bins: number;
  db: Float32Array; // index = col * bins + bin, bin 0 = lowest frequency
}

/** Emitter helpers handed to each signature. Levels are dB at the listener. */
interface Emit {
  tone(freq: number, db: number, widthHz?: number): void;
  band(fLo: number, fHi: number, db: number, tiltDbPerOctave?: number): void;
  /** A recording's per-bin power shares, scaled to `db` in total and pitch-shifted by `dop`. */
  spectrum(shares: Float32Array, db: number, dop: number): void;
}

/** Spectral profiles of recorded sources. A kind listed here is drawn from its recording. */
export type SpectralProfiles = Partial<Record<SourceKind | 'city', SampleProfile>>;

/**
 * The profile frame playing at source time `lt`, matching LoopVoice and
 * OneShotVoice in samples.ts. Null when a one-shot is not playing.
 */
function profileFrame(p: SampleProfile, lt: number, offsetS: number): Float32Array | null {
  if (p.oneShot) {
    const f = Math.floor(lt / p.frameS);
    return f >= 0 && f < p.frames.length ? p.frames[f] : null;
  }
  const pos = (((lt + offsetS) % p.loopS) + p.loopS) % p.loopS;
  return p.frames[Math.min(p.frames.length - 1, Math.floor(pos / p.frameS))];
}

const dbToPow = (db: number) => Math.pow(10, db / 10);

function distance3d(src: SoundSource, p: Vec, listener: Vec): number {
  return Math.hypot(p.x - listener.x, p.y - listener.y, src.altitude);
}

/**
 * For listener time t, find when the sound we hear left the source (te),
 * how far it travelled (d), and the Doppler factor at that moment.
 *
 * `tau` is the source time to play back at t. Physically it would be te =
 * t - d / c; using t - k * d / c instead multiplies the Doppler shift by k
 * (DOPPLER_EXAGGERATION) while staying within a second of te. `doppler` is
 * the matching (exaggerated) pitch factor, d tau / dt.
 */
export function propagate(src: SoundSource, listener: Vec, t: number) {
  let te = t;
  let d = 0;
  for (let i = 0; i < 3; i++) {
    d = distance3d(src, positionAt(src, te), listener);
    te = t - d / SPEED_OF_SOUND;
  }
  const h = 0.05;
  const dPlus = distance3d(src, positionAt(src, te + h), listener);
  const dMinus = distance3d(src, positionAt(src, te - h), listener);
  const radialVelocity = (dPlus - dMinus) / (2 * h); // > 0 means moving away
  const k = DOPPLER_EXAGGERATION;
  const doppler = SPEED_OF_SOUND / (SPEED_OF_SOUND + k * radialVelocity);
  const tau = te - ((k - 1) * d) / SPEED_OF_SOUND;
  return { te, tau, d, doppler };
}

/** Placeholder spectral shapes per source type. `lt` is time since the source started. */
function signature(kind: SourceKind, lt: number, dop: number, L: number, e: Emit, rnd: () => number) {
  switch (kind) {
    case 'ambulance': {
      // Dual-tone siren from audio/siren.ts, the same curves the audio uses.
      // One column spans longer than a yelp cycle, so sample the curves across
      // the column like an analysis window would, splitting the energy.
      const SUB = 8;
      const each = L - 10 * Math.log10(SUB);
      const wail = each + AMBULANCE_SIREN.wailGainDb;
      const [h2, h3] = AMBULANCE_SIREN.harmonicsDb;
      for (let k = 0; k < SUB; k++) {
        const tk = lt + ((k + 0.5) / SUB - 0.5) / COLS_PER_SEC;
        for (const [f, db] of [[yelpHz(tk) * dop, each], [wailHz(tk) * dop, wail]]) {
          e.tone(f, db);
          e.tone(2 * f, db + h2);
          e.tone(3 * f, db + h3);
        }
      }
      break;
    }
    case 'police': {
      // Hi-lo two tone
      const f = Math.floor(lt / 0.6) % 2 === 0 ? 700 : 950;
      e.tone(f * dop, L);
      e.tone(2 * f * dop, L - 9);
      e.tone(3 * f * dop, L - 18);
      break;
    }
    case 'airplane': {
      e.band(50, 2500, L - 12, -4);
      e.tone(110 * dop, L - 6, 40);
      e.tone(2300 * dop, L - 20, 25);
      break;
    }
    case 'bell': {
      // Strike every 2.2 s, partials decay
      const age = lt % 2.2;
      const env = -age * 10;
      const partials = [0.5, 1, 1.19, 1.5, 2, 2.52, 3];
      partials.forEach((p, i) => e.tone(392 * p, L + env - i * 2, 12));
      break;
    }
    case 'construction': {
      // Jackhammer bursts: 4.5 s on, 2.5 s off
      if (lt % 7 < 4.5) e.band(150, 4500, L - 8 + (rnd() - 0.5) * 6, -1);
      break;
    }
    case 'tram': {
      e.band(30, 450, L - 4, -6);
      if (lt > 30 && lt < 34) e.tone(3200 * dop, L - 6, 60); // wheel screech in a curve
      break;
    }
  }
}

/** Spectrogram of what `listener` hears while moving along its track. */
export function simulate(sources: SoundSource[], listener: Track, seed = 1, profiles: SpectralProfiles = {}): Spectrogram {
  const rnd = mulberry32(seed);
  const pow = new Float32Array(COLS * BINS);

  for (let col = 0; col < COLS; col++) {
    const t = col / COLS_PER_SEC;
    const base = col * BINS;
    const here = positionAt(listener, t);

    // Per-column absorption depends on distance, so build emitters per source.
    const makeEmit = (absorbPerKhz: number): Emit => ({
      tone(freq, db, widthHz = HZ_PER_BIN) {
        const center = freq / HZ_PER_BIN;
        const sigma = widthHz / HZ_PER_BIN;
        const lo = Math.max(0, Math.floor(center - 3 * sigma));
        const hi = Math.min(BINS - 1, Math.ceil(center + 3 * sigma));
        for (let b = lo; b <= hi; b++) {
          const fb = (b + 0.5) * HZ_PER_BIN;
          const g = Math.exp(-0.5 * ((b + 0.5 - center) / sigma) ** 2);
          pow[base + b] += g * dbToPow(db - absorbPerKhz * (fb / 1000));
        }
      },
      band(fLo, fHi, db, tilt = 0) {
        const lo = Math.max(0, Math.floor(fLo / HZ_PER_BIN));
        const hi = Math.min(BINS - 1, Math.ceil(fHi / HZ_PER_BIN));
        for (let b = lo; b <= hi; b++) {
          const fb = (b + 0.5) * HZ_PER_BIN;
          const level = db + tilt * Math.log2(Math.max(fb, 1) / fLo) - absorbPerKhz * (fb / 1000);
          pow[base + b] += dbToPow(level);
        }
      },
      spectrum(shares, db, dop) {
        const total = dbToPow(db);
        for (let b = 0; b < BINS; b++) {
          if (shares[b] === 0) continue;
          const to = Math.round((b + 0.5) * dop - 0.5); // Doppler moves energy up or down in pitch
          if (to < 0 || to >= BINS) continue;
          const fb = (to + 0.5) * HZ_PER_BIN;
          pow[base + to] += total * shares[b] * dbToPow(-absorbPerKhz * (fb / 1000));
        }
      },
    });

    // City background: the real recording when loaded (as heard in the audio),
    // otherwise a synthetic pinkish, flickering noise floor.
    if (profiles.city) {
      makeEmit(0).spectrum(profileFrame(profiles.city, t, cityOffsetS(seed))!, CITY_BACKGROUND_DB, 1);
    } else {
      makeEmit(0).band(20, MAX_HZ, 40 + (rnd() - 0.5) * 4, -3);
      for (let b = 0; b < BINS; b++) pow[base + b] *= 0.6 + 0.8 * rnd();
    }

    sources.forEach((src, i) => {
      const { te, tau, d, doppler } = propagate(src, here, t);
      if (!isActive(src, te)) return;
      const gain = distanceGainDb(d, hearingRange(src));
      if (gain === null) return;
      const received = src.levelDb + gain;
      const emit = makeEmit(AIR_ABSORPTION_DB_PER_KHZ_KM * (d / 1000));
      const profile = profiles[src.kind];
      if (profile) {
        const frame = profileFrame(profile, tau - src.start, voiceOffsetS(seed, i));
        if (frame) emit.spectrum(frame, received, doppler);
      } else signature(src.kind, tau - src.start, doppler, received, emit, rnd);
    });
  }

  const db = new Float32Array(COLS * BINS);
  for (let i = 0; i < db.length; i++) db[i] = 10 * Math.log10(pow[i] + 1e-12);
  return { cols: COLS, bins: BINS, db };
}
