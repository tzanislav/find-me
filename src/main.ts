import 'leaflet/dist/leaflet.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/share-tech-mono/400.css';
import './style.css';
import L from 'leaflet';
import { BOUNDS, dist, toLatLng, type Vec } from './geo';
import {
  CLIP_SECONDS,
  KINDS,
  PUBLIC_KINDS,
  headingAt,
  iconSvg,
  isActive,
  isMoving,
  positionAt,
  type SoundSource,
  type SourceKind,
  type Track,
} from './sources';
import { simulate, type LoopLengths, type SpectralProfiles } from './sim';
import { AUDIO_SAMPLE_RATE } from './audio/constants';
import { renderListenerAudio, type AudioAssets } from './audio/render';
import { profileLoop } from './audio/profile';
import { loadSamples } from './audio/samples';
import { loadNoiseMap } from './noisemap';
import { ClipPlayer } from './audio/player';
import { MusicPlayer } from './audio/music';
import { SpectrogramView, type Tag } from './spectrogram';
import { addBasemap } from './basemap';
import { FieldGuide } from './guide';
import { loadOsm } from './osm';
import { buildWorld, generateRound, type Round, type World } from './scenario';
import type { Pedestrian } from './pedestrians';
import { TOWER_COLOR, TOWER_RANGE_M, inRange, towerIconSvg, type Tower } from './towers';
import { emptyHtml, fullName, personHtml, targetHtml, towerHtml } from './inspector';
import { holdingIn } from './hold';
import { TitleScreen } from './title';
import { randomSeed } from './rng';
import { onSettingsChange, scenarioString, settings, updateSettings } from './settings';
import { TUTORIAL_SEED, Tutorial } from './tutorial';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- State ----------
let world: World | null = null;
let audioAssets: AudioAssets | null = null;
/** Recorded sources the spectrogram draws from their actual recording. */
let spectralProfiles: SpectralProfiles = {};
/** Loop lengths of recordings whose spectrogram is hand-drawn in step with them (police wail). */
let loopLengths: LoopLengths = {};
let round: Round | null = null;
let time = 0;
let playing = false;
let tags: Tag[] = [];
/** What the inspector shows. Indices into round.towers / round.pedestrians. */
type Selection = { kind: 'tower'; i: number } | { kind: 'person'; i: number } | null;
let selection: Selection = null;
/** People whose data (name, number, profile) a tower has revealed. Indices into round.pedestrians. */
const revealedPeds = new Set<number>();
/** People the player has marked to keep track of. Indices into round.pedestrians. */
const markedPeds = new Set<number>();
/** Set once the player arrests someone; the round is over. */
let arrested: Pedestrian | null = null;
/** Whether the current round is the tutorial's (Try again then replays the tutorial). */
let tutorialRound = false;

const ll = (v: Vec): L.LatLngExpression => {
  const p = toLatLng(v);
  return [p.lat, p.lng];
};

// ---------- Map ----------
const box = L.latLngBounds([BOUNDS.south, BOUNDS.west], [BOUNDS.north, BOUNDS.east]);
const map = L.map('map', {
  maxBounds: box.pad(0.3),
  minZoom: 14,
  maxZoom: 17,
  zoomSnap: 0.25,
  zoomControl: false,
});
/** Start this many zoom levels closer than "whole play box fits". */
const START_ZOOM_IN = 0.75;
map.setView(box.getCenter(), map.getBoundsZoom(box) + START_ZOOM_IN);
map.attributionControl.setPrefix(false).addAttribution('&copy; OpenStreetMap contributors');

map.createPane('basemap').style.zIndex = '150';
map.createPane('labels').style.zIndex = '350';

// Dim everything outside the play area, then outline it
L.polygon(
  [
    [[90, -180], [90, 180], [-90, 180], [-90, -180]],
    [[BOUNDS.south, BOUNDS.west], [BOUNDS.north, BOUNDS.west], [BOUNDS.north, BOUNDS.east], [BOUNDS.south, BOUNDS.east]],
  ],
  { stroke: false, fillColor: '#000', fillOpacity: 0.55, interactive: false },
).addTo(map);
L.rectangle(box, {
  color: '#5ad1ff',
  weight: 1.5,
  opacity: 0.7,
  fill: false,
  dashArray: '2 8',
  interactive: false,
  className: 'neon-line c-zone',
}).addTo(map);

