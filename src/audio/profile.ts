// Spectral profile of a recorded loop, so the spectrogram can draw what the
// recording actually sounds like instead of a hand-made placeholder shape.
// One frame per spectrogram column, in the spectrogram's frequency bins.

import { BINS, COLS_PER_SEC, HZ_PER_BIN } from '../sim';
import { AUDIO_SAMPLE_RATE } from './constants';

export interface SampleProfile {
  /** frames[f][b]: share of the loop's power in bin b during frame f. */
  frames: Float32Array[];
  frameS: number; // seconds per frame
  loopS: number; // loop length in seconds
  oneShot: boolean; // plays once instead of looping: silent outside 0..loopS
}

const FFT_SIZE = 4096;

/** In-place iterative radix-2 FFT. re and im have length FFT_SIZE. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Analyse a loop (RMS 1, see samples.ts). Each frame's bins are scaled so that,
 * averaged over the loop, the power across all frequencies sums to 1. A source
 * at level L dB then adds L dB worth of power, spread the way the recording is.
 */
export function profileLoop(loop: Float32Array, oneShot = false): SampleProfile {
  const hop = Math.round(AUDIO_SAMPLE_RATE / COLS_PER_SEC);
  const nFrames = Math.max(1, Math.floor(loop.length / hop));
  const hann = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const fftBinHz = AUDIO_SAMPLE_RATE / FFT_SIZE;

  const frames: Float32Array[] = [];
  let totalPower = 0;
  for (let f = 0; f < nFrames; f++) {
    const centre = f * hop + hop / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = Math.round(centre - FFT_SIZE / 2 + i);
      // A loop wraps round; a one-shot is silent beyond its ends
      const s = oneShot
        ? (loop[idx] ?? 0)
        : loop[((idx % loop.length) + loop.length) % loop.length];
      re[i] = s * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const bins = new Float32Array(BINS);
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      totalPower += p;
      const b = Math.floor((k * fftBinHz) / HZ_PER_BIN);
      if (b < BINS) bins[b] += p;
    }
    frames.push(bins);
  }
  const norm = nFrames / (totalPower || 1);
  for (const bins of frames) for (let b = 0; b < BINS; b++) bins[b] *= norm;
  return { frames, frameS: hop / AUDIO_SAMPLE_RATE, loopS: loop.length / AUDIO_SAMPLE_RATE, oneShot };
}
