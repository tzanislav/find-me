// Procedural ambulance siren, modelled on a reference recording's spectrogram.
// It runs two layers at once (a "dual tone" siren):
//   yelp: a fast "V" every 0.31 s. The pitch drops from high to low in ~60 ms,
//         then recovers along an exponential curve and holds at the top.
//   wail: a slow sweep. Low hold, S-curve rise, high hold, fall.
// Both layers share the same pitch range. The same curves drive the
// spectrogram (sim.ts) and the audio (render.ts), so picture and sound match.

export const AMBULANCE_SIREN = {
  // The reference screenshot had no frequency axis. Low/high ratio (~0.62) was
  // measured from it; the absolute values are typical siren pitches.
  lowHz: 900,
  highHz: 1450,
  yelp: {
    periodS: 0.31, // measured: 3.2 V-dips per second
    dropS: 0.06, // high -> low along a straight slope
    recoverTauS: 0.05, // exponential recovery back to the top (~0.17 s to settle)
  },
  wail: {
    lowHoldS: 0.3,
    riseS: 1.55, // measured: slow S-curve from low to high
    highHoldS: 1.5, // at least 1.1 s in the reference, which ends mid-hold
    fallS: 1.5, // not visible in the reference; a guess
  },
  wailGainDb: -3, // wail layer relative to the yelp layer
  harmonicsDb: [-30, -36], // 2nd and 3rd harmonic; none are visible in the reference
};

const TAU = Math.PI * 2;

/** Yelp layer pitch at source time t (seconds). */
export function yelpHz(t: number): number {
  const { lowHz, highHz, yelp } = AMBULANCE_SIREN;
  const p = ((t % yelp.periodS) + yelp.periodS) % yelp.periodS;
  const span = highHz - lowHz;
  if (p < yelp.dropS) return highHz - span * (p / yelp.dropS);
  return highHz - span * Math.exp(-(p - yelp.dropS) / yelp.recoverTauS);
}

/** Wail layer pitch at source time t (seconds). */
export function wailHz(t: number): number {
  const { lowHz, highHz, wail } = AMBULANCE_SIREN;
  const period = wail.lowHoldS + wail.riseS + wail.highHoldS + wail.fallS;
  let p = ((t % period) + period) % period;
  const span = highHz - lowHz;
  if (p < wail.lowHoldS) return lowHz;
  p -= wail.lowHoldS;
  if (p < wail.riseS) {
    const k = p / wail.riseS;
    return lowHz + span * k * k * (3 - 2 * k); // smoothstep S-curve
  }
  p -= wail.riseS;
  if (p < wail.highHoldS) return highHz;
  p -= wail.highHoldS;
  return highHz - span * (0.5 - 0.5 * Math.cos((p / wail.fallS) * Math.PI));
}

const dbToAmp = (db: number) => Math.pow(10, db / 20);

/**
 * Oscillator for one siren. Call `next` once per output sample with the
 * source time it was emitted at; the phase advances by the source-time step,
 * so a moving siren gets its Doppler shift for free.
 */
export class SirenVoice {
  private yelpPhase = 0;
  private wailPhase = 0;
  private readonly wailAmp = dbToAmp(AMBULANCE_SIREN.wailGainDb);
  private readonly h2 = dbToAmp(AMBULANCE_SIREN.harmonicsDb[0]);
  private readonly h3 = dbToAmp(AMBULANCE_SIREN.harmonicsDb[1]);
  private readonly norm = 1 / (1 + this.wailAmp);

  constructor(startOffsetS = 0) {
    // Different start offsets keep several ambulances from sounding in lockstep.
    this.yelpPhase = (startOffsetS * 1000) % TAU;
    this.wailPhase = (startOffsetS * 700) % TAU;
  }

  next(t: number, dt: number): number {
    this.yelpPhase = (this.yelpPhase + TAU * yelpHz(t) * dt) % TAU;
    this.wailPhase = (this.wailPhase + TAU * wailHz(t) * dt) % TAU;
    const tone = (ph: number) => Math.sin(ph) + this.h2 * Math.sin(2 * ph) + this.h3 * Math.sin(3 * ph);
    return (tone(this.yelpPhase) + this.wailAmp * tone(this.wailPhase)) * this.norm;
  }
}
