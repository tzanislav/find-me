// Placeholder "acoustics": builds spectrogram data directly from the scenario
// instead of synthesising audio and running an FFT. Good enough to prototype
// the puzzle; real audio synthesis can replace it later.

import type { Vec } from './geo';
import { mulberry32 } from './rng';
import { AMBULANCE_SIREN, wailHz, yelpHz } from './audio/siren';
import { CITY_BACKGROUND_DB, cityOffsetS, trafficDb, voiceOffsetS } from './audio/constants';
import type { NoiseMap } from './noisemap';
import type { SampleProfile } from './audio/profile';
import { CLIP_SECONDS, isActive, positionAt, type SoundSource, type SourceKind, type Track } from './sources';
import { settings, visualDb, volumeDb, type VisualKey } from './settings';

export const COLS_PER_SEC = 10;
export const COLS = CLIP_SECONDS * COLS_PER_SEC;
/** 7.8 Hz bins: about as fine as the recordings' analysis resolves (see profile.ts). */
export const BINS = 640;
export const MAX_HZ = 5000;
export const HZ_PER_BIN = MAX_HZ / BINS;
/**
 * Bin width the recorded sources' levels were tuned at. A recording's power is
 * shared across bins, so narrower bins would each get less of it; this keeps
 * their brightness the same against the synthetic sources, which are set per bin.
 */
const PROFILE_REF_HZ = 31.25;

const SPEED_OF_SOUND = 343;
/** Crude high-frequency loss with distance, dB per kHz per km. Settings: Sound propagation. */
const airAbsorption = () => settings.propagation.airAbsorption;

// Hearing ranges and Doppler come from the settings (Sound propagation).
/** How far a pedestrian can hear. Sources beyond this are silent. */
export const hearingRangeM = () => settings.propagation.hearingRangeM;
/** The plane flies at 700 m, so it has its own, longer range. */
export const airplaneRangeM = () => settings.propagation.airplaneRangeM;
/** Fade out over the last stretch of the range so sources don't pop in and out. */
const RANGE_FADE_FRACTION = 1 / 6;

/**
 * Doppler shift is this many times stronger than real, so pass-bys are easy to
 * hear and see. 1 = realistic.
 */
export const dopplerExaggeration = () => settings.propagation.doppler;

export function hearingRange(src: SoundSource): number {
  return src.kind === 'airplane' ? airplaneRangeM() : hearingRangeM();
}

/**
 * Level change from distance alone. Geometric spreading of a point source
 * (by default the inverse square law, -6 dB per doubling of distance, 0 dB at
 * 1 m; the falloff setting scales it), then a smooth fade to silence at the
 * edge of the hearing range.
 * Returns null when the source is out of range.
 */
export function distanceGainDb(d: number, range = hearingRangeM()): number | null {
  if (d >= range) return null;
  const spreading = -20 * (settings.propagation.falloffDb / 6) * Math.log10(Math.max(d, 1));
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
  /**
   * Noise between fLo and fHi with `db` of power in total (scaled like a
   * recording's spectrum, so brightness matches the recorded sources), spread
   * by `shape` (relative dB at a frequency, before Doppler). Each bin gets the
   * random speckle of a real noise spectrogram, so it reads as texture, not a blob.
   */
  noise(fLo: number, fHi: number, db: number, shape: (hz: number) => number, dop?: number): void;
  /** A recording's per-bin power shares, scaled to `db` in total and pitch-shifted by `dop`. */
  spectrum(shares: Float32Array, db: number, dop: number): void;
}

/** Spectral profiles of recorded sources. A kind listed here is drawn from its recording. */
export type SpectralProfiles = Partial<Record<SourceKind | 'city' | 'traffic', SampleProfile>>;

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
 * (the Doppler setting) while staying within a second of te. `doppler` is
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
  const k = dopplerExaggeration();
  const doppler = SPEED_OF_SOUND / (SPEED_OF_SOUND + k * radialVelocity);
  const tau = te - ((k - 1) * d) / SPEED_OF_SOUND;
  return { te, tau, d, doppler };
}

