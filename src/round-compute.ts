// The main thread's side of round-worker.ts: sends the sound assets once, then one
// job per round, and gets back the spectrogram and the rendered recording.
// If the worker can't start, it falls back to doing the work here (the page then blocks again).

import { renderListenerAudio, type AudioAssets } from './audio/render';
import { settings } from './settings';
import { simulate, type LoopLengths, type SpectralProfiles, type Spectrogram } from './sim';
import type { SoundSource, Track } from './sources';
import type { WorkerReply, WorkerRequest } from './round-worker';

let worker: Worker | null = null;
try {
  worker = new Worker(new URL('./round-worker.ts', import.meta.url), { type: 'module' });
} catch (err) {
  console.error('Round worker failed to start, rounds are computed on the main thread', err);
}

let assets: AudioAssets | null = null;
let nextId = 1;
const jobs = new Map<number, (reply: WorkerReply) => void>();

if (worker) {
  worker.onmessage = (e: MessageEvent<WorkerReply>) => jobs.get(e.data.id)?.(e.data);
  worker.onerror = (e) => {
    console.error('Round worker error', e.message);
    for (const [id, handle] of jobs) handle({ type: 'error', id, message: e.message || 'worker error' });
  };
}

const send = (msg: WorkerRequest) => worker!.postMessage(msg);

/** The sound samples and noise map, once they have loaded. */
export function setRoundAssets(a: AudioAssets) {
  assets = a;
  if (worker) send({ type: 'assets', samples: a.samples, noiseMap: a.noiseMap?.toData() ?? null });
}

export interface RoundResult {
  spec: Spectrogram;
  /** Null when the samples failed to load: the clip is silent. */
  audio: Float32Array | null;
}

/**
 * Simulates the spectrogram and renders the recording for a round, with the current settings.
 * `onSpectrogram` is called between the two, so the loading screen can say what comes next.
 */
export function computeRound(
  sources: SoundSource[],
  listener: Track,
  seed: number,
  profiles: SpectralProfiles,
  loops: LoopLengths,
  onSpectrogram: () => void,
): Promise<RoundResult> {
  if (!worker) return Promise.resolve(computeHere(sources, listener, seed, profiles, loops, onSpectrogram));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let spec: Spectrogram | null = null;
    jobs.set(id, (reply) => {
      if (reply.type === 'error') {
        jobs.delete(id);
        reject(new Error(reply.message));
      } else if (reply.type === 'spectrogram') {
        spec = { cols: reply.cols, bins: reply.bins, db: reply.db };
        console.info(`Spectrogram simulated in ${Math.round(reply.ms)} ms (worker)`);
        onSpectrogram();
      } else {
        jobs.delete(id);
        if (assets) console.info(`Audio rendered in ${Math.round(reply.ms)} ms (worker)`);
        resolve({ spec: spec!, audio: reply.audio });
      }
    });
    send({ type: 'round', id, settings: structuredClone(settings), sources, listener, seed, profiles, loops, audio: !!assets });
  });
}

function computeHere(
  sources: SoundSource[],
  listener: Track,
  seed: number,
  profiles: SpectralProfiles,
  loops: LoopLengths,
  onSpectrogram: () => void,
): RoundResult {
  const spec = simulate(sources, listener, seed, profiles, loops, assets?.noiseMap ?? null);
  onSpectrogram();
  return { spec, audio: assets ? renderListenerAudio(sources, listener, seed, assets) : null };
}
