// Trays on the map edge (index.html [data-tray]): a tab that slides its panel out.
// Target and Tools sit on the left, the legend bottom right.
//
// Desktop: every tray starts open and each one only closes from its own tab.
// Mobile (`exclusive`): they start closed, only one is open at a time, and a press anywhere else closes it.

export type TrayName = 'target' | 'tools' | 'legend';
export const TRAY_NAMES: TrayName[] = ['target', 'tools', 'legend'];

export class Trays {
  /** One tray at a time (mobile). */
  exclusive = false;
  private readonly openSet = new Set<TrayName>();
  private readonly listeners: ((name: TrayName, open: boolean) => void)[] = [];

  /** `keepOpen` is asked before an outside press closes the trays (e.g. while a hold is running). */
  constructor(keepOpen: () => boolean = () => false) {
    for (const name of TRAY_NAMES) {
      this.tab(name).addEventListener('click', () => this.toggle(name));
      this.apply(name);
    }
    // Mobile: a press anywhere outside the open tray closes it. Capture, so the map's
    // and the spectrogram's own handlers can't swallow it. A press on another tab
    // lands here first and then its click opens that tray.
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.exclusive || !this.anyOpen() || keepOpen()) return;
        const inOpenTray = TRAY_NAMES.some((n) => this.openSet.has(n) && this.el(n).contains(e.target as Node));
        if (!inOpenTray) this.closeAll();
      },
      true,
    );
  }

  /** Called with each tray that opens or closes. */
  onChange(fn: (name: TrayName, open: boolean) => void) {
    this.listeners.push(fn);
  }

  isOpen(name: TrayName): boolean {
    return this.openSet.has(name);
  }

  /** Whether any tray in `names` is open (all trays by default). */
  anyOpen(names: TrayName[] = TRAY_NAMES): boolean {
    return names.some((n) => this.openSet.has(n));
  }

  set(name: TrayName, open: boolean) {
    if (open === this.openSet.has(name)) return;
    if (open && this.exclusive) for (const other of [...this.openSet]) this.set(other, false);
    if (open) this.openSet.add(name);
    else this.openSet.delete(name);
    this.apply(name);
    this.listeners.forEach((fn) => fn(name, open));
  }

  toggle(name: TrayName) {
    this.set(name, !this.openSet.has(name));
  }

  closeAll() {
    TRAY_NAMES.forEach((n) => this.set(n, false));
  }

  /** The start of a round: every tray open on desktop, every tray closed on mobile. */
  reset() {
    if (this.exclusive) this.closeAll();
    else TRAY_NAMES.forEach((n) => this.set(n, true));
  }

  /** The tray's root element. */
  el(name: TrayName): HTMLElement {
    return document.querySelector<HTMLElement>(`[data-tray="${name}"]`)!;
  }

  private tab(name: TrayName): HTMLElement {
    return document.querySelector<HTMLElement>(`[data-tray-tab="${name}"]`)!;
  }

  private apply(name: TrayName) {
    const open = this.openSet.has(name);
    this.el(name).classList.toggle('open', open);
    this.tab(name).setAttribute('aria-expanded', String(open));
  }
}
