// Renders what the target hears over the clip as mono audio samples.
// Uses the same propagation and hearing range as the spectrogram (sim.ts):
// sound reaches the listener late by distance / speed of sound, drops off with
// distance, and is silent beyond the hearing range. Each source is played back
// at the (Doppler exaggerated) source time it is heard from, which bends its pitch.
//
// With distance a sound first loses its highs (low-pass), then from further
// away picks up reverb off the buildings. The plane is high in open sky and
// gets no reverb.
//
// Under everything is a traffic bed whose level follows the noise map at the
// listener's position, and a city background recording at a constant level.
//
// Sources with audio so far: ambulance (synthesised), police, tram, airplane, construction,
// bell (rings once, see OneShotVoice).

import { distanceGainDb, hearingRange, propagate } from '../sim';
import type { NoiseMap } from '../noisemap';
import { CLIP_SECONDS, isActive, positionAt, type SoundSource, type SourceKind, type Track } from '../sources';
import { AUDIO_SAMPLE_RATE, CITY_BACKGROUND_DB, cityOffsetS, voiceOffsetS } from './constants';
import { Lowpass, applyReverb } from './dsp';
import { LoopVoice, OneShotVoice, isOneShot, type SampleBank, type SampleName } from './samples';
import { SirenVoice } from './siren';

export { AUDIO_SAMPLE_RATE };

export interface AudioAssets {
  samples: SampleBank;
  noiseMap: NoiseMap | null; // null if it failed to load; the bed then uses TRAFFIC_DEFAULT_DB
}

/** Received level that maps to digital full scale. A siren 10 m away is ~100 dB. */
const FULL_SCALE_DB = 100;
/** Geometry (distance, delay, gain, filter) is computed this often and interpolated per sample. */
const CONTROL_STEP_S = 0.01;

// ---- Distance colouring. Tune here. ----
/** Low-pass cutoff by distance: ~10 kHz up close, 3.7 kHz at 100 m, 1.5 kHz at 300 m, 650 Hz at 700 m. */
const lowpassHz = (d: number) => 16000 / (1 + d / 30);
/** Reverb starts this far away... */
const REVERB_START_M = 80;
/** ...and is fully mixed in here. */
const REVERB_FULL_M = 250;
/** Reverb send level when fully mixed in. */
const REVERB_SEND = 0.9;
/** How much the direct sound drops when the reverb is fully in (0 = not at all). */
const REVERB_DRY_DUCK = 0.5;

// ---- Traffic bed ----
/** Level outside the noise map's coverage. */
const TRAFFIC_DEFAULT_DB = 50;
/** The bed averages the noise map over this radius around the listener. */
const TRAFFIC_RADIUS_M = 25;
/** The noise map gives day-evening-night averages; shift them to taste. */
const TRAFFIC_OFFSET_DB = 0;
const TRAFFIC_STEP_S = 0.25;

/** How each kind is voiced. Kinds not listed are silent for now. */
const VOICES: Partial<Record<SourceKind, { sample?: SampleName; reverb: boolean }>> = {
  ambulance: { reverb: true }, // synthesised siren (siren.ts)
  police: { sample: 'police', reverb: true },
  tram: { sample: 'tram', reverb: true },
  airplane: { sample: 'airplane', reverb: false },
  construction: { sample: 'construction', reverb: true },
  bell: { sample: 'bell', reverb: true },
};

const dbToAmp = (db: number) => Math.pow(10, db / 20);
const smoothstep = (k: number) => {
  k = Math.min(1, Math.max(0, k));
  return k * k * (3 - 2 * k);
};

interface ControlPoint {
  tau: number; // source time heard (Doppler exaggerated, see propagate)
  amp: number; // linear amplitude at the listener, 0 when silent
  cutoff: number; // low-pass Hz
  wet: number; // 0..1 how far into the reverb zone
}

function controlPoints(src: SoundSource, listener: Track, n: number): ControlPoint[] {
  const range = hearingRange(src);
  const pts: ControlPoint[] = [];
  for (let k = 0; k < n; k++) {
    const t = k * CONTROL_STEP_S;
    const { te, tau, d } = propagate(src, positionAt(listener, t), t);
    const gain = isActive(src, te) ? distanceGainDb(d, range) : null;
    pts.push({
      tau: tau - src.start,
      amp: gain === null ? 0 : dbToAmp(src.levelDb + gain - FULL_SCALE_DB),
      cutoff: lowpassHz(d),
      wet: smoothstep((d - REVERB_START_M) / (REVERB_FULL_M - REVERB_START_M)),
    });
  }
  return pts;
}

