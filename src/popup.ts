// A panel opened by a button: the button toggles it, and a press anywhere
// outside both closes it. Used by the field guide overlay and the tag picker.

export interface Popup {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

const all: Popup[] = [];

/** Closes every popup; true if one was open (so Escape can stop there). */
export function closePopups(): boolean {
  const any = all.some((p) => p.isOpen);
  all.forEach((p) => p.close());
  return any;
}

export function popup(button: HTMLElement, panel: HTMLElement, onChange?: (open: boolean) => void): Popup {
  let isOpen = !panel.classList.contains('hidden');
  const set = (open: boolean) => {
    if (open === isOpen) return;
    isOpen = open;
    panel.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('on', open);
    onChange?.(open);
  };
  const p: Popup = {
    get isOpen() {
      return isOpen;
    },
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!isOpen),
  };
  button.addEventListener('click', () => p.toggle());
  // Capture, so a press that something else stops (the map, the spectrogram) still closes it
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Node;
      if (isOpen && !panel.contains(t) && !button.contains(t)) p.close();
    },
    true,
  );
  all.push(p);
  return p;
}
