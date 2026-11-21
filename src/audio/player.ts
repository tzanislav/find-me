// Plays the rendered clip in sync with the timeline.
// The AudioContext is created on the first play, since browsers only allow
// audio to start from a user gesture.

import { AUDIO_SAMPLE_RATE } from './constants';

export class ClipPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private samples: Float32Array | null = null;
  private buffer: AudioBuffer | null = null;
  private node: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private startOffset = 0;
  private muted = false;

  /** Replace the clip. Stops playback. */
  setSamples(samples: Float32Array) {
    this.stop();
    this.samples = samples;
    this.buffer = null;
  }

  /** Start playing from `offset` seconds. Must be called from a user gesture the first time. */
  play(offset: number) {
    if (!this.samples) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = this.muted ? 0 : 1;
    }
    if (!this.buffer) {
      this.buffer = this.ctx.createBuffer(1, this.samples.length, AUDIO_SAMPLE_RATE);
      this.buffer.copyToChannel(this.samples as Float32Array<ArrayBuffer>, 0);
    }
    void this.ctx.resume();
    this.stop();
    this.node = this.ctx.createBufferSource();
    this.node.buffer = this.buffer;
    this.node.connect(this.gain!);
    this.node.start(0, Math.max(0, offset));
    this.startedAt = this.ctx.currentTime;
    this.startOffset = offset;
  }

  stop() {
    if (!this.node) return;
    this.node.onended = null;
    this.node.stop();
    this.node.disconnect();
    this.node = null;
  }

  /** Playback position in seconds while playing, otherwise null. Use it as the clock. */
  get position(): number | null {
    if (!this.node || !this.ctx) return null;
    return this.startOffset + (this.ctx.currentTime - this.startedAt);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }
}
