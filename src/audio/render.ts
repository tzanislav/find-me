// Renders what the target hears over the clip as mono audio samples.
// Uses the same propagation and hearing range as the spectrogram (sim.ts):
// sound reaches the listener late by distance / speed of sound, drops off with
// distance, and is silent beyond the hearing range. Each source's synth is
// advanced by the emission time it is heard from, which produces Doppler.
//
// Only sources with real audio are rendered. So far: ambulance.

import { distanceGainDb, propagate } from '../sim';
import { mulberry32 } from '../rng';
import { CLIP_SECONDS, isActive, positionAt, type SoundSource, type Track } from '../sources';
import { SirenVoice } from './siren';

export const AUDIO_SAMPLE_RATE = 24000;

/** Received level that maps to digital full scale. A siren 10 m away is ~100 dB. */
const FULL_SCALE_DB = 100;
/** Geometry (distance, delay, gain) is computed this often and interpolated per sample. */
const CONTROL_STEP_S = 0.01;
/** Quiet city hum under everything, so gaps between sources aren't dead silent. */
const CITY_BED_DB = 50;

const dbToAmp = (db: number) => Math.pow(10, db / 20);

interface ControlPoint {
  te: number; // emission time at the source
  amp: number; // linear amplitude at the listener, 0 when silent
}

function controlPoints(src: SoundSource, listener: Track, n: number): ControlPoint[] {
  const pts: ControlPoint[] = [];
  for (let k = 0; k < n; k++) {
    const t = k * CONTROL_STEP_S;
    const { te, d } = propagate(src, positionAt(listener, t), t);
    const gain = isActive(src, te) ? distanceGainDb(d) : null;
    pts.push({ te, amp: gain === null ? 0 : dbToAmp(src.levelDb + gain - FULL_SCALE_DB) });
  }
  return pts;
}

function renderAmbulance(src: SoundSource, listener: Track, out: Float32Array, seedOffset: number) {
  const nCtrl = Math.ceil(CLIP_SECONDS / CONTROL_STEP_S) + 2;
  const ctrl = controlPoints(src, listener, nCtrl);
  if (!ctrl.some((c) => c.amp > 0)) return; // never in range

  const voice = new SirenVoice(seedOffset);
  const perCtrl = AUDIO_SAMPLE_RATE * CONTROL_STEP_S;
  let prevTe = ctrl[0].te - 1 / AUDIO_SAMPLE_RATE;

  for (let k = 0; k < nCtrl - 1; k++) {
    const a = ctrl[k];
    const b = ctrl[k + 1];
    const i0 = Math.round(k * perCtrl);
    const i1 = Math.min(out.length, Math.round((k + 1) * perCtrl));
    if (a.amp === 0 && b.amp === 0) {
      // Silent stretch: skip the synthesis but keep source time moving
      prevTe = b.te;
      continue;
    }
    for (let i = i0; i < i1; i++) {
      const f = (i - i0) / (i1 - i0);
      const te = a.te + (b.te - a.te) * f;
      const amp = a.amp + (b.amp - a.amp) * f; // also gives ~10 ms fades in and out
      out[i] += amp * voice.next(te, te - prevTe);
      prevTe = te;
    }
  }
}

function addCityBed(out: Float32Array, seed: number) {
  // Brown-ish noise: low-passed white noise, roughly the hum of distant traffic
  const rnd = mulberry32(seed);
  const amp = dbToAmp(CITY_BED_DB - FULL_SCALE_DB) * 6; // the filter takes away ~15 dB
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y += 0.03 * (rnd() * 2 - 1 - y);
    out[i] += amp * y;
  }
}

export function renderListenerAudio(sources: SoundSource[], listener: Track, seed: number): Float32Array {
  const out = new Float32Array(Math.ceil(CLIP_SECONDS * AUDIO_SAMPLE_RATE));
  sources.forEach((src, i) => {
    if (src.kind === 'ambulance') renderAmbulance(src, listener, out, i * 1.37);
  });
  addCityBed(out, seed);
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]); // soft limit, never hard clips
  return out;
}