// Ghosted landmark labels (approximate positions)
const LABELS: { text: string; lat: number; lng: number; big?: boolean }[] = [
  { text: 'SOFIA', lat: 42.7048, lng: 23.315, big: true },
  { text: 'SVETA NEDELYA', lat: 42.6972, lng: 23.3196 },
  { text: 'ALEKSANDAR NEVSKI', lat: 42.6968, lng: 23.333 },
  { text: 'SOFIA UNIVERSITY', lat: 42.693, lng: 23.335 },
  { text: 'CENTRAL MARKET HALL', lat: 42.6996, lng: 23.3205 },
  { text: 'LIONS BRIDGE', lat: 42.7058, lng: 23.324 },
  { text: 'CITY GARDEN', lat: 42.6948, lng: 23.3262 },
];
for (const l of LABELS) {
  L.marker([l.lat, l.lng], {
    pane: 'labels',
    interactive: false,
    icon: L.divIcon({ className: l.big ? 'map-label big' : 'map-label', html: `<span>${l.text}</span>`, iconSize: [0, 0] }),
  }).addTo(map);
}

// Per-kind colour classes so SVG glows (drop-shadow with currentColor) match the stroke
const kindStyle = document.createElement('style');
kindStyle.textContent =
  (Object.keys(KINDS) as SourceKind[]).map((k) => `.c-${k}{color:${KINDS[k].color}}`).join('') +
  `.c-zone{color:#5ad1ff}.c-hit{color:#ff3b5c}.c-tower{color:${TOWER_COLOR}}`;
document.head.appendChild(kindStyle);

// ---------- Source layers (rebuilt every round) ----------
// Moving sources are drawn as their vehicle icon only, with no route.
// Fixed sources (bells, construction) also get a ring marking where they are.
// Public kinds (church bells) are on the map from the start; the rest wait for their data to be bought.
const zones = L.layerGroup().addTo(map);
const rangeLayer = L.layerGroup().addTo(map);
const towerLayer = L.layerGroup().addTo(map);
const sourceLayer = L.layerGroup().addTo(map);
const pedLayer = L.layerGroup().addTo(map);
const revealLayer = L.layerGroup().addTo(map);
let sourceMarkers: L.Marker[] = [];
let towerMarkers: L.Marker[] = [];
let pedMarkers: L.Marker[] = [];
const hitLine = L.polyline([], { color: '#ff3b5c', weight: 2, className: 'neon-line c-hit', interactive: false });

/** The part of a track travelled during the clip. Used to show the target's walk on reveal. */
function routeDuringClip(tr: Track): Vec[] {
  const t0 = Math.max(0, tr.start);
  const t1 = CLIP_SECONDS;
  const s0 = (t0 - tr.start) * tr.speed;
  const s1 = (t1 - tr.start) * tr.speed;
  const pts = [positionAt(tr, t0)];
  tr.path.forEach((p, i) => {
    if (tr.cum[i] > s0 && tr.cum[i] < s1) pts.push(p);
  });
  pts.push(positionAt(tr, t1));
  return pts;
}

/** Zone rings of fixed sources, by source index. */
let zoneCircles: (L.Circle | null)[] = [];

/** Builds markers for every source, but they only go on the map once their data is bought (see showIntel). */
function buildSourceLayers(sources: SoundSource[]) {
  zones.clearLayers();
  sourceLayer.clearLayers();

  zoneCircles = sources.map((src) => {
    if (isMoving(src)) return null;
    const k = KINDS[src.kind];
    return L.circle(ll(src.path[0]), { radius: 45, color: k.color, weight: 1.5, dashArray: '3 5', fillOpacity: 0.06, className: `neon-line c-${src.kind}` })
      // A public source's tooltip names it but never says when it sounds
      .bindTooltip(PUBLIC_KINDS.has(src.kind) ? src.name : `${src.name}, active ${src.start}-${src.end}s`, { className: 'neon-tip' });
  });

  sourceMarkers = sources.map((src) =>
    L.marker(ll(positionAt(src, time)), {
      icon: L.divIcon({
        className: 'src-marker',
        html: `<div class="src-icon" style="color:${KINDS[src.kind].color}">${iconSvg(src.kind)}</div>`,
        iconSize: [28, 28],
      }),
      interactive: false,
      zIndexOffset: 1000, // keep vehicles above the pedestrian crowd
    }),
  );
}

