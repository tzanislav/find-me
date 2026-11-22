import type { Vec } from '../geo';
import type { NoiseMap } from '../noisemap';

export const AUDIO_SAMPLE_RATE = 24000;

/**
 * Where in its loop a recorded source starts, so vehicles of one kind don't
 * sound in lockstep. Shared by the audio render and the spectrogram so the
 * picture shows the same part of the recording that is playing.
 */
export const voiceOffsetS = (seed: number, sourceIndex: number) => ((seed % 997) + sourceIndex * 7.31) % 60;

/**
 * City background recording, always audible under everything at this level.
 * Not affected by distance: it is the general hum of the city around the
 * listener. Shared by the audio render and the spectrogram.
 */
export const CITY_BACKGROUND_DB = 55;

/** Where in its loop the city background starts for a round. */
export const cityOffsetS = (seed: number) => (seed % 613) * 0.37;

// ---- Traffic bed ----
/** Level when the noise map failed to load. */
const TRAFFIC_DEFAULT_DB = 50;
/** The bed averages the noise map over this radius around the listener. */
const TRAFFIC_RADIUS_M = 25;
/** The noise map gives day-evening-night averages; shift them to taste. */
const TRAFFIC_OFFSET_DB = 0;

/**
 * Traffic level in dB heard at p, from the noise map around it (wrapping
 * around beyond the map's edges). Shared by the audio render and the
 * spectrogram, so the picture follows what is heard.
 */
export function trafficDb(noiseMap: NoiseMap | null, p: Vec): number {
  return (noiseMap ? noiseMap.levelAround(p, TRAFFIC_RADIUS_M) : TRAFFIC_DEFAULT_DB) + TRAFFIC_OFFSET_DB;
}
