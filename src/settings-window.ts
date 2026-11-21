// Settings window, opened from the main menu. Built from the tables below;
// every change is saved straight away (settings.ts keeps it in localStorage).

import {
  PROPAGATION_LIMITS,
  SPAWN_LIMITS,
  VOLUME_KEYS,
  VOLUME_LIMITS,
  exportSettings,
  importSettings,
  resetSettings,
  settings,
  updateSettings,
  type Limits,
  type Settings,
  type VolumeKey,
} from './settings';

const VOLUME_LABELS: Record<VolumeKey, string> = {
  ambulance: 'Ambulance siren',
  police: 'Police siren',
  tram: 'Tram',
  airplane: 'Airplanes',
  construction: 'Construction',
  bell: 'Church bells',
  traffic: 'Traffic',
  city: 'City background',
  music: 'Music',
  ui: 'Interface sounds',
};

type PropKey = keyof Settings['propagation'];
const PROPAGATION_FIELDS: { key: PropKey; label: string; unit: string; hint: string }[] = [
  { key: 'hearingRangeM', label: 'Hearing range', unit: 'm', hint: 'Ground sources further away are silent' },
  { key: 'airplaneRangeM', label: 'Airplane range', unit: 'm', hint: 'Airplanes fly high, so they carry further' },
  { key: 'falloffDb', label: 'Distance falloff', unit: 'dB per doubling', hint: '6 = inverse square law, 0 = no drop' },
  { key: 'doppler', label: 'Doppler exaggeration', unit: '×', hint: '1 = realistic' },
  { key: 'airAbsorption', label: 'Air absorption', unit: 'dB/kHz/km', hint: 'High pitches fading with distance, in the spectrogram' },
  { key: 'muffleM', label: 'Muffling distance', unit: 'm', hint: 'Lower = highs drop off sooner in the audio' },
  { key: 'reverbStartM', label: 'Echo starts at', unit: 'm', hint: 'Reverb off the buildings begins here' },
  { key: 'reverbFullM', label: 'Echo full at', unit: 'm', hint: 'Reverb is fully mixed in here' },
  { key: 'reverbPct', label: 'Echo level', unit: '%', hint: 'Reverb send when fully mixed in' },
  { key: 'reverbDuckPct', label: 'Direct sound drop', unit: '%', hint: 'How much the direct sound fades as the echo takes over' },
];

type FleetKey = 'ambulance' | 'police';
const SPAWN_FLEETS: { key: FleetKey; label: string }[] = [
  { key: 'ambulance', label: 'Ambulances' },
  { key: 'police', label: 'Police cars' },
];

