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
