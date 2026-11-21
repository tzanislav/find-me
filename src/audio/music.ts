// Background music, looped for as long as the page is open.
// Browsers only allow audio after a user gesture, so it starts on the first
// click or key press anywhere. Looped through Web Audio rather than an <audio>
// element, which leaves a small gap at the loop point with MP3s.

const MUSIC_URL = 'audio/music.mp3';
/** Kept low so the recorded clip stays the thing to listen to. */
const MUSIC_VOLUME = 0.35;

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private muted = false;
  private readonly data: Promise<ArrayBuffer>;

  constructor() {
    // Download straight away; decoding needs the AudioContext, which needs a gesture.
    this.data = fetch(MUSIC_URL).then((r) => {
      if (!r.ok) throw new Error(`Music failed to load: ${r.status}`);
      return r.arrayBuffer();
    });
    const start = () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      this.start().catch((err) => console.error(err));
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  private async start() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : MUSIC_VOLUME;
    this.gain.connect(this.ctx.destination);
    const buffer = await this.ctx.decodeAudioData(await this.data);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(this.gain);
    node.start();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(muted ? 0 : MUSIC_VOLUME, this.ctx.currentTime, 0.05);
  }
}