// ---------- Energy and data access ----------
const START_ENERGY = 100;
const INTEL_HOLD_MS = 1000;
const ARREST_HOLD_MS = 2000;
/** Cell tower action: names and numbers of everyone within its range right now. */
const REVEAL_DATA_COST = 20;

interface Intel {
  label: string;
  cost: number;
  kinds: SourceKind[]; // source icons it puts on the map
  tip: string; // hover tooltip
}
const SIREN_NOTE = 'Note: not all vehicles have their sirens on.';
const INTEL: Intel[] = [
  { label: 'Access Transportation Data', cost: 10, kinds: ['tram'], tip: 'Access the data for the trams in the area.' },
  { label: 'Access Police Car Data', cost: 20, kinds: ['police'], tip: `Access the data for the police cars in the area.\n${SIREN_NOTE}` },
  { label: 'Access Ambulance Data', cost: 20, kinds: ['ambulance'], tip: `Access the data for the emergency vehicles in the area.\n${SIREN_NOTE}` },
  { label: 'Get Air Traffic Data', cost: 25, kinds: ['airplane'], tip: 'Access the flight paths of the airplanes passing over the area.' },
  { label: 'Get Construction Records', cost: 30, kinds: ['construction'], tip: 'Access the locations of the construction sites in the area.' },
];

let energy = START_ENERGY;
/** Source kinds whose data has been bought this round. Everything else stays off the map. */
const unlockedKinds = new Set<SourceKind>();

const intelButtons = INTEL.map((intel, i) => {
  const btn = document.createElement('button');
  btn.className = 'intel-btn';
  btn.dataset.hold = String(INTEL_HOLD_MS);
  btn.title = intel.tip;
  btn.innerHTML = `<span>${intel.label}</span><span class="cost">${intel.cost}</span>`;
  btn.addEventListener('hold', () => buyIntel(i));
  $('intel-buttons').appendChild(btn);
  return btn;
});

/** Spends energy if there is enough. Running low is never a fail state, it only limits what you can do. */
function spend(cost: number): boolean {
  if (energy < cost) return false;
  energy -= cost;
  renderEnergy();
  return true;
}

function renderEnergy() {
  $('energy-value').textContent = String(energy);
  $('energy-fill').style.width = `${(100 * energy) / START_ENERGY}%`;
  INTEL.forEach((intel, i) => {
    const owned = intel.kinds.every((k) => unlockedKinds.has(k));
    const btn = intelButtons[i];
    btn.disabled = owned || energy < intel.cost;
    btn.classList.toggle('owned', owned);
    btn.querySelector('.cost')!.textContent = owned ? 'Acquired' : String(intel.cost);
  });
  $('siren-note').hidden = !(unlockedKinds.has('police') || unlockedKinds.has('ambulance'));
}

renderEnergy();

function buyIntel(i: number) {
  const intel = INTEL[i];
  if (!round || intel.kinds.every((k) => unlockedKinds.has(k)) || !spend(intel.cost)) return;
  intel.kinds.forEach((k) => unlockedKinds.add(k));
  showIntel();
  renderEnergy();
}

/** Puts the markers and zone rings of unlocked and public kinds on the map. */
function showIntel() {
  if (!round) return;
  round.sources.forEach((src, i) => {
    if (!unlockedKinds.has(src.kind) && !PUBLIC_KINDS.has(src.kind)) return;
    if (!sourceLayer.hasLayer(sourceMarkers[i])) sourceMarkers[i].addTo(sourceLayer);
    const zone = zoneCircles[i];
    if (zone && !zones.hasLayer(zone)) zone.addTo(zones);
  });
  setTime(time); // fresh marker elements need their state classes
}

// ---------- Cell towers ----------
let hoverRange: L.Circle | null = null;
let selectedRange: L.Circle | null = null;

function rangeCircle(t: Tower): L.Circle {
  return L.circle(ll(t.pos), {
    radius: TOWER_RANGE_M,
    color: TOWER_COLOR,
    weight: 1.5,
    dashArray: '8 7',
    fillColor: TOWER_COLOR,
    fillOpacity: 0.06,
    interactive: false,
    className: 'neon-line c-tower',
  });
}

