// Field guide panel (top left): a Doppler toy and reference siren samples.
// Not part of the puzzle. It teaches what a pass-by looks like on the
// spectrogram: the pitch falls as a vehicle passes, the steepest point of the
// fall is the closest approach, a close pass gives a sharp fall and a fast one
// gives a big fall. Uses the game's own Doppler exaggeration, so what the toy
// shows matches what the clip does.

import { AUDIO_SAMPLE_RATE } from './audio/constants';
import { SirenVoice } from './audio/siren';
import { DOPPLER_EXAGGERATION } from './sim';
import { KINDS, iconSvg } from './sources';

const C = 343; // speed of sound, m/s
const F0 = 1000; // the toy siren's true pitch
const SPAN_S = 12; // the plot shows this long before and after the closest approach
const F_MIN = 650;
const F_MAX = 1450;
const PAD = { left: 44, right: 8, top: 10, bottom: 18 };
const FONT = '"Share Tech Mono", monospace';

interface PassPoint {
  t: number; // listener time, 0 = closest approach is heard
  f: number; // heard pitch
}

/**
 * A vehicle on a straight road passing at closest distance d and speed v.
 * Same model as the game: heard at te + r/c, pitch c / (c + k * radial speed).
 */
function passBy(d: number, v: number): PassPoint[] {
  const pts: PassPoint[] = [];
  const reach = SPAN_S * 1.6;
  for (let te = -reach; te <= reach; te += 0.01) {
    const x = v * te;
    const r = Math.hypot(x, d);
    const t = te + (r - d) / C;
    if (t < -SPAN_S || t > SPAN_S) continue;
    const radial = (v * x) / r; // > 0 moving away
    pts.push({ t, f: (F0 * C) / (C + DOPPLER_EXAGGERATION * radial) });
  }
  return pts;
}

/** Time the pitch takes to fall from 80% to 20% of its full swing: short means a close pass. */
function fallTime(v: number, pts: PassPoint[]): number {
  const hi = (F0 * C) / (C - DOPPLER_EXAGGERATION * v);
  const lo = (F0 * C) / (C + DOPPLER_EXAGGERATION * v);
  const at = (frac: number) => pts.find((p) => p.f <= lo + (hi - lo) * frac)?.t ?? NaN;
  return at(0.2) - at(0.8);
}

export class FieldGuide {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dist: HTMLInputElement;
  private readonly speed: HTMLInputElement;
  private readonly readout: HTMLElement;
  private pts: PassPoint[] = [];

