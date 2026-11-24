// View scrollbar under the spectrogram: a dim line for the whole clip and a bright
// bar for the slice in view. Drag the bar to pan, drag a handle at either end to
// zoom that edge, press the track to jump there. Lines up with the plot, not the axis labels.

import { CLIP_SECONDS } from './sources';
import { MIN_SPAN_S, PAD, type SpectrogramView } from './spectrogram';

type Drag = { mode: 'pan' | 'left' | 'right'; x: number; t0: number; t1: number };

export class SpectroScrollbar {
  private readonly thumb: HTMLElement;
  private drag: Drag | null = null;

  constructor(
    private readonly root: HTMLElement,
    spectro: SpectrogramView,
  ) {
    root.innerHTML = `
      <div class="vscroll-track"></div>
      <div class="vscroll-thumb">
        <span class="vscroll-handle" data-edge="left"></span>
        <span class="vscroll-handle" data-edge="right"></span>
      </div>`;
    root.style.marginLeft = `${PAD.left}px`;
    root.style.marginRight = `${PAD.right}px`;
    this.thumb = root.querySelector('.vscroll-thumb')!;

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      const { t0, t1 } = spectro.view();
      const edge = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge;
      if (edge === 'left' || edge === 'right') {
        this.drag = { mode: edge, x: e.clientX, t0, t1 };
      } else if (this.thumb.contains(e.target as Node)) {
        this.drag = { mode: 'pan', x: e.clientX, t0, t1 };
      } else {
        // On the track: centre the view there, then keep dragging as a pan
        const span = t1 - t0;
        const t = this.timeAt(e.clientX);
        spectro.setTimeView(t - span / 2, t + span / 2);
        const v = spectro.view();
        this.drag = { mode: 'pan', x: e.clientX, t0: v.t0, t1: v.t1 };
      }
      root.classList.add('dragging');
    });
    root.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const { mode, x, t0, t1 } = this.drag;
      const dt = ((e.clientX - x) / this.width) * CLIP_SECONDS;
      if (mode === 'pan') {
        const shift = Math.min(CLIP_SECONDS - t1, Math.max(-t0, dt));
        spectro.setTimeView(t0 + shift, t1 + shift);
      } else if (mode === 'left') {
        spectro.setTimeView(Math.min(t1 - MIN_SPAN_S, Math.max(0, t0 + dt)), t1);
      } else {
        spectro.setTimeView(t0, Math.max(t0 + MIN_SPAN_S, Math.min(CLIP_SECONDS, t1 + dt)));
      }
    });
    const end = () => {
      this.drag = null;
      root.classList.remove('dragging');
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    spectro.onViewChange((t0, t1) => this.render(t0, t1));
  }

  private get width() {
    return Math.max(1, this.root.clientWidth);
  }

  private timeAt(clientX: number) {
    const r = this.root.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * CLIP_SECONDS;
  }

  private render(t0: number, t1: number) {
    this.thumb.style.left = `${(100 * t0) / CLIP_SECONDS}%`;
    this.thumb.style.width = `${(100 * (t1 - t0)) / CLIP_SECONDS}%`;
  }
}