function hideHoverRange() {
  hoverRange?.remove();
  hoverRange = null;
}

function showHoverRange(i: number) {
  hideHoverRange();
  if (!round || (selection?.kind === 'tower' && selection.i === i)) return; // already drawn
  hoverRange = rangeCircle(round.towers[i]).addTo(rangeLayer);
}

function buildTowerLayer(towers: Tower[]) {
  towerLayer.clearLayers();
  rangeLayer.clearLayers();
  hoverRange = selectedRange = null;
  towerMarkers = towers.map((t, i) =>
    L.marker(ll(t.pos), {
      icon: L.divIcon({ className: 'tower-marker', html: `<div class="tower-icon">${towerIconSvg(24)}</div>`, iconSize: [24, 24] }),
      zIndexOffset: 500, // over people, under vehicles
    })
      .bindTooltip(t.id, { className: 'neon-tip', direction: 'top', offset: [0, -12] })
      .on('mouseover', () => showHoverRange(i))
      .on('mouseout', hideHoverRange)
      .on('click', () => select({ kind: 'tower', i }))
      .addTo(towerLayer),
  );
}

/** Pedestrians within range of tower `ti` right now, sorted by ID. Overlapping towers share people. */
function connectedTo(ti: number): number[] {
  if (!round) return [];
  const { pedestrians, towers } = round;
  return pedestrians
    .map((_, i) => i)
    .filter((i) => inRange(towers[ti], positionAt(pedestrians[i], time)))
    .sort((a, b) => pedestrians[a].id.localeCompare(pedestrians[b].id));
}

// ---------- Pedestrians ----------
// Everyone is on the map; only their data (name, number, profile) is locked.
function buildPedestrianLayer(people: Pedestrian[]) {
  pedLayer.clearLayers();
  pedMarkers = people.map((p, i) =>
    L.marker(ll(positionAt(p, time)), {
      icon: L.divIcon({ className: 'ped', html: '<span class="ped-dot"></span>', iconSize: [14, 14] }),
      riseOnHover: true,
    })
      .bindTooltip(p.id, { className: 'neon-tip ped-tip', direction: 'top', offset: [0, -6] })
      .on('click', () => select({ kind: 'person', i }))
      .addTo(pedLayer),
  );
}

/** Marker highlight classes follow the state; markers that are off the map have no element. */
function syncMarkerClasses() {
  if (!round) return;
  const { pedestrians, target } = round;
  pedMarkers.forEach((m, i) => {
    const el = m.getElement();
    if (!el) return;
    const p = pedestrians[i];
    el.classList.toggle('selected', (selection?.kind === 'person' && selection.i === i) || p === arrested);
    el.classList.toggle('target', arrested !== null && p === target);
    el.classList.toggle('marked', markedPeds.has(i));
  });
  towerMarkers.forEach((m, i) => m.getElement()?.classList.toggle('selected', selection?.kind === 'tower' && selection.i === i));
}

// ---------- Inspector ----------
const inspectorEl = $('inspector');
/** What the inspector last drew, so live updates only redraw when the content changes. */
let inspectorKey = '';

function renderInspector(force = false) {
  if (!force && holdingIn(inspectorEl)) return; // don't swap a button out from under a hold
  if (!round || !selection) {
    inspectorEl.innerHTML = emptyHtml();
    inspectorKey = '';
    return;
  }
  if (selection.kind === 'person') {
    const revealed = revealedPeds.has(selection.i);
    const marked = markedPeds.has(selection.i);
    const key = `p${selection.i}:${revealed}:${marked}:${arrested !== null}`;
    if (!force && key === inspectorKey) return;
    inspectorEl.innerHTML = personHtml(round.pedestrians[selection.i], revealed, marked, arrested === null, ARREST_HOLD_MS);
    inspectorKey = key;
    return;
  }
  // Tower: who is connected changes as people walk, so this redraws during playback
  const connected = connectedTo(selection.i);
  const allRevealed = connected.every((i) => revealedPeds.has(i));
  const canAfford = energy >= REVEAL_DATA_COST;
  const key = `t${selection.i}:${connected.join(',')}:${allRevealed}:${canAfford}`;
  if (!force && key === inspectorKey) return;
  const sameTower = inspectorKey.startsWith(`t${selection.i}:`);
  const scroll = inspectorEl.querySelector('.conn-list')?.scrollTop ?? 0;
  inspectorEl.innerHTML = towerHtml(round.towers[selection.i], {
    connected: connected.map((i) => ({ i, p: round!.pedestrians[i], revealed: revealedPeds.has(i), marked: markedPeds.has(i) })),
    revealCost: REVEAL_DATA_COST,
    holdMs: INTEL_HOLD_MS,
    canAfford,
  });
  if (sameTower) inspectorEl.querySelector('.conn-list')!.scrollTop = scroll;
  inspectorKey = key;
}