interface Voice {
  next(t: number, dt: number): number;
}

function renderSource(
  src: SoundSource,
  voice: Voice,
  reverb: boolean,
  listener: Track,
  out: Float32Array,
  bus: Float32Array,
) {
  const nCtrl = Math.ceil(CLIP_SECONDS / CONTROL_STEP_S) + 2;
  const ctrl = controlPoints(src, listener, nCtrl);
  if (!ctrl.some((c) => c.amp > 0)) return; // never in range

  const lp = new Lowpass();
  const perCtrl = AUDIO_SAMPLE_RATE * CONTROL_STEP_S;

  for (let k = 0; k < nCtrl - 1; k++) {
    const a = ctrl[k];
    const b = ctrl[k + 1];
    const i0 = Math.round(k * perCtrl);
    const i1 = Math.min(out.length, Math.round((k + 1) * perCtrl));
    if (a.amp === 0 && b.amp === 0) {
      lp.reset(); // silent stretch: skip it. Voices are stateless in time, so nothing drifts.
      continue;
    }
    lp.setCutoff((a.cutoff + b.cutoff) / 2);
    const dt = (b.tau - a.tau) / (i1 - i0); // source time per output sample, carries the Doppler shift
    for (let i = i0; i < i1; i++) {
      const f = (i - i0) / (i1 - i0);
      const tau = a.tau + (b.tau - a.tau) * f;
      const amp = a.amp + (b.amp - a.amp) * f; // also gives ~10 ms fades in and out
      const x = amp * lp.process(voice.next(tau, dt));
      if (reverb) {
        const wet = a.wet + (b.wet - a.wet) * f;
        out[i] += x * (1 - REVERB_DRY_DUCK * wet);
        bus[i] += x * wet * REVERB_SEND;
      } else {
        out[i] += x;
      }
    }
  }
}

/** Traffic recording, louder or quieter with the noise map level where the listener is. */
function addTrafficBed(out: Float32Array, listener: Track, assets: AudioAssets) {
  const n = Math.ceil(CLIP_SECONDS / TRAFFIC_STEP_S) + 2;
  const amps: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = positionAt(listener, k * TRAFFIC_STEP_S);
    const db = assets.noiseMap?.levelAround(p, TRAFFIC_RADIUS_M) ?? TRAFFIC_DEFAULT_DB;
    amps.push(dbToAmp(db + TRAFFIC_OFFSET_DB - FULL_SCALE_DB));
  }
  const voice = new LoopVoice(assets.samples.traffic);
  const per = AUDIO_SAMPLE_RATE * TRAFFIC_STEP_S;
  for (let i = 0; i < out.length; i++) {
    const p = i / per;
    const k = Math.floor(p);
    const amp = amps[k] + (amps[k + 1] - amps[k]) * (p - k);
    out[i] += amp * voice.next(i / AUDIO_SAMPLE_RATE);
  }
}

/** City background recording at a constant level, always audible. No distance processing. */
function addCityBackground(out: Float32Array, assets: AudioAssets, seed: number) {
  const amp = dbToAmp(CITY_BACKGROUND_DB - FULL_SCALE_DB);
  const voice = new LoopVoice(assets.samples.city, cityOffsetS(seed));
  for (let i = 0; i < out.length; i++) out[i] += amp * voice.next(i / AUDIO_SAMPLE_RATE);
}

export function renderListenerAudio(
  sources: SoundSource[],
  listener: Track,
  seed: number,
  assets: AudioAssets,
): Float32Array {
  const len = Math.ceil(CLIP_SECONDS * AUDIO_SAMPLE_RATE);
  const out = new Float32Array(len);
  const bus = new Float32Array(len); // reverb send

  sources.forEach((src, i) => {
    const spec = VOICES[src.kind];
    if (!spec) return;
    const offset = voiceOffsetS(seed, i);
    const voice: Voice = !spec.sample
      ? new SirenVoice(offset)
      : isOneShot(spec.sample)
        ? new OneShotVoice(assets.samples[spec.sample])
        : new LoopVoice(assets.samples[spec.sample], offset);
    renderSource(src, voice, spec.reverb, listener, out, bus);
  });

  const wet = applyReverb(bus);
  for (let i = 0; i < len; i++) out[i] += wet[i];

  addTrafficBed(out, listener, assets);
  addCityBackground(out, assets, seed);
  for (let i = 0; i < len; i++) out[i] = Math.tanh(out[i]); // soft limit, never hard clips
  return out;
}
