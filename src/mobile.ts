// Mobile mode (docs/mobile.md): narrow screens, and short ones (phones held sideways).
// One media query decides it; body.mobile mirrors it so CSS and JS never disagree.

export const MOBILE_MAX_WIDTH = 768;
export const MOBILE_MAX_HEIGHT = 500;

const query = matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px), (max-height: ${MOBILE_MAX_HEIGHT}px)`);
const listeners: ((mobile: boolean) => void)[] = [];

export function isMobile(): boolean {
  return query.matches;
}

/** Called whenever the mode switches (resize, rotation). */
export function onMobileChange(fn: (mobile: boolean) => void) {
  listeners.push(fn);
}

const apply = () => document.body.classList.toggle('mobile', query.matches);
apply();
query.addEventListener('change', () => {
  apply();
  listeners.forEach((fn) => fn(query.matches));
});