function select(sel: Selection) {
  selection = sel;
  selectedRange?.remove();
  selectedRange = null;
  if (round && sel?.kind === 'tower') {
    hideHoverRange();
    selectedRange = rangeCircle(round.towers[sel.i]).addTo(rangeLayer);
  }
  syncMarkerClasses();
  renderInspector(true);
}

/** Marks or unmarks a person: a free note for the player that highlights them on the map. */
function toggleMark(i: number) {
  if (!round) return;
  const marked = !markedPeds.delete(i);
  if (marked) markedPeds.add(i);
  // Marked people sit above the crowd so they don't vanish in a cluster
  pedMarkers[i].setZIndexOffset(marked ? 300 : 0);
  syncMarkerClasses();
  renderInspector(true);
}

inspectorEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-ped]');
  if (!el || !round) return;
  if (el.dataset.ped !== undefined) select({ kind: 'person', i: Number(el.dataset.ped) });
  else if (el.dataset.action === 'mark' && selection?.kind === 'person') toggleMark(selection.i);
});
// Hold-to-confirm actions (see hold.ts): revealing user data costs energy, arresting is free
inspectorEl.addEventListener('hold', (e) => {
  const el = e.target as HTMLElement;
  if (!round) return;
  if (el.dataset.action === 'reveal-data' && selection?.kind === 'tower') {
    const hidden = connectedTo(selection.i).filter((i) => !revealedPeds.has(i));
    if (hidden.length === 0 || !spend(REVEAL_DATA_COST)) return;
    hidden.forEach((i) => revealedPeds.add(i));
    renderInspector(true);
  } else if (el.dataset.action === 'arrest' && selection?.kind === 'person') {
    arrest(round.pedestrians[selection.i]);
  }
});

map.on('click', () => select(null));

// Legend
$('legend').innerHTML =
  (Object.keys(KINDS) as SourceKind[])
    .map((k) => `<div class="legend-item" style="color:${KINDS[k].color}">${iconSvg(k, 18)}<span>${KINDS[k].label}</span></div>`)
    .join('') +
  `<div class="legend-item" style="color:${TOWER_COLOR}">${towerIconSvg(18)}<span>Cell tower</span></div>` +
  '<div class="legend-item" style="color:#fff"><span class="legend-dot"></span><span>Pedestrian</span></div>' +
  '<div class="legend-item mark-legend"><span class="mark-glyph">◆</span><span>Marked</span></div>';

// Field guide: Doppler toy and reference sirens, for learning to read the spectrogram
new FieldGuide($('guide'));

// ---------- Spectrogram ----------
const spectro = new SpectrogramView(
  $<HTMLCanvasElement>('spectro'),
  (t) => {
    setPlaying(false);
    setTime(t);
  },
  settings.display.logFrequency,
);
const logToggle = $<HTMLInputElement>('toggle-log-freq');
logToggle.checked = settings.display.logFrequency;
logToggle.addEventListener('change', () => updateSettings((s) => (s.display.logFrequency = logToggle.checked)));
// Also follows a settings reset or import
onSettingsChange(() => {
  logToggle.checked = settings.display.logFrequency;
  spectro.setLogFrequency(settings.display.logFrequency);
});

// ---------- Rounds ----------
// ---------- Loading overlay ----------
const loadingEl = $('loading');
const loadingStatus = $('loading-status');

function setLoading(status: string | null) {
  loadingEl.classList.toggle('hidden', status === null);
  if (status !== null) loadingStatus.textContent = status;
}

