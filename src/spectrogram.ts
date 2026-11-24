import { COLS_PER_SEC, HZ_PER_BIN, MAX_HZ, type Spectrogram } from './sim';
import { CLIP_SECONDS, KINDS, type SourceKind } from './sources';

export interface Tag {
  t: number;
  kind: SourceKind;
}

/** Space around the plot, px. Exported so the view scrollbar lines up with the plot. */
export const PAD = { left: 48, right: 12, top: 22, bottom: 22 };
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
/** Narrowest time window, s. */
export const MIN_SPAN_S = 5;
const MIN_SPAN_HZ = 250;
const ZOOM_STEP = 1.5;
/** Edge zones for scrolling while scrubbing: this share of the plot width on each side, at least EDGE_MIN_PX. */
const EDGE_SHARE = 0.12;
const EDGE_MIN_PX = 32;
/** At full depth in an edge zone the view scrolls this many visible spans per second. */
const EDGE_SPANS_PER_S = 1;
/** Smallest visible frequency window, as a fraction of the full axis height. */
const MIN_SPAN_N = MIN_SPAN_HZ / MAX_HZ;
/**
 * Log scale: height goes by log(1 + f / LOG_KNEE_HZ), roughly linear below the
 * knee and logarithmic above it, so 0 Hz stays on the axis.
 */
