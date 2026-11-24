// Web worker: the heavy part of dealing a round, off the main thread so the page
// (and the loading screen) stays responsive. Simulates the spectrogram, then renders
// the recording. On a phone these take tens of seconds, long enough for the browser
// to call a blocked page unresponsive. round-compute.ts is the main thread's side.

import { renderListenerAudio, type AudioAssets } from './audio/render';
import type { SampleBank } from './audio/samples';
import { NoiseMap, type NoiseMapData } from './noisemap';
import { settings, type Settings } from './settings';
import { simulate, type LoopLengths, type SpectralProfiles } from './sim';
import type { SoundSource, Track } from './sources';

export type WorkerRequest =
  | { type: 'assets'; samples: SampleBank; noiseMap: NoiseMapData | null }
  | {
      type: 'round';
      id: number;
      settings: Settings;
      sources: SoundSource[];
      listener: Track;
      seed: number;
      profiles: SpectralProfiles;
      loops: LoopLengths;
      /** Render the recording too (false when the samples failed to load). */
      audio: boolean;
    };

export type WorkerReply =
  | { type: 'spectrogram'; id: number; cols: number; bins: number; db: Float32Array; ms: number }
  | { type: 'audio'; id: number; audio: Float32Array | null; ms: number }
  | { type: 'error'; id: number; message: string };

let assets: AudioAssets | null = null;
let noiseMap: NoiseMap | null = null;

const post = (reply: WorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'assets') {
    noiseMap = msg.noiseMap ? NoiseMap.fromData(msg.noiseMap) : null;
    assets = { samples: msg.samples, noiseMap };
    return;
  }
  const { id } = msg;
  try {
    // The worker has its own copy of the settings module: match the page's, including borrowed ones
    Object.assign(settings, msg.settings);
    let t0 = performance.now();
    const spec = simulate(msg.sources, msg.listener, msg.seed, msg.profiles, msg.loops, noiseMap);
    post({ type: 'spectrogram', id, cols: spec.cols, bins: spec.bins, db: spec.db, ms: performance.now() - t0 }, [spec.db.buffer]);
    t0 = performance.now();
    const audio = msg.audio && assets ? renderListenerAudio(msg.sources, msg.listener, msg.seed, assets) : null;
    post({ type: 'audio', id, audio, ms: performance.now() - t0 }, audio ? [audio.buffer] : []);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  }
};
