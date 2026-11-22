// Inspector (right panel): markup for whatever is selected on the map.
// main.ts owns the state and handles clicks on [data-action] / [data-ped].

import type { Pedestrian } from './pedestrians';
import type { Profile } from './people';
import type { TargetClue } from './scenario';
import { towerIconSvg, type Tower } from './towers';

export const fullName = (p: Pedestrian) => `${p.profile.firstName} ${p.profile.lastName}`;

/** Placeholder ID photo: a neon silhouette, one per sex. */
function silhouetteSvg(sex: Profile['sex']): string {
  const body =
    sex === 'female'
      ? // Long hair behind the head, narrower shoulders
        '<path d="M19 38C16 22 21 10 32 10s16 12 13 28c-3 2-7 2-10 1H29c-3 1-7 1-10-1z"/>' +
        '<circle cx="32" cy="23" r="9"/>' +
        '<path d="M14 64c0-12 8-20 18-20s18 8 18 20z"/>'
      : '<circle cx="32" cy="22" r="10"/>' +
        '<path d="M28 31h8v8h-8z"/>' +
        '<path d="M10 64c0-13 10-22 22-22s22 9 22 22z"/>';
  return `<svg viewBox="0 0 64 64" class="silhouette">${body}</svg>`;
}

const field = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;

/** Shown next to a marked person's ID in tower lists. */
const MARK_GLYPH = '<span class="mark-glyph">◆</span>';

const REDACTED = '<span class="redacted">██████</span>';
const genderLabel = (sex: Profile['sex']) => (sex === 'female' ? 'Female' : 'Male');

export function emptyHtml(): string {
  return '<div class="muted small">Nothing selected. Hover a cell tower to see its range, click it or a person to inspect.</div>';
}

/** The always-visible target panel: two of age, gender and occupation, the rest unknown. */
export function targetHtml(target: Pedestrian, clues: TargetClue[]): string {
  const known = (clue: TargetClue, value: string) => (clues.includes(clue) ? value : '<span class="muted">Unknown</span>');
  return `
    <div class="title">TARGET PROFILE</div>
    <dl class="insp-fields">
      ${field('ID', '<span class="muted">Unknown</span>')}
      ${field('Gender', known('sex', genderLabel(target.profile.sex)))}
      ${field('Age', known('age', String(target.profile.age)))}
      ${field('Occupation', known('occupation', target.profile.occupation))}
    </dl>`;
}

export interface TowerView {
  connected: { i: number; p: Pedestrian; revealed: boolean; marked: boolean }[];
  revealCost: number;
  holdMs: number;
  canAfford: boolean;
}

export function towerHtml(tower: Tower, { connected, revealCost, holdMs, canAfford }: TowerView): string {
  const rows = connected
    .map(
      ({ i, p, revealed, marked }) =>
        `<button class="conn-row${marked ? ' marked' : ''}" data-ped="${i}" title="Inspect"><span>${marked ? MARK_GLYPH : ''}${p.id}</span><span>${revealed ? fullName(p) : REDACTED}</span><span>${revealed ? p.phone : REDACTED}</span></button>`,
    )
    .join('');
  const allRevealed = connected.every((c) => c.revealed);
  const done = allRevealed && connected.length > 0;
  return `
    <div class="insp-head">${towerIconSvg(18)}<span>Cell tower</span></div>
    <dl class="insp-fields">
      ${field('ID', tower.id)}
      ${field('Calls handled today', tower.callsToday.toLocaleString('en-US'))}
      ${field('People connected now', String(connected.length))}
    </dl>
    <div class="label">Connected users</div>
    <div class="conn-list">
      <div class="conn-row conn-header"><span>ID</span><span>Name</span><span>Number</span></div>
      ${rows || '<div class="muted small conn-empty">No phones connected.</div>'}
    </div>
    <button data-action="reveal-data" data-hold="${holdMs}" class="intel-btn${done ? ' owned' : ''}" ${connected.length === 0 || allRevealed || !canAfford ? 'disabled' : ''}>
      <span>Reveal user data</span><span class="cost">${done ? 'Revealed' : revealCost}</span>
    </button>`;
}

/**
 * A person's card. Until their data is revealed through a tower, only the ID is known.
 * Marking is free and only a note for the player: it highlights them on the map.
 */
export function personHtml(p: Pedestrian, revealed: boolean, marked: boolean, canArrest: boolean, holdMs: number): string {
  const card = revealed
    ? `<div class="photo">${silhouetteSvg(p.profile.sex)}</div>
      <dl class="insp-fields">
        ${field('ID', p.id)}
        ${field('Name', fullName(p))}
        ${field('Gender', genderLabel(p.profile.sex))}
        ${field('Age', String(p.profile.age))}
        ${field('Occupation', p.profile.occupation)}
      </dl>`
    : `<div class="photo unknown">?</div>
      <div>
        <dl class="insp-fields">${field('ID', p.id)}</dl>
        <div class="muted small locked-note">Data locked. Reveal it from any cell tower this person is in range of.</div>
      </div>`;
  return `
    <div class="insp-head"><span class="legend-dot"></span><span>Person</span>${marked ? `<span class="mark-tag">${MARK_GLYPH}Marked</span>` : ''}</div>
    <div class="person-card">${card}</div>
    <div class="row person-actions">
      <button data-action="mark" class="btn-mark${marked ? ' on' : ''}" title="Highlight this person on the map so you can keep track of them (M)">${marked ? 'Unmark' : 'Mark'}</button>
      <button data-action="arrest" data-hold="${holdMs}" class="btn-arrest" ${canArrest ? '' : 'disabled'}>Arrest</button>
    </div>`;
}