// ---------- Mission result overlay ----------
/** Shows the end-of-round banner (true = completed, false = failed), or hides it with null. */
function showMission(success: boolean | null) {
  $('mission').classList.toggle('hidden', success === null);
  if (success === null) return;
  const title = $('mission-title');
  title.textContent = success ? 'Mission completed' : 'Mission failed';
  title.classList.toggle('ok', success);
  title.classList.toggle('fail', !success);
  $('mission-seed-value').textContent = roundString;
  copySeedBtn.textContent = 'Copy seed';
}

/** The round's seed with the settings it was dealt with, to share (see scenarioString). */
let roundString = '';
const seedLabel = $('seed-label');
const copySeedBtn = $<HTMLButtonElement>('btn-mission-copy-seed');

/** Copies the round's string; `show` gets the outcome, then null after a moment to restore its label. */
function copyRoundString(show: (copied: boolean | null) => void) {
  let resetTimer = 0;
  return async () => {
    if (!roundString) return;
    let ok = true;
    try {
      await navigator.clipboard.writeText(roundString);
    } catch (err) {
      console.error('Copying the seed failed', err);
      ok = false;
    }
    show(ok);
    clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => show(null), 1500);
  };
}
copySeedBtn.addEventListener(
  'click',
  copyRoundString((ok) => (copySeedBtn.textContent = ok === null ? 'Copy seed' : ok ? 'Copied' : 'Copy failed')),
);
seedLabel.addEventListener(
  'click',
  copyRoundString((ok) => (seedLabel.textContent = ok === null ? `Seed ${roundString}` : ok ? 'Seed copied' : 'Copy failed')),
);

$('btn-mission-hide').addEventListener('click', () => showMission(null));
$('btn-mission-retry').addEventListener('click', () => void (tutorialRound ? startTutorial() : newRound()));
$('btn-mission-menu').addEventListener('click', () => {
  setPlaying(false);
  showMission(null);
  tutorialGuide.stop();
  title.show();
});

/** Let the browser paint (e.g. the loading overlay) before the next heavy step. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

let building = false;

/**
 * Deals the round for `seed`; the same seed always gives the same round.
 * `tutorial` marks it as the tutorial's round. Returns false if a round was already being built.
 */
async function newRound(seed = randomSeed(), tutorial = false): Promise<boolean> {
  if (!world || building) return false;
  building = true;
  setPlaying(false);
  if (!tutorial) tutorialGuide.stop();
  try {
    const minutes = Math.round(CLIP_SECONDS / 60);
    const step = async (status: string) => {
      setLoading(status);
      await nextPaint();
    };
    const timed = <T,>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const out = fn();
      console.info(`${label} in ${Math.round(performance.now() - t0)} ms`);
      return out;
    };

    await step('Generating traffic and people');
    const nextString = scenarioString(seed); // the settings this round is dealt with
    const next =timed('Round generated', () => generateRound(world!, seed));
    await step(`Simulating ${minutes} minutes of city sound`);
    const spec = timed('Spectrogram simulated', () => simulate(next.sources, next.target, seed, spectralProfiles, loopLengths, audioAssets?.noiseMap ?? null));
    let audio: Float32Array | null = null;
    if (audioAssets) {
      await step('Rendering the recording');
      audio = timed('Audio rendered', () => renderListenerAudio(next.sources, next.target, seed, audioAssets!));
    }

    round = next;
    roundString = nextString;
    seedLabel.textContent = `Seed ${roundString}`;
    tutorialRound = tutorial;
    arrested = null;
    revealedPeds.clear();
    markedPeds.clear();
    unlockedKinds.clear();
    energy = START_ENERGY;
    renderEnergy();
    showMission(null);
    $('target').innerHTML = targetHtml(round.target, round.clues);
    tags = [];
    revealLayer.clearLayers();
    time = 0;
    buildSourceLayers(round.sources);
    buildTowerLayer(round.towers);
    buildPedestrianLayer(round.pedestrians);
    select(null);
    $('result').textContent = '';
    spectro.setTags(tags);
    spectro.setData(spec);
    if (audio) player.setSamples(audio);
    showIntel(); // public sources (churches) are known from the start; also syncs time to 0
    console.info(`Round seed ${roundString}. ${round.pedestrians.length} pedestrians, ${round.sources.length} sources.`);
    return true;
  } finally {
    building = false;
    setLoading(null);
  }
}

