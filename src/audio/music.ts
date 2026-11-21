// Background music, looped for as long as the page is open: it starts with the
// title screen and keeps playing, uninterrupted, through every round and every
// return to the main menu.
// Browsers may block audio until the first user gesture. The loop is started
// straight away anyway; if the browser holds the AudioContext suspended, the
// first click or key press anywhere resumes it. Looped through Web Audio rather
// than an <audio> element, which leaves a small gap at the loop point with MP3s.

import { onSettingsChange, volumeGain } from '../settings';

const MUSIC_URL = 'audio/music.mp3';
/** Kept low so the recorded clip stays the thing to listen to. Scaled by the music volume setting. */
const MUSIC_VOLUME = 0.35;
const level = () => MUSIC_VOLUME * volumeGain('music');

export class MusicPlayer {
  private readonly ctx = new AudioContext();
  private readonly gain = this.ctx.createGain();
  private muted = false;

  constructor() {
    this.gain.gain.value = level();
    onSettingsChange(() => this.applyLevel());
    this.gain.connect(this.ctx.destination);
    this.start().catch((err) => console.error(err));

    if (this.ctx.state !== 'running') {
      const resume = () => {
        void this.ctx.resume().then(() => {
          if (this.ctx.state !== 'running') return;
          window.removeEventListener('pointerdown', resume);
          window.removeEventListener('keydown', resume);
        });
      };
      window.addEventListener('pointerdown', resume);
      window.addEventListener('keydown', resume);
    }
  }

  private async start() {
    const r = await fetch(MUSIC_URL);
    if (!r.ok) throw new Error(`Music failed to load: ${r.status}`);
    // Decoding works on a suspended context; the loop plays from its start once it resumes.
    const buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(this.gain);
    node.start();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyLevel();
  }

  private applyLevel() {
    this.gain.gain.setTargetAtTime(this.muted ? 0 : level(), this.ctx.currentTime, 0.05);
  }
}