  private audio: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private activeBtn: HTMLButtonElement | null = null;
  private readonly cache = new Map<string, AudioBuffer>();

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="guide-head">
        <div class="title">FIELD GUIDE</div>
        <button class="guide-toggle" title="Hide or show">+</button>
      </div>
      <div class="guide-body">
        <div class="guide-label">Doppler pass-by</div>
        <canvas class="guide-canvas"></canvas>
        <label class="guide-slider"><span>Distance</span>
          <input type="range" min="5" max="300" step="1" value="40" data-in="dist" /><b data-out="dist"></b></label>
        <label class="guide-slider"><span>Speed</span>
          <input type="range" min="3" max="30" step="0.5" value="14" data-in="speed" /><b data-out="speed"></b></label>
        <div class="guide-readout"></div>
        <div class="muted small">
          The pitch falls as a vehicle passes. The <b class="guide-hl">steepest point</b> of the fall is the
          moment of closest approach. A <b>sharp</b> fall means it passed close, a <b>big</b> fall means it was fast.
          A sound that only gets louder and quieter without falling never came close.
        </div>
        <div class="guide-label">Reference sirens</div>
        <div class="guide-sample" style="color:${KINDS.police.color}">${iconSvg('police', 18)}<span>${KINDS.police.label}</span><button data-play="police">Play</button></div>
        <div class="guide-sample" style="color:${KINDS.ambulance.color}">${iconSvg('ambulance', 18)}<span>${KINDS.ambulance.label}</span><button data-play="ambulance">Play</button></div>
        <div class="muted small">Raw, as heard standing right next to the vehicle.</div>
      </div>`;

    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.canvas = q('.guide-canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.dist = q('[data-in="dist"]');
    this.speed = q('[data-in="speed"]');
    this.readout = q('.guide-readout');

    const toggle = q<HTMLButtonElement>('.guide-toggle');
    root.classList.add('collapsed'); // starts closed
    toggle.addEventListener('click', () => {
      const collapsed = root.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '+' : '–';
    });

    for (const input of [this.dist, this.speed]) {
      input.addEventListener('input', () => this.update());
    }
    root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((btn) =>
      btn.addEventListener('click', () => this.togglePlay(btn)),
    );

    new ResizeObserver(() => this.resize()).observe(this.canvas);
    document.fonts.ready.then(() => this.draw());
    this.update();
  }

  private update() {
    const d = Number(this.dist.value);
    const v = Number(this.speed.value);
    (this.dist.nextElementSibling as HTMLElement).textContent = `${d} m`;
    (this.speed.nextElementSibling as HTMLElement).textContent = `${Math.round(v * 3.6)} km/h`;
    this.pts = passBy(d, v);
    const hi = (F0 * C) / (C - DOPPLER_EXAGGERATION * v);
    const lo = (F0 * C) / (C + DOPPLER_EXAGGERATION * v);
    const fall = fallTime(v, this.pts);
    this.readout.innerHTML =
      `Falls <b>${Math.round(hi - lo)} Hz</b> (${Math.round(((hi - lo) / F0) * 100)}%) ` +
      `in <b>${Number.isFinite(fall) ? fall.toFixed(1) : '>' + SPAN_S} s</b>`;
    this.draw();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, r.width * devicePixelRatio);
    this.canvas.height = Math.max(1, r.height * devicePixelRatio);
    this.draw();
  }

  private draw() {
    const { ctx } = this;
    const W = this.canvas.width / devicePixelRatio;
    const H = this.canvas.height / devicePixelRatio;
    if (W < 10 || H < 10) return;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#02030f';
    ctx.fillRect(0, 0, W, H);
    const pw = W - PAD.left - PAD.right;
    const ph = H - PAD.top - PAD.bottom;
    const xOf = (t: number) => PAD.left + ((t + SPAN_S) / (2 * SPAN_S)) * pw;
    const yOf = (f: number) => PAD.top + ph - ((f - F_MIN) / (F_MAX - F_MIN)) * ph;

    // Grid and labels
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = '#5f7bd6';
    ctx.strokeStyle = 'rgba(90, 140, 255, 0.12)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let f = 800; f <= F_MAX; f += 200) {
      ctx.fillText(`${f} Hz`, PAD.left - 5, yOf(f));
      ctx.beginPath();
      ctx.moveTo(PAD.left, yOf(f));
      ctx.lineTo(PAD.left + pw, yOf(f));
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = -10; s <= 10; s += 5) ctx.fillText(s === 0 ? '0' : `${s > 0 ? '+' : ''}${s}s`, xOf(s), PAD.top + ph + 4);

    // True pitch
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(207, 224, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(PAD.left, yOf(F0));
    ctx.lineTo(PAD.left + pw, yOf(F0));
    ctx.stroke();
    ctx.restore();

    // The ideal curve: one clean line
    const cyan = '#2ee6ff';
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cyan;
    ctx.shadowColor = cyan;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    this.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.t), yOf(p.f)) : ctx.lineTo(xOf(p.t), yOf(p.f))));
    ctx.stroke();
    ctx.restore();

    // Closest approach: vertical marker and a dot on the curve
    const green = '#45ff9c';
    ctx.save();
    ctx.strokeStyle = green;
    ctx.fillStyle = green;
    ctx.shadowColor = green;
    ctx.shadowBlur = 8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(xOf(0), PAD.top);
    ctx.lineTo(xOf(0), PAD.top + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(xOf(0), yOf(F0), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('CLOSEST', xOf(0) + 5, PAD.top + 1);
    ctx.restore();

  }

  // ---------- Sound ----------

  private async togglePlay(btn: HTMLButtonElement) {
    const wasActive = this.activeBtn === btn;
    this.stop();
    if (wasActive) return;

    this.audio ??= new AudioContext();
    await this.audio.resume();
    const kind = btn.dataset.play!;
    let buffer: AudioBuffer;
    try {
      buffer = await this.sampleBuffer(kind);
    } catch (err) {
      console.error(`Could not play ${kind}`, err);
      return;
    }

    const node = this.audio.createBufferSource();
    node.buffer = buffer;
    node.connect(this.audio.destination);
    node.onended = () => {
      if (this.node === node) this.stop();
    };
    node.start();
    this.node = node;
    this.activeBtn = btn;
    btn.textContent = 'Stop';
  }

  private stop() {
    if (this.node) {
      this.node.onended = null;
      this.node.stop();
      this.node.disconnect();
      this.node = null;
    }
    if (this.activeBtn) this.activeBtn.textContent = 'Play';
    this.activeBtn = null;
  }

  /** Police is the recording the game uses; ambulance is the game's synthesised siren. */
  private async sampleBuffer(kind: string): Promise<AudioBuffer> {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    let buf: AudioBuffer;
    if (kind === 'police') {
      const data = await (await fetch('audio/police-siren.mp3')).arrayBuffer();
      buf = await this.audio!.decodeAudioData(data);
      // Same peak level as the ambulance below
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < ch.length; i++) ch[i] *= 0.5 / (peak || 1);
      }
    } else {
      const sr = AUDIO_SAMPLE_RATE;
      const n = 8 * sr;
      buf = this.audio!.createBuffer(1, n, sr);
      const out = buf.getChannelData(0);
      const voice = new SirenVoice();
      for (let i = 0; i < n; i++) {
        const edge = Math.min(1, i / (0.05 * sr), (n - i) / (0.2 * sr));
        out[i] = 0.5 * edge * voice.next(i / sr, 1 / sr);
      }
    }
    this.cache.set(kind, buf);
    return buf;
  }
}