function arrest(suspect: Pedestrian) {
  if (!round || arrested) return;
  arrested = suspect;
  const { target, pedestrians } = round;
  const correct = suspect === target;

  // The case is closed: both files are opened
  revealedPeds.add(pedestrians.indexOf(target));
  revealedPeds.add(pedestrians.indexOf(suspect));
  syncMarkerClasses();
  renderInspector(true);
  // Where the target actually walked during the clip
  if (isMoving(target)) {
    L.polyline(routeDuringClip(target).map(ll), {
      color: '#ff3b5c',
      weight: 2,
      dashArray: '4 5',
      className: 'neon-line c-hit',
      interactive: false,
    }).addTo(revealLayer);
  }
  if (!correct) hitLine.addTo(revealLayer);

  const d = dist(positionAt(suspect, time), positionAt(target, time));
  $('result').innerHTML = correct
    ? `<b class="win">TARGET ARRESTED</b><br>${fullName(target)} (${target.id}) it is.`
    : `<b class="hot">WRONG PERSON</b><br>You arrested ${fullName(suspect)}. The target was ${fullName(target)} (${target.id}), ${Math.round(d)} m away at ${time.toFixed(0)}s.`;
  setTime(time);
  showMission(correct);
}

// ---------- Time ----------
function setTime(t: number) {
  time = t;
  $('time-readout').textContent = `${t.toFixed(1).padStart(4, '0')} s`;
  spectro.setTime(t);
  if (!round) return;

  round.sources.forEach((src, i) => {
    const marker = sourceMarkers[i];
    marker.setLatLng(ll(positionAt(src, t)));
    const el = marker.getElement();
    if (!el) return;
    const active = isActive(src, t);
    // Vehicles exist only between spawn and arrival; fixed sources just dim when silent,
    // except public ones (churches), whose icon must not give away when they ring.
    el.classList.toggle('despawned', isMoving(src) && !active);
    el.classList.toggle('inactive', !isMoving(src) && !active && !PUBLIC_KINDS.has(src.kind));
    if (src.kind === 'airplane') {
      (el.firstElementChild as HTMLElement).style.transform = `rotate(${headingAt(src, t)}deg)`;
    }
  });

  round.pedestrians.forEach((p, i) => pedMarkers[i].setLatLng(ll(positionAt(p, t))));

  if (arrested && arrested !== round.target) {
    hitLine.setLatLngs([ll(positionAt(arrested, t)), ll(positionAt(round.target, t))]);
  }
  // A selected tower's connected list follows people as they walk between towers
  if (selection?.kind === 'tower') renderInspector();
}

let lastFrame = 0;
// What the target heard, played in sync with the timeline
const player = new ClipPlayer();
// Background music, loops from the first click or key press
const music = new MusicPlayer();

function setPlaying(p: boolean) {
  playing = p;
  $('btn-play').textContent = p ? 'Pause' : 'Play';
  if (p) {
    if (time >= CLIP_SECONDS) setTime(0);
    player.play(time);
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  } else {
    player.stop();
  }
}
function tick(now: number) {
  if (!playing) return;
  // The audio is the clock while it plays; frame time is the fallback
  const t = player.position ?? time + (now - lastFrame) / 1000;
  lastFrame = now;
  if (t >= CLIP_SECONDS) {
    setTime(CLIP_SECONDS);
    setPlaying(false);
    return;
  }
  setTime(t);
  requestAnimationFrame(tick);
}

// ---------- Controls ----------
const tagSelect = $<HTMLSelectElement>('tag-kind');
tagSelect.innerHTML = (Object.keys(KINDS) as SourceKind[]).map((k) => `<option value="${k}">${KINDS[k].label}</option>`).join('');

function addTag() {
  tags = [...tags, { t: time, kind: tagSelect.value as SourceKind }];
  spectro.setTags(tags);
}

$('btn-play').addEventListener('click', () => setPlaying(!playing));
$<HTMLInputElement>('toggle-sound').addEventListener('change', (e) => player.setMuted(!(e.target as HTMLInputElement).checked));
$<HTMLInputElement>('toggle-music').addEventListener('change', (e) => music.setMuted(!(e.target as HTMLInputElement).checked));
$('btn-tag').addEventListener('click', addTag);
$('btn-clear-tags').addEventListener('click', () => {
  tags = [];
  spectro.setTags(tags);
});

$<HTMLInputElement>('toggle-paths').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) zones.addTo(map);
  else zones.remove();
});

