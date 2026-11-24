// Line icons for the bottom bar. They draw in currentColor, so CSS sets the colour and glow.

const svg = (body: string, size: number, fill = false) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const menuIcon = (size = 20) => svg('<path d="M4 6.5h16M4 12h16M4 17.5h16"/>', size);
export const playIcon = (size = 24) => svg('<path d="M7 4.5v15l12.5-7.5z"/>', size, true);
export const pauseIcon = (size = 24) => svg('<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>', size, true);
/** A price tag, point down left, with its hole top right. */
export const tagIcon = (size = 20) =>
  svg('<path d="M14.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v4.4a3 3 0 0 1-.9 2.1l-8.4 8.4a1.5 1.5 0 0 1-2.1 0l-5-5a1.5 1.5 0 0 1 0-2.1l8.4-8.4a3 3 0 0 1 2.1-.9z"/><circle cx="16.5" cy="7.5" r="1.5"/>', size);
export const soundIcon = (size = 20) =>
  svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>', size);
export const musicIcon = (size = 20) => svg('<path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>', size);
