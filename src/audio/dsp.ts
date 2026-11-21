// Small building blocks for the offline render: a low-pass filter for distance
// and a mono reverb for the echo off buildings.

import { AUDIO_SAMPLE_RATE } from './constants';

/** Two-pole low-pass (RBJ biquad, Q = 0.707). The cutoff can change between blocks. */
export class Lowpass {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  setCutoff(hz: number) {
    const w = (2 * Math.PI * Math.min(hz, AUDIO_SAMPLE_RATE * 0.45)) / AUDIO_SAMPLE_RATE;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Mono Freeverb (Schroeder-Moorer): eight damped comb filters in parallel,
 * then four all-pass filters in series. Delay lengths are the classic ones,
 * scaled from 44.1 kHz to the render rate.
 */
export const REVERB = {
  roomSize: 0.82, // 0..1, longer tail when higher. 0.82 gives a ~2.5 s tail, like a street canyon
  damping: 0.45, // 0..1, how fast the tail loses its highs
  preDelayS: 0.025,
};

const COMB_44K = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_44K = [556, 441, 341, 225];
const INPUT_GAIN = 0.015 * 2.5; // calibrated so white noise comes out at about the same RMS

export function applyReverb(input: Float32Array): Float32Array {
  const sr = AUDIO_SAMPLE_RATE / 44100;
  const feedback = REVERB.roomSize * 0.28 + 0.7;
  const damp = REVERB.damping * 0.4;
  const pre = Math.round(REVERB.preDelayS * AUDIO_SAMPLE_RATE);

  const combs = COMB_44K.map((n) => ({ buf: new Float32Array(Math.round(n * sr)), i: 0, store: 0 }));
  const allpasses = ALLPASS_44K.map((n) => ({ buf: new Float32Array(Math.round(n * sr)), i: 0 }));
  const out = new Float32Array(input.length);

  for (let n = 0; n < input.length; n++) {
    const x = (n >= pre ? input[n - pre] : 0) * INPUT_GAIN;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * (1 - damp) + c.store * damp;
      c.buf[c.i] = x + c.store * feedback;
      if (++c.i >= c.buf.length) c.i = 0;
      y += o;
    }
    for (const a of allpasses) {
      const b = a.buf[a.i];
      a.buf[a.i] = y + b * 0.5;
      y = b - y;
      if (++a.i >= a.buf.length) a.i = 0;
    }
    out[n] = y;
  }
  return out;
}