const LOG_KNEE_HZ = 100;
/** Image rows when resampled to the log scale, so the stretched low bins stay smooth. */
const LOG_ROWS = 1024;
/** Minimum gap between frequency labels, px. */
const TICK_GAP = 22;

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
  private spec: Spectrogram | null = null;
  private time = 0;
  private tags: Tag[] = [];
  private dragging = false;
  // Visible window: seconds on x; on y, axis height from 0 (0 Hz) to 1 (MAX_HZ),
  // linear or log in frequency (see nOfHz)
  private t0 = 0;
  private t1 = CLIP_SECONDS;
  private n0 = 0;
  private n1 = 1;
  private pan: { x: number; y: number; t0: number; n0: number } | null = null;
  /** Touch points on the canvas, by pointer id: where each is now. */
  private touches = new Map<number, { x: number }>();
  /** The first finger of a touch: when it landed and the playhead before it moved it. */
  private touchStart: { at: number; time: number } | null = null;
  /** Two-finger pan/zoom in progress: finger spread and the time under their midpoint at the start. */
  private pinch: { dist: number; tMid: number; span: number } | null = null;
  /** After a pinch, the finger left behind doesn't scrub until every finger has lifted. */
  private touchDone = false;
  /** Where the scrubbing pointer is (client x), and the edge scroll loop's last frame while it runs. */
  private scrubX = 0;
  private edgeFrame: number | null = null;
  private lastPointerType = 'mouse';
  private viewListeners: ((t0: number, t1: number) => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private onSeek: (t: number) => void,
    private log = false,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    document.fonts.ready.then(() => this.draw());

    // Mouse: left button scrubs; middle or right button pans the view.
    // Touch: one finger scrubs, two fingers pan and zoom time (see the touch* methods).
    canvas.addEventListener('pointerdown', (e) => {
      this.lastPointerType = e.pointerType;
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') return this.touchDown(e);
      if (e.button === 0) {
        this.dragging = true;
        this.seekFromEvent(e);
      } else {
        e.preventDefault();
        this.pan = { x: e.clientX, y: e.clientY, t0: this.t0, n0: this.n0 };
        canvas.style.cursor = 'grabbing';
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return this.touchMove(e);
      if (this.pan) {
        const tSpan = this.t1 - this.t0;
        const nSpan = this.n1 - this.n0;
        this.setView(
          this.pan.t0 - ((e.clientX - this.pan.x) / this.plotW) * tSpan,
          tSpan,
          this.pan.n0 + ((e.clientY - this.pan.y) / this.plotH) * nSpan,
          nSpan,
        );
      } else if (this.dragging) this.seekFromEvent(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return this.touchUp(e);
      this.dragging = false;
      if (this.pan) {
        this.pan = null;
        canvas.style.cursor = '';
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // A double tap is not a reset: two quick taps are just two seeks
    canvas.addEventListener('dblclick', () => {
      if (this.lastPointerType !== 'touch') this.resetZoom();
    });

    // Wheel zooms time around the cursor. Shift+wheel, or wheel over the
    // frequency axis, zooms frequency. Horizontal trackpad swipes pan time.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (e.shiftKey || x < PAD.left) {
          // Some browsers turn shift+wheel into a horizontal scroll
          const d = (e.deltaY || e.deltaX) * unit;
          this.zoomFreq(Math.exp(d * 0.0015), this.nOf(y));
        } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const span = this.t1 - this.t0;
          this.setView(this.t0 + ((e.deltaX * unit) / this.plotW) * span, span, this.n0, this.n1 - this.n0);
        } else {
          this.zoomTime(Math.exp(e.deltaY * unit * 0.0015), this.tOf(x));
        }
      },
      { passive: false },
    );
  }

  /** If the second finger lands this soon after the first, the first finger's seek is undone (it was a pinch). */
  private static readonly PINCH_GRACE_MS = 120;

  private touchDown(e: PointerEvent) {
    this.touches.set(e.pointerId, { x: e.clientX });
    if (this.touches.size === 1) {
      this.touchDone = false;
      this.touchStart = { at: performance.now(), time: this.time };
      this.dragging = true;
      this.seekFromEvent(e);
    } else if (this.touches.size === 2) {
      this.dragging = false;
      const [a, b] = [...this.touches.values()];
      this.pinch = { dist: Math.max(1, Math.abs(a.x - b.x)), tMid: this.tOf(this.clientToX((a.x + b.x) / 2)), span: this.t1 - this.t0 };
      // Starting a pinch shouldn't move the playhead. Put it back only once the pinch is
      // set, so setTime doesn't page the view to an off-screen playhead.
      if (this.touchStart && performance.now() - this.touchStart.at < SpectrogramView.PINCH_GRACE_MS) {
        this.onSeek(this.touchStart.time);
      }
    }
  }

  private touchMove(e: PointerEvent) {
    const touch = this.touches.get(e.pointerId);
    if (!touch) return;
    touch.x = e.clientX;
    if (this.pinch && this.touches.size >= 2) {
      // Spread zooms, moving both fingers pans: the time first under the midpoint stays under it
      const [a, b] = [...this.touches.values()];
      const span = Math.min(CLIP_SECONDS, Math.max(MIN_SPAN_S, this.pinch.span * (this.pinch.dist / Math.max(1, Math.abs(a.x - b.x)))));
      const midX = this.clientToX((a.x + b.x) / 2);
      this.setView(this.pinch.tMid - ((midX - PAD.left) / this.plotW) * span, span, this.n0, this.n1 - this.n0);
    } else if (this.dragging && !this.touchDone) {
      this.seekFromEvent(e);
    }
  }

  private touchUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      // Ends the pinch; a finger still down waits for a fresh touch before it scrubs
      this.pinch = null;
      this.touchDone = true;
    }
    if (this.touches.size === 0) {
      this.dragging = false;
      this.touchDone = false;
      this.touchStart = null;
    }
  }

  /** Canvas x of a client (viewport) x. */
  private clientToX(clientX: number) {
    return clientX - this.canvas.getBoundingClientRect().left;
  }

  /** The visible time window, s. */
  view(): { t0: number; t1: number } {
    return { t0: this.t0, t1: this.t1 };
  }

  /** Shows the time window [t0, t1] (clamped to the clip, at least MIN_SPAN_S), keeping the frequency window. */
  setTimeView(t0: number, t1: number) {
    this.setView(t0, t1 - t0, this.n0, this.n1 - this.n0);
  }

  /** Called whenever the visible time window changes. */
  onViewChange(fn: (t0: number, t1: number) => void) {
    this.viewListeners.push(fn);
    fn(this.t0, this.t1);
  }

  setData(spec: Spectrogram) {
    this.spec = spec;
    this.renderImage();
    this.setView(0, CLIP_SECONDS, 0, 1);
  }

  /** Switches the frequency axis between linear and log, keeping the visible frequency range. */
  setLogFrequency(log: boolean) {
    if (log === this.log) return;
    const f0 = this.hzOfN(this.n0);
    const f1 = this.hzOfN(this.n1);
    this.log = log;
    this.renderImage();
    const n0 = this.nOfHz(f0);
    this.setView(this.t0, this.t1 - this.t0, n0, this.nOfHz(f1) - n0);
  }

  setTime(t: number) {
    this.time = t;
    // When zoomed in, page the view so the playhead stays on screen
    if (!this.pan && !this.pinch && (t < this.t0 || t > this.t1)) {
      const span = this.t1 - this.t0;
      this.setView(t - span * 0.05, span, this.n0, this.n1 - this.n0);
    } else this.draw();
  }

  setTags(tags: Tag[]) {
    this.tags = tags;
    this.draw();
  }

  /** Zoom time in, centred on the playhead when it is visible. */
  zoomIn() {
    this.zoomTime(1 / ZOOM_STEP, this.anchorTime());
  }
  zoomOut() {
    this.zoomTime(ZOOM_STEP, this.anchorTime());
  }
  resetZoom() {
    this.setView(0, CLIP_SECONDS, 0, 1);
  }

  /** The plot and its two axes, in client (viewport) coordinates. */
  areas(): { plot: DOMRect; timeAxis: DOMRect; freqAxis: DOMRect } {
    const r = this.canvas.getBoundingClientRect();
    const pw = Math.max(0, this.plotW);
    const ph = Math.max(0, this.plotH);
    return {
      plot: new DOMRect(r.left + PAD.left, r.top + PAD.top, pw, ph),
      timeAxis: new DOMRect(r.left + PAD.left, r.top + PAD.top + ph, pw, PAD.bottom),
      freqAxis: new DOMRect(r.left, r.top + PAD.top, PAD.left, ph),
    };
  }

  /** Where the time span [a, b] s is drawn, in client coordinates, clipped to the view; null when out of view. */
  rangeRect(a: number, b: number): DOMRect | null {
    const lo = Math.max(a, this.t0);
    const hi = Math.min(b, this.t1);
    if (hi <= lo) return null;
    const { plot } = this.areas();
    const x0 = plot.left + this.xOf(lo) - PAD.left;
    const x1 = plot.left + this.xOf(hi) - PAD.left;
    const w = Math.max(6, x1 - x0); // still visible when zoomed far out
    return new DOMRect((x0 + x1) / 2 - w / 2, plot.top, w, plot.height);
  }

  /** Axis height (0 at 0 Hz, 1 at MAX_HZ) of a frequency. */
  private nOfHz(f: number) {
    return this.log ? Math.log1p(f / LOG_KNEE_HZ) / Math.log1p(MAX_HZ / LOG_KNEE_HZ) : f / MAX_HZ;
  }
  private hzOfN(n: number) {
    return this.log ? LOG_KNEE_HZ * Math.expm1(n * Math.log1p(MAX_HZ / LOG_KNEE_HZ)) : n * MAX_HZ;
  }

  /**
   * Pre-renders the data into an offscreen image (time on x, high freq at top).
   * Rows are evenly spaced in axis height. A row narrower than a bin blends the
   * two bins nearest its frequency; a wider one averages the power of every bin
   * it covers, so thin lines don't flicker in and out where rows skip bins.
   */
  private renderImage() {
    const spec = this.spec;
    if (!spec) return;
    const { bins, cols } = spec;
    const rows = this.log ? LOG_ROWS : bins;
    this.image.width = cols;
    this.image.height = rows;
    const ictx = this.image.getContext('2d')!;
    const img = ictx.createImageData(cols, rows);

    // Per row: the bins it draws from and their weights (summing to 1), packed flat
    const start = new Int32Array(rows + 1);
    const idx: number[] = [];
    const wt: number[] = [];
    const clampBin = (b: number) => Math.min(bins - 1, Math.max(0, b));
    for (let r = 0; r < rows; r++) {
      // Row r spans [a, z) in bin units; bin b covers [b, b + 1)
      const a = this.hzOfN(1 - (r + 1) / rows) / HZ_PER_BIN;
      const z = this.hzOfN(1 - r / rows) / HZ_PER_BIN;
      if (z - a <= 1) {
        const p = clampBin((a + z) / 2 - 0.5); // between bin centres
        const lo = Math.floor(p);
        idx.push(lo, clampBin(lo + 1));
        wt.push(1 - (p - lo), p - lo);
      } else {
        for (let b = Math.floor(a); b < z && b < bins; b++) {
          idx.push(b);
          wt.push((Math.min(z, b + 1) - Math.max(a, b)) / (z - a));
        }
      }
      start[r + 1] = idx.length;
    }

    const pow = new Float32Array(bins);
    for (let c = 0; c < cols; c++) {
      const base = c * bins;
      for (let b = 0; b < bins; b++) pow[b] = 10 ** (spec.db[base + b] / 10);
      for (let r = 0; r < rows; r++) {
        let p = 0;
        for (let j = start[r]; j < start[r + 1]; j++) p += pow[idx[j]] * wt[j];
        const db = 10 * Math.log10(p + 1e-12);
        const [red, g, b] = colormap((db - DB_MIN) / (DB_MAX - DB_MIN));
        const i = (r * cols + c) * 4;
        img.data[i] = red;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ictx.putImageData(img, 0, 0);
  }

  private anchorTime() {
    return this.time >= this.t0 && this.time <= this.t1 ? this.time : (this.t0 + this.t1) / 2;
  }

  private zoomTime(factor: number, anchor: number) {
    const span = this.t1 - this.t0;
    const next = Math.min(CLIP_SECONDS, Math.max(MIN_SPAN_S, span * factor));
    this.setView(anchor - (anchor - this.t0) * (next / span), next, this.n0, this.n1 - this.n0);
  }

  private zoomFreq(factor: number, anchor: number) {
    const span = this.n1 - this.n0;
    const next = Math.min(1, Math.max(MIN_SPAN_N, span * factor));
    this.setView(this.t0, this.t1 - this.t0, anchor - (anchor - this.n0) * (next / span), next);
  }

  /** Set the visible window, clamped to the clip and the frequency axis. */
  private setView(t0: number, tSpan: number, n0: number, nSpan: number) {
    tSpan = Math.min(CLIP_SECONDS, Math.max(MIN_SPAN_S, tSpan));
    nSpan = Math.min(1, Math.max(MIN_SPAN_N, nSpan));
    this.t0 = Math.min(CLIP_SECONDS - tSpan, Math.max(0, t0));
    this.t1 = this.t0 + tSpan;
    this.n0 = Math.min(1 - nSpan, Math.max(0, n0));
    this.n1 = this.n0 + nSpan;
    this.draw();
    this.viewListeners.forEach((fn) => fn(this.t0, this.t1));
  }

  private get plotW() {
    return this.canvas.width / devicePixelRatio - PAD.left - PAD.right;
  }
  private get plotH() {
    return this.canvas.height / devicePixelRatio - PAD.top - PAD.bottom;
  }
  private xOf(t: number) {
    return PAD.left + ((t - this.t0) / (this.t1 - this.t0)) * this.plotW;
  }
  private tOf(x: number) {
    return this.t0 + ((x - PAD.left) / this.plotW) * (this.t1 - this.t0);
  }
  /** Canvas y of a frequency in Hz. */
  private yOf(f: number) {
    return PAD.top + this.plotH - ((this.nOfHz(f) - this.n0) / (this.n1 - this.n0)) * this.plotH;
  }
  /** Axis height at canvas y. */
  private nOf(y: number) {
    return this.n0 + ((PAD.top + this.plotH - y) / this.plotH) * (this.n1 - this.n0);
  }

  /** Scrubbing: the playhead goes under the pointer, and an edge zone starts the view scrolling. */
  private seekFromEvent(e: PointerEvent) {
    this.scrubX = e.clientX;
    this.seekAtScrub();
    if (this.edgeFrame === null && this.edgeDepth() !== 0) {
      this.edgeFrame = performance.now();
      requestAnimationFrame((now) => this.edgeScroll(now));
    }
  }

  private seekAtScrub() {
    const t = this.tOf(this.clientToX(this.scrubX));
    // Clamp to the visible window: past the edge the playhead waits at it while the view scrolls
    this.onSeek(Math.min(this.t1, Math.max(this.t0, Math.round(t * COLS_PER_SEC) / COLS_PER_SEC)));
  }

  /**
   * How deep the scrubbing pointer is in an edge zone: -1..0 on the left, 0..1 on
   * the right (capped at the plot's edge, so past it is full speed), 0 outside both.
   */
  private edgeDepth(): number {
    const x = this.clientToX(this.scrubX);
    const zone = Math.max(EDGE_MIN_PX, this.plotW * EDGE_SHARE);
    const left = (PAD.left + zone - x) / zone;
    if (left > 0) return -Math.min(1, left);
    const right = (x - (PAD.left + this.plotW - zone)) / zone;
    return right > 0 ? Math.min(1, right) : 0;
  }

  /**
   * One frame of edge scrolling: the speed scales with the depth and the visible
   * span, so it looks the same on screen at any zoom. Stops when scrubbing ends,
   * the pointer leaves the zone, or the view reaches the clip's start or end.
   */
  private edgeScroll(now: number) {
    const depth = this.dragging && !this.touchDone ? this.edgeDepth() : 0;
    const atEnd = (depth < 0 && this.t0 <= 0) || (depth > 0 && this.t1 >= CLIP_SECONDS);
    if (depth === 0 || atEnd || this.edgeFrame === null) {
      this.edgeFrame = null;
      return;
    }
    const dt = Math.min(0.1, Math.max(0, now - this.edgeFrame) / 1000); // a stalled frame doesn't jump
    this.edgeFrame = now;
    const span = this.t1 - this.t0;
    this.setView(this.t0 + depth * span * EDGE_SPANS_PER_S * dt, span, this.n0, this.n1 - this.n0);
    this.seekAtScrub(); // the playhead stays under the pointer
    requestAnimationFrame((t) => this.edgeScroll(t));
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    this.canvas.width = Math.max(1, parent.clientWidth * devicePixelRatio);
    this.canvas.height = Math.max(1, parent.clientHeight * devicePixelRatio);
    this.draw();
  }

  /** Frequencies to label on the y axis, at least TICK_GAP px apart. */
  private freqTicks(ph: number): number[] {
    const f0 = this.hzOfN(this.n0);
    const f1 = this.hzOfN(this.n1);
    const ticks: number[] = [];
    if (!this.log) {
      const step = [50, 100, 200, 250, 500, 1000].find((s) => (ph * s) / (f1 - f0) >= TICK_GAP) ?? 2500;
      for (let f = Math.ceil(f0 / step) * step; f <= f1 + 1e-6; f += step) ticks.push(f);
      return ticks;
    }
    // Log: 0, then the 1-2-5 series, then fill in with the other digits where there is room
    const pxPerN = ph / (this.n1 - this.n0);
    const tryAdd = (f: number) => {
      if (f < f0 - 1e-6 || f > f1 + 1e-6) return;
      if (ticks.every((t) => Math.abs(this.nOfHz(t) - this.nOfHz(f)) * pxPerN >= TICK_GAP)) ticks.push(f);
    };
    tryAdd(0);
    for (const digits of [[1, 5], [2], [3, 4], [6, 7, 8, 9]]) {
      for (const d of digits) for (const decade of [10, 100, 1000]) if (d * decade <= MAX_HZ) tryAdd(d * decade);
    }
    return ticks;
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

    // Data: crop the offscreen image to the visible window
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high'; // the image has more rows than the screen
    if (this.image.width > 0) {
      const iw = this.image.width;
      const ih = this.image.height;
      const sx = (this.t0 / CLIP_SECONDS) * iw;
      const sw = ((this.t1 - this.t0) / CLIP_SECONDS) * iw;
      const sy = (1 - this.n1) * ih; // image row 0 is the top frequency
      const sh = (this.n1 - this.n0) * ih;
      ctx.drawImage(this.image, sx, sy, sw, sh, PAD.left, PAD.top, pw, ph);
    }

    // Axes
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#5f7bd6';
    ctx.strokeStyle = 'rgba(90, 140, 255, 0.12)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of this.freqTicks(ph)) {
      const y = this.yOf(f);
      const label = f === 0 ? '0 Hz' : f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
      ctx.fillText(label, PAD.left - 6, y);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + pw, y);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Smallest label spacing that leaves room for the text
    const tSpan = this.t1 - this.t0;
    const step = [1, 2, 5, 10, 20, 30, 60, 120, 300].find((s) => (pw * s) / tSpan >= 55) ?? 600;
    for (let s = Math.ceil(this.t0 / step) * step; s <= this.t1 + 1e-6; s += step) {
      const x = this.xOf(s);
      const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      ctx.fillText(label, x, PAD.top + ph + 5);
    }

    // Tags: dashed line plus a glowing diamond in the source colour
    for (const tag of this.tags) {
      if (tag.t < this.t0 || tag.t > this.t1) continue;
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

    // Frequency scroll indicator when zoomed (the view scrollbar under the canvas covers time)
    const track = 'rgba(90, 140, 255, 0.18)';
    const nSpan = this.n1 - this.n0;
    if (nSpan < 1) {
      const bx = PAD.left + pw + 4;
      ctx.fillStyle = track;
      ctx.fillRect(bx, PAD.top, 3, ph);
      ctx.fillStyle = '#2ee6ff';
      ctx.fillRect(bx, PAD.top + (1 - this.n1) * ph, 3, nSpan * ph);
    }

    // Playhead
    if (this.time < this.t0 || this.time > this.t1) return;
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
