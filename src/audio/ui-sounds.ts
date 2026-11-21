// Short interface sounds: button clicks, the intro's typing beep, and the
// hold-to-confirm charge/sting. Played through Web Audio so rapid, overlapping
// sounds start on time. They only ever follow a click or key press, so the
// browser lets the context run.

import { onSettingsChange, volumeGain } from '../settings';

const SOUNDS = {
  beep: { url: 'audio/beep-quick.mp3', volume: 0.5 },
  click: { url: 'audio/Click.mp3', volume: 0.5 },
  charge: { url: 'audio/charge.mp3', volume: 0.5 },
  sting: { url: 'audio/sting.mp3', volume: 0.5 },
};

export type UiSound = keyof typeof SOUNDS;

const ctx = new AudioContext();
const decoded: Partial<Record<UiSound, AudioBuffer>> = {};
const gains = {} as Record<UiSound, GainNode>;

for (const [name, { url, volume }] of Object.entries(SOUNDS) as [UiSound, (typeof SOUNDS)[UiSound]][]) {
  const gain = ctx.createGain();
  gain.gain.value = volume * volumeGain('ui');
  gain.connect(ctx.destination);
  gains[name] = gain;
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`UI sound ${url} failed to load: ${r.status}`);
      return r.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then((buf) => (decoded[name] = buf))
    .catch((err) => console.error(err));
}

// The interface volume setting applies at once
onSettingsChange(() => {
  for (const [name, { volume }] of Object.entries(SOUNDS) as [UiSound, (typeof SOUNDS)[UiSound]][]) {
    gains[name].gain.value = volume * volumeGain('ui');
  }
});

/** Plays a sound and returns a function that stops it early. */
export function playUiSound(name: UiSound): () => void {
  const buf = decoded[name];
  if (!buf) return () => {}; // not loaded yet: skip rather than play late
  if (ctx.state !== 'running') void ctx.resume();
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(gains[name]);
  node.start();
  return () => {
    try {
      node.stop();
    } catch {
      // already ended
    }
  };
}

// Every button clicks, including ones added later (inspector, guide, intel).
// Disabled buttons fire no click event, so they stay silent.
document.addEventListener('click', (e) => {
  if ((e.target as Element).closest('button')) playUiSound('click');
});
