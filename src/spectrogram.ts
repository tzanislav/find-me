import { COLS_PER_SEC, MAX_HZ, type Spectrogram } from './sim';
import { CLIP_SECONDS, KINDS, type SourceKind } from './sources';

export interface Tag {
  t: number;
  kind: SourceKind;
}

const PAD = { left: 48, right: 12, top: 22, bottom: 22 };
const DB_MIN = 20;
const DB_MAX = 85;

// Neon ramp to match the map: void, navy, electric blue, cyan, green, white
const STOPS: [number, [number, number, number]][] = [
  [0.0, [2, 3, 15]],
  [0.3, [10, 18, 96]],
  [0.55, [24, 60, 255]],
  [0.75, [46, 230, 255]],
  [0.9, [69, 255, 156]],
  [1.0, [240, 255, 246]],
];
const FONT = '"Share Tech Mono", monospace';

function colormap(v: number): [number, number, number] {
  v = Math.min(1, Math.max(0, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    if (v <= p1) {
      const [p0, c0] = STOPS[i - 1];
      const k = (v - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export class SpectrogramView {
  private ctx: CanvasRenderingContext2D;
  private image: HTMLCanvasElement = document.createElement('canvas');
  private time = 0;
  private tags: Tag[] = [];
  private dragging = false;

  constructor(private canvas: HTMLCanvasElement, private onSeek: (t: number) => void) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    document.fonts.ready.then(() => this.draw());

    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.seekFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => this.dragging && this.seekFromEvent(e));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
  }

  setData(spec: Spectrogram) {
    // Pre-render the data once into an offscreen image (time on x, high freq at top).
    this.image.width = spec.cols;
    this.image.height = spec.bins;
    const ictx = this.image.getContext('2d')!;
    const img = ictx.createImageData(spec.cols, spec.bins);
    for (let c = 0; c < spec.cols; c++) {
      for (let b = 0; b < spec.bins; b++) {
        const v = (spec.db[c * spec.bins + b] - DB_MIN) / (DB_MAX - DB_MIN);
        const [r, g, bl] = colormap(v);
        const i = ((spec.bins - 1 - b) * spec.cols + c) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = bl;
        img.data[i + 3] = 255;
      }
    }
    ictx.putImageData(img, 0, 0);
    this.draw();
  }

  setTime(t: number) {
    this.time = t;
    this.draw();
  }

  setTags(tags: Tag[]) {
    this.tags = tags;
    this.draw();
  }

  private get plotW() {
    return this.canvas.width / devicePixelRatio - PAD.left - PAD.right;
  }
  private get plotH() {
    return this.canvas.height / devicePixelRatio - PAD.top - PAD.bottom;
  }
  private xOf(t: number) {
    return PAD.left + (t / CLIP_SECONDS) * this.plotW;
  }

  private seekFromEvent(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const t = ((e.clientX - rect.left - PAD.left) / this.plotW) * CLIP_SECONDS;
    this.onSeek(Math.min(CLIP_SECONDS, Math.max(0, Math.round(t * COLS_PER_SEC) / COLS_PER_SEC)));
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    this.canvas.width = Math.max(1, parent.clientWidth * devicePixelRatio);
    this.canvas.height = Math.max(1, parent.clientHeight * devicePixelRatio);
    this.draw();
  }

  private draw() {
    const { ctx } = this;
    const W = this.canvas.width / devicePixelRatio;
    const H = this.canvas.height / devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#02030f';
    ctx.fillRect(0, 0, W, H);

    const pw = this.plotW;
    const ph = this.plotH;
    if (pw <= 0 || ph <= 0) return;

    // Data
    ctx.imageSmoothingEnabled = true;
    if (this.image.width > 0) ctx.drawImage(this.image, PAD.left, PAD.top, pw, ph);

    // Axes
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#5f7bd6';
    ctx.strokeStyle = 'rgba(90, 140, 255, 0.12)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let f = 0; f <= MAX_HZ; f += 1000) {
      const y = PAD.top + ph - (f / MAX_HZ) * ph;
      ctx.fillText(f === 0 ? '0 Hz' : `${f / 1000} kHz`, PAD.left - 6, y);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + pw, y);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = pw / (CLIP_SECONDS / 10) < 45 ? 20 : 10; // fewer labels on narrow screens
    for (let s = 0; s <= CLIP_SECONDS; s += step) {
      const x = this.xOf(s);
      ctx.fillText(`${s}s`, x, PAD.top + ph + 5);
    }

    // Tags: dashed line plus a glowing diamond in the source colour
    for (const tag of this.tags) {
      const x = this.xOf(tag.t);
      const { color } = KINDS[tag.kind];
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      const y = PAD.top - 9;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Playhead
    const x = this.xOf(this.time);
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = '#2ee6ff';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top - 4);
    ctx.lineTo(x, PAD.top + ph);
    ctx.stroke();
    ctx.restore();
  }
}
