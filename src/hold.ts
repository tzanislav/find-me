// Hold-to-confirm buttons. Any <button data-hold="ms"> has to be held down for
// that long: its fill (CSS var --hold, 0..1) grows while held, and letting go
// or sliding off early cancels with no effect. When the fill completes, the
// button dispatches a bubbling 'hold' event; listen for that instead of 'click'.
// The charge sound plays while held; on completion it cuts to the sting.

import { playUiSound } from './audio/ui-sounds';

interface ActiveHold {
  btn: HTMLButtonElement;
  start: number;
  ms: number;
  raf: number;
  stopCharge: () => void;
}

let active: ActiveHold | null = null;

/** True while a hold is in progress on a button inside `root` (so callers can avoid redrawing it away). */
export function holdingIn(root: HTMLElement): boolean {
  return active !== null && root.contains(active.btn);
}

function cancel() {
  if (!active) return;
  cancelAnimationFrame(active.raf);
  active.stopCharge();
  active.btn.style.setProperty('--hold', '0');
  active.btn.classList.remove('holding');
  active = null;
}

function frame(now: number) {
  if (!active) return;
  const k = Math.min(1, Math.max(0, now - active.start) / active.ms);
  active.btn.style.setProperty('--hold', String(k));
  if (k < 1) {
    active.raf = requestAnimationFrame(frame);
    return;
  }
  const { btn } = active;
  cancel();
  if (btn.isConnected && !btn.disabled) {
    playUiSound('sting');
    btn.dispatchEvent(new CustomEvent('hold', { bubbles: true }));
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-hold]');
  if (!btn || btn.disabled) return;
  cancel();
  active = {
    btn,
    start: performance.now(),
    ms: Number(btn.dataset.hold) || 1000,
    raf: 0,
    stopCharge: playUiSound('charge'),
  };
  btn.classList.add('holding');
  active.raf = requestAnimationFrame(frame);
});
document.addEventListener('pointerup', cancel);
document.addEventListener('pointercancel', cancel);
document.addEventListener('pointerout', (e) => {
  // Sliding off the button counts as letting go
  if (active && !active.btn.contains(e.relatedTarget as Node | null)) cancel();
});
window.addEventListener('blur', cancel);
