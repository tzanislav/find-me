// Recorded sounds, decoded once at boot into seamless mono loops at the render rate.

import { AUDIO_SAMPLE_RATE } from './constants';

export type SampleName = 'police' | 'tram' | 'airplane' | 'traffic';

const FILES: Record<SampleName, { url: string; crossfadeS: number }> = {
  police: { url: 'audio/police-siren.mp3', crossfadeS: 0.15 },
  tram: { url: 'audio/tram.mp3', crossfadeS: 0.4 },
  airplane: { url: 'audio/airplane.mp3', crossfadeS: 2 },
  traffic: { url: 'audio/traffic.mp3', crossfadeS: 3 },
};

/** Every loop has an RMS of 1, so a source's levelDb sets its loudness directly. */
export type SampleBank = Record<SampleName, Float32Array>;

/**
 * Loop by crossfading the tail into the head (equal power): the result is
 * shorter by the fade, and its end runs smoothly into its start.
 */
function makeLoop(x: Float32Array, fade: number): Float32Array {
  fade = Math.min(fade, Math.floor(x.length / 3));
  const n = x.length - fade;
  const out = x.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const k = (i + 0.5) / fade;
    out[i] = x[i] * Math.sin((k * Math.PI) / 2) + x[n + i] * Math.cos((k * Math.PI) / 2);
  }
  return out;
}

function normalizeRms(x: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const g = 1 / Math.sqrt(sum / x.length || 1);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

async function loadOne(ctx: BaseAudioContext, url: string, crossfadeS: number): Promise<Float32Array> {
  const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  // Mix down to mono
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return normalizeRms(makeLoop(mono, Math.round(crossfadeS * AUDIO_SAMPLE_RATE)));
}

export async function loadSamples(): Promise<SampleBank> {
  // Decoding into a context at the render rate also resamples. No user gesture needed.
  const ctx = new OfflineAudioContext(1, 1, AUDIO_SAMPLE_RATE);
  const names = Object.keys(FILES) as SampleName[];
  const loops = await Promise.all(names.map((n) => loadOne(ctx, FILES[n].url, FILES[n].crossfadeS)));
  return Object.fromEntries(names.map((n, i) => [n, loops[i]])) as SampleBank;
}

/** Plays a loop at any source time, with linear interpolation, so Doppler can bend its pitch. */
export class LoopVoice {
  constructor(
    private readonly loop: Float32Array,
    private readonly offsetS = 0,
  ) {}

  next(t: number): number {
    const n = this.loop.length;
    let p = ((t + this.offsetS) * AUDIO_SAMPLE_RATE) % n;
    if (p < 0) p += n;
    const i = Math.floor(p);
    const f = p - i;
    return this.loop[i] + (this.loop[(i + 1) % n] - this.loop[i]) * f;
  }
}