/** Loop lengths in seconds of the recordings that play for kinds drawn by `signature`. */
export type LoopLengths = Partial<Record<SourceKind, number>>;

/**
 * Pitch of the police wail at a position in police-siren.mp3, measured from
 * the recording: 590 to 1175 Hz and back every 3 s, even steps in log pitch,
 * lowest at 2.8 s.
 */
function policeWailHz(pos: number): number {
  const c = ((((pos - 2.8) % 3) + 3) % 3) / 3;
  const u = c < 0.5 ? 2 * c : 2 - 2 * c;
  return 590 * Math.pow(1175 / 590, u);
}
/** Fundamental and harmonics of the police wail, dB relative to the fundamental. */
const POLICE_HARMONICS_DB = [0, -14, -20, -26];

/** Long-term spectrum of airplane.mp3, relative dB. */
function airplaneShapeDb(hz: number): number {
  if (hz <= 125) return -3 * Math.log2(125 / hz);
  return -3.4 * Math.log2(Math.min(hz, 250) / 125) - 10 * Math.log2(Math.max(hz, 250) / 250);
}

/**
 * Hand-made spectral shapes per source type, modelled on their recordings.
 * `lt` is time since the source started; `loopPos` is where in its recording
 * the audio is (lt when there is no loop length).
 */
function signature(kind: SourceKind, lt: number, loopPos: number, dop: number, L: number, e: Emit, rnd: () => number) {
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
      // Wail traced from police-siren.mp3, in step with the loop that plays.
      // Sampled across the column like the ambulance, since the sweep is fast.
      const SUB = 4;
      const each = L - 10 * Math.log10(SUB);
      for (let k = 0; k < SUB; k++) {
        const f = policeWailHz(loopPos + ((k + 0.5) / SUB - 0.5) / COLS_PER_SEC);
        POLICE_HARMONICS_DB.forEach((h, n) => e.tone((n + 1) * f * dop, each + h));
      }
      // Engine and road haze hugging the fundamental, and a faint broadband floor
      const f0 = policeWailHz(loopPos);
      e.noise(f0 * 0.55, f0 * 1.8, L - 12, (hz) => -4.34 * (Math.log2(hz / f0) / 0.25) ** 2, dop);
      e.noise(80, MAX_HZ, L - 22, (hz) => -2 * Math.log2(hz / 80), dop);
      break;
    }
    case 'airplane': {
      // Jet rumble shaped like airplane.mp3: peaks near 125 Hz, falls ~10 dB
      // per octave above 250 Hz, and is steady from moment to moment.
      e.noise(30, MAX_HZ, L + (rnd() - 0.5) * 3, airplaneShapeDb, dop);
      // The engine tones carry the Doppler curve
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
      // Rolling noise shaped like tram.mp3 (flat to 125 Hz, then ~4.5 dB per
      // octave down), lurching by several dB from moment to moment...
      e.noise(30, MAX_HZ, L + (rnd() - 0.5) * 9, (hz) => -4.5 * Math.log2(Math.max(hz, 125) / 125), dop);
      // ...and wheels knocking over rail joints: brief broadband streaks that
      // reach high up the spectrum, about two a second.
      if (rnd() < 0.2) e.noise(80, MAX_HZ, L - 3 + rnd() * 5, (hz) => -1.5 * Math.log2(hz / 80), dop);
      break;
    }
  }
}

/** A sound's volume setting plus its visual multiplier, in dB; null when muted or hidden. */
function drawnDb(k: VisualKey): number | null {
  const vol = volumeDb(k);
  const vis = visualDb(k);
  return vol === null || vis === null ? null : vol + vis;
}