$('btn-new').addEventListener('click', () => void newRound());
$('btn-zoom-in').addEventListener('click', () => spectro.zoomIn());
$('btn-zoom-out').addEventListener('click', () => spectro.zoomOut());
$('btn-zoom-fit').addEventListener('click', () => spectro.resetZoom());

window.addEventListener('keydown', (e) => {
  if (title.visible) return; // game hotkeys are off on the title screen
  if (tutorialGuide.blocking) return; // and while a tutorial step explains the screen
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser zoom shortcuts alone
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.key.toLowerCase() === 't') {
    addTag();
  } else if (e.key.toLowerCase() === 'm' && selection?.kind === 'person') {
    toggleMark(selection.i);
  } else if (e.key === '+' || e.key === '=') {
    spectro.zoomIn();
  } else if (e.key === '-') {
    spectro.zoomOut();
  } else if (e.key === '0') {
    spectro.resetZoom();
  }
});

// ---------- Boot ----------
// Downloads start straight away, while the title and intro are on screen;
// building the world and the first round waits for the intro's Start button.
const osmData = loadOsm();
osmData.catch(() => {}); // reported by boot() once it awaits it
const noiseMapData = loadNoiseMap().catch((err) => {
  console.error('Noise map failed to load, traffic bed uses a flat level', err);
  return null;
});
const sampleData = loadSamples().catch((err) => {
  console.error('Sound samples failed to load, the clip will be silent', err);
  return null;
});

async function boot(seed: number, tutorial = false): Promise<boolean> {
  setLoading('Loading map data');
  const osm = await osmData;
  setLoading('Loading sounds');
  addBasemap(map, 'basemap', osm).catch((err) => console.error('Basemap failed to render', err));
  world = buildWorld(osm);
  const bank = await sampleData;
  if (bank) {
    audioAssets = { samples: bank, noiseMap: await noiseMapData };
    spectralProfiles = {
      construction: profileLoop(bank.construction),
      city: profileLoop(bank.city),
      traffic: profileLoop(bank.traffic),
      bell: profileLoop(bank.bell, true),
    };
    loopLengths = { police: bank.police.length / AUDIO_SAMPLE_RATE };
  }
  console.info(
    `Graphs: road ${world.road.nodes.length}, tram ${world.tram.nodes.length}, walk ${world.walk.nodes.length} nodes.`,
  );
  return newRound(seed, tutorial);
}

let booted = false;

/** The first call loads everything, after that it only deals the round. Resolves true once the round is up. */
async function play(seed: number, tutorial = false): Promise<boolean> {
  if (booted) return newRound(seed, tutorial);
  booted = true;
  try {
    return await boot(seed, tutorial);
  } catch (err) {
    console.error(err);
    $('result').textContent = 'Failed to load map data. See console.';
    setLoading('Failed to load. See console.');
    return false;
  }
}

/**
 * The intro's Start button. Uses the seed typed on the title screen, or a
 * random one if the field is empty.
 */
function startGame() {
  const scenario = title.scenario;
  // A shared string brings its settings along; they replace the player's own
  if (scenario?.settings) updateSettings(scenario.settings);
  void play(scenario?.seed ?? randomSeed());
}

// ---------- Tutorial ----------
const tutorialGuide = new Tutorial({
  spectro,
  tramsUnlocked: () => unlockedKinds.has('tram'),
  marked: () => (round ? [...markedPeds].map((i) => round!.pedestrians[i].id) : []),
  selectedPerson: () => (round && selection?.kind === 'person' ? round.pedestrians[selection.i].id : null),
  targetId: () => round?.target.id ?? null,
  targetInTowerRange: () => {
    if (!round) return false;
    const p = positionAt(round.target, time);
    return round.towers.some((t) => inRange(t, p));
  },
  targetRevealed: () => !!round && revealedPeds.has(round.pedestrians.indexOf(round.target)),
  arrestResult: () => (round && arrested ? arrested === round.target : null),
});

/** The title's Tutorial button, and Try again after the tutorial: deals the tutorial's round, then starts the briefing. */
async function startTutorial() {
  tutorialGuide.stop();
  if (await play(TUTORIAL_SEED, true)) tutorialGuide.start();
}

const title = new TitleScreen(startGame, () => void startTutorial());