type RangeKey = 'airplane' | 'construction';
const SPAWN_RANGES: { key: RangeKey; label: string }[] = [
  { key: 'airplane', label: 'Airplanes' },
  { key: 'construction', label: 'Construction sites' },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Trims float noise from slider steps, e.g. 0.30000000000000004 -> 0.3. */
const fmt = (v: number) => String(Math.round(v * 100) / 100);

function slider(l: Limits, value: number): HTMLInputElement {
  const input = el('input');
  input.type = 'range';
  input.min = String(l.min);
  input.max = String(l.max);
  input.step = String(l.step);
  input.value = String(value);
  return input;
}

function numberInput(l: Limits, value: number): HTMLInputElement {
  const input = el('input', 'settings-number');
  input.type = 'number';
  input.min = String(l.min);
  input.max = String(l.max);
  input.step = String(l.step);
  input.value = String(value);
  return input;
}

/** One slider row: label (with an optional hint under it), slider, live value. */
function sliderRow(label: string, hint: string | null, l: Limits, value: number, show: (v: number) => string, set: (v: number) => void) {
  const row = el('div', 'settings-row');
  const name = el('div', 'settings-name', label);
  if (hint) name.append(el('div', 'settings-hint', hint));
  const input = slider(l, value);
  const out = el('div', 'settings-value', show(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    out.textContent = show(v);
  });
  row.append(name, input, out);
  return row;
}

export class SettingsWindow {
  private readonly backdrop = $('settings');
  private readonly body = $('settings-body');
  private readonly status = $('settings-status');

  constructor() {
    $('btn-settings-close').addEventListener('click', () => this.show(false));
    $('btn-settings-reset').addEventListener('click', () => {
      resetSettings();
      this.render();
      this.say('Settings reset to defaults.');
    });
    $('btn-settings-export').addEventListener('click', () => this.export());
    const file = $<HTMLInputElement>('settings-import-file');
    $('btn-settings-import').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = ''; // so picking the same file again still fires
      if (f) await this.import(f);
    });
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.show(false); // click outside the window
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.show(false);
    });
  }

  get open(): boolean {
    return !this.backdrop.classList.contains('hidden');
  }

  show(open: boolean) {
    if (open) {
      this.render();
      this.say('');
    }
    this.backdrop.classList.toggle('hidden', !open);
  }

  /** A short note beside the buttons: what export/import/reset just did. */
  private say(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  /** Downloads the current settings as a .json file. */
  private export() {
    const url = URL.createObjectURL(new Blob([exportSettings()], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = 'for-your-safety-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // some browsers start the download after click returns
    this.say('Settings exported.');
  }

  /** Loads settings from a file picked by the player; keeps the current ones if it isn't a settings file. */
  private async import(file: File) {
    try {
      importSettings(await file.text());
    } catch (err) {
      console.error('Settings import failed', err);
      this.say(`Import failed: ${err instanceof Error ? err.message : 'could not read the file.'}`, true);
      return;
    }
    this.render();
    this.say(`Imported ${file.name}.`);
  }

  /** Rebuilds the controls from the current settings. */
  private render() {
    const section = (title: string, note: string) => {
      const s = el('section', 'settings-section');
      s.append(el('div', 'section-label', title), el('div', 'muted small', note));
      this.body.append(s);
      return s;
    };
    this.body.replaceChildren();

    const vol = section('Sound levels', 'How loud each sound is in the recording. Music and interface sounds change at once; the rest from the next round.');
    for (const k of VOLUME_KEYS) {
      vol.append(
        sliderRow(VOLUME_LABELS[k], null, VOLUME_LIMITS, settings.volume[k], (v) => `${v}%`, (v) =>
          updateSettings((s) => (s.volume[k] = v)),
        ),
      );
    }

    const prop = section('Sound propagation', 'How sound travels and fades with distance. Applies from the next round.');
    for (const f of PROPAGATION_FIELDS) {
      prop.append(
        sliderRow(f.label, f.hint, PROPAGATION_LIMITS[f.key], settings.propagation[f.key], (v) => `${fmt(v)} ${f.unit}`, (v) =>
          updateSettings((s) => (s.propagation[f.key] = v)),
        ),
      );
    }

    const spawn = section('Spawn rates', 'How many of each appear in a round; for a range, each round picks a number between min and max. Ambulances and police always field their total; each round picks how many of them have their siren on, between the active min and max. The rest drive silently. Applies from the next round; a seed only replays the same round with the same settings.');
    spawn.append(
      sliderRow('Pedestrians', null, SPAWN_LIMITS.pedestrians, settings.spawn.pedestrians, (v) => String(v), (v) =>
        updateSettings((s) => (s.spawn.pedestrians = v)),
      ),
    );
    for (const f of SPAWN_FLEETS) {
      const { total, minActive, maxActive } = settings.spawn[f.key];
      // Shown as total, active min, active max; ordered min <= max <= total
      spawn.append(
        this.countsRow(f.label, SPAWN_LIMITS[f.key], ['total', 'active min', 'max'], [total, minActive, maxActive], [1, 2, 0], ([t, lo, hi]) =>
          updateSettings((s) => (s.spawn[f.key] = { total: t, minActive: lo, maxActive: hi })),
        ),
      );
    }
    for (const f of SPAWN_RANGES) {
      spawn.append(
        this.countsRow(f.label, SPAWN_LIMITS[f.key], ['min', 'max'], settings.spawn[f.key], [0, 1], ([lo, hi]) =>
          updateSettings((s) => (s.spawn[f.key] = [lo, hi])),
        ),
      );
    }
  }

  /**
   * Whole-number inputs that must stay in order: `order` lists their indices
   * from smallest to largest. Typing past a neighbour pushes it (and the ones
   * beyond it) along, so the value just typed is always kept.
   */
  private countsRow<T extends number[]>(label: string, l: Limits, names: string[], values: T, order: number[], set: (v: T) => void) {
    const row = el('div', 'settings-row');
    const name = el('div', 'settings-name', label);
    name.append(el('div', 'settings-hint', `${l.min} to ${l.max}`));
    const inputs = values.map((v) => numberInput(l, v));
    const group = el('div', 'settings-pair');
    inputs.forEach((input, i) => group.append(el('span', 'muted', names[i]), input));
    const commit = (changed: number) => {
      const clamp = (v: number) => Math.min(l.max, Math.max(l.min, Math.round(Number.isFinite(v) ? v : l.min)));
      const v = inputs.map((input) => clamp(Number(input.value)));
      const k = order.indexOf(changed);
      for (let j = k + 1; j < order.length; j++) v[order[j]] = Math.max(v[order[j]], v[order[j - 1]]);
      for (let j = k - 1; j >= 0; j--) v[order[j]] = Math.min(v[order[j]], v[order[j + 1]]);
      inputs.forEach((input, i) => (input.value = String(v[i])));
      set(v as T);
    };
    inputs.forEach((input, i) => input.addEventListener('change', () => commit(i)));
    if (inputs.length > 2) {
      group.classList.add('wide'); // needs the value column too
      row.append(name, group);
    } else row.append(name, group, el('div', 'settings-value'));
    return row;
  }
}