/** Spectrogram of what `listener` hears while moving along its track. */
export function simulate(
  sources: SoundSource[],
  listener: Track,
  seed = 1,
  profiles: SpectralProfiles = {},
  loops: LoopLengths = {},
  noiseMap: NoiseMap | null = null,
): Spectrogram {
  const rnd = mulberry32(seed);
  const pow = new Float32Array(COLS * BINS);
  const noiseWeights = new Float32Array(BINS);
  const absorb = airAbsorption();
  // Per-kind volume plus visual multiplier in dB; null = muted or hidden, left out of the picture
  const volumes = Object.fromEntries(sources.map((s) => [s.kind, drawnDb(s.kind)])) as Record<SourceKind, number | null>;

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
      noise(fLo, fHi, db, shape, dop = 1) {
        const lo = Math.max(0, Math.floor((fLo * dop) / HZ_PER_BIN));
        const hi = Math.min(BINS - 1, Math.ceil((fHi * dop) / HZ_PER_BIN));
        if (hi < lo) return;
        const w = noiseWeights;
        let sum = 0;
        for (let b = lo; b <= hi; b++) {
          w[b] = dbToPow(shape(((b + 0.5) * HZ_PER_BIN) / dop));
          sum += w[b];
        }
        const total = (dbToPow(db) * (PROFILE_REF_HZ / HZ_PER_BIN)) / sum;
        for (let b = lo; b <= hi; b++) {
          const fb = (b + 0.5) * HZ_PER_BIN;
          const speckle = -Math.log(1 - rnd()); // noise power per bin is exponentially distributed
          pow[base + b] += total * w[b] * speckle * dbToPow(-absorbPerKhz * (fb / 1000));
        }
      },
      spectrum(shares, db, dop) {
        const total = dbToPow(db) * (PROFILE_REF_HZ / HZ_PER_BIN);
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
    // Scaled by the city volume and visual multiplier; muted or hidden leaves it out.
    const cityDb = drawnDb('city');
    if (cityDb !== null && profiles.city) {
      makeEmit(0).spectrum(profileFrame(profiles.city, t, cityOffsetS(seed))!, CITY_BACKGROUND_DB + cityDb, 1);
    } else if (cityDb !== null) {
      makeEmit(0).band(20, MAX_HZ, 40 + cityDb + (rnd() - 0.5) * 4, -3);
      for (let b = 0; b < BINS; b++) pow[base + b] *= 0.6 + 0.8 * rnd();
    }

    // Traffic bed: the traffic recording at the noise map's level where the
    // listener is, as in the audio. Only drawn when the recording is loaded.
    const trafficVis = drawnDb('traffic');
    if (trafficVis !== null && profiles.traffic) {
      makeEmit(0).spectrum(profileFrame(profiles.traffic, t, 0)!, trafficDb(noiseMap, here) + trafficVis, 1);
    }

    sources.forEach((src, i) => {
      if (src.silent) return;
      const { te, tau, d, doppler } = propagate(src, here, t);
      if (!isActive(src, te)) return;
      const gain = distanceGainDb(d, hearingRange(src));
      const volume = volumes[src.kind];
      if (gain === null || volume === null) return;
      const received = src.levelDb + gain + volume;
      const emit = makeEmit(absorb * (d / 1000));
      const profile = profiles[src.kind];
      if (profile) {
        const frame = profileFrame(profile, tau - src.start, voiceOffsetS(seed, i));
        if (frame) emit.spectrum(frame, received, doppler);
      } else {
        const loopS = loops[src.kind];
        const lt = tau - src.start;
        const loopPos = loopS ? (((lt + voiceOffsetS(seed, i)) % loopS) + loopS) % loopS : lt;
        signature(src.kind, lt, loopPos, doppler, received, emit, rnd);
      }
    });
  }

  const db = new Float32Array(COLS * BINS);
  for (let i = 0; i < db.length; i++) db[i] = 10 * Math.log10(pow[i] + 1e-12);
  return { cols: COLS, bins: BINS, db };
}
