import 'leaflet/dist/leaflet.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/share-tech-mono/400.css';
import './style.css';
import L from 'leaflet';
import { BOUNDS, toLatLng, type Vec } from './geo';
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
import type { LoopLengths, SpectralProfiles } from './sim';
import { computeRound, setRoundAssets } from './round-compute';
import { AUDIO_SAMPLE_RATE } from './audio/constants';
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
import { genderLabel, personHtml, targetHtml, towerHtml } from './inspector';
import { holdingIn, type HoldMs } from './hold';
import { isMobile, onMobileChange } from './mobile';
import { Trays } from './trays';
import { SpectroScrollbar } from './spectro-scrollbar';
import { closePopups, popup } from './popup';
import { menuIcon, musicIcon, pauseIcon, playIcon, soundIcon, tagIcon } from './ui-icons';
import { TitleScreen } from './title';
import { randomSeed } from './rng';
import {
  borrowSettings,
  loadDefaultSettings,
  onSettingsChange,
  parseScenario,
  restoreOwnSettings,
  scenarioString,
  settings,
} from './settings';
import { TUTORIAL_CANDIDATES, TUTORIAL_REMOVED, TUTORIAL_SCENARIO, Tutorial, type PeopleHighlight } from './tutorial';
import { prepareTutorialRound, type TutorialPlan } from './tutorial-round';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- State ----------
let world: World | null = null;
/** Recorded sources the spectrogram draws from their actual recording. */
let spectralProfiles: SpectralProfiles = {};
/** Loop lengths of recordings whose spectrogram is hand-drawn in step with them (police wail). */
let loopLengths: LoopLengths = {};
let round: Round | null = null;
/** The tutorial round's tram passes and decoy, null outside the tutorial. */
let tutorialPlan: TutorialPlan | null = null;
/** People the tutorial rings on the map right now. */
let tutorialRing: PeopleHighlight | null = null;
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
// Top right, above the inspector: the bottom right is the minimized tutorial's tab
map.attributionControl.setPrefix(false).addAttribution('&copy; OpenStreetMap contributors').setPosition('topright');

map.createPane('basemap').style.zIndex = '150';
map.createPane('labels').style.zIndex = '350';
// People sit above every icon (vehicles, towers, churches: markerPane, 600) and under tooltips (650)
map.createPane('people').style.zIndex = '640';
// People's ID tooltips sit just under the people, so a highlight ring is never covered by a neighbour's tooltip
map.createPane('peopleTips').style.zIndex = '630';

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
/** Hold-to-confirm times. Shorter on mobile, where some browsers take a long press for a right click. */
const INTEL_HOLD_MS: HoldMs = { desktop: 1000, mobile: 500 };
const ARREST_HOLD_MS: HoldMs = { desktop: 2000, mobile: 900 };
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
  btn.dataset.hold = String(INTEL_HOLD_MS.desktop);
  btn.dataset.holdMobile = String(INTEL_HOLD_MS.mobile);
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
      icon: L.divIcon({ className: 'ped', html: '<span class="ped-hit"></span><span class="ped-dot"></span>', iconSize: [14, 14] }),
      pane: 'people',
      riseOnHover: true,
    })
      .bindTooltip(p.id, { className: 'neon-tip ped-tip', direction: 'top', offset: [0, -6], pane: 'peopleTips' })
      .on('click', () => select({ kind: 'person', i }))
      .addTo(pedLayer),
  );
  nearbyTips.clear();
}

// ---------- ID tooltips near the cursor ----------
/** People within this many metres of the mouse show their ID without hovering them. */
const NEARBY_TIP_RADIUS_M = 50;
let mouseLatLng: L.LatLng | null = null;
const nearbyTips = new Set<number>();

/** Opens the tooltips of marked people and people near the cursor, and closes the rest. Only touches markers whose state changes. */
function syncNearbyTips() {
  const near = new Set<number>(markedPeds);
  if (mouseLatLng && !isMobile()) { // no hover on touch
    pedMarkers.forEach((m, i) => {
      if (mouseLatLng!.distanceTo(m.getLatLng()) <= NEARBY_TIP_RADIUS_M) near.add(i);
    });
  }
  for (const i of nearbyTips) if (!near.has(i)) pedMarkers[i]?.closeTooltip();
  // Hovering a marker and leaving it closes its tooltip, so check the real state rather than our set
  for (const i of near) if (!pedMarkers[i].isTooltipOpen()) pedMarkers[i].openTooltip();
  nearbyTips.clear();
  near.forEach((i) => nearbyTips.add(i));
}

map.on('mousemove', (e: L.LeafletMouseEvent) => {
  mouseLatLng = e.latlng;
  syncNearbyTips();
});
map.on('mouseout', () => {
  mouseLatLng = null;
  syncNearbyTips();
});

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
    const ringed = !!tutorialRing?.ids.includes(p.id);
    el.classList.toggle('tut-hint', ringed && tutorialRing!.tone === 'hint');
    el.classList.toggle('tut-wrong', ringed && tutorialRing!.tone === 'wrong');
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
    inspectorEl.innerHTML = '';
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

// Trays on the map edge: target and tools. On mobile they start closed and
// one at a time; an outside press closes them, but not in the middle of a hold
// or on the tutorial (it opens the tray a step explains).
const trays = new Trays((target) => holdingIn(document.body) || !!target.closest?.('.tutorial'));
trays.exclusive = isMobile();
trays.reset();

/**
 * The inspector shows only while something is selected. On mobile an open Target or
 * Tools tray would cover it, so it steps aside until the tray closes.
 */
const sidePanel = $('side');
function syncSidePanel() {
  const coveredByTray = isMobile() && trays.anyOpen(['target', 'tools']);
  sidePanel.classList.toggle('hidden', !selection || coveredByTray);
}
trays.onChange(syncSidePanel);

onMobileChange((mobile) => {
  trays.exclusive = mobile;
  trays.reset();
  syncSidePanel();
  syncNearbyTips();
});

function select(sel: Selection) {
  selection = sel;
  if (sel && isMobile()) trays.closeAll(); // the inspector takes over
  syncSidePanel();
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
  syncNearbyTips();
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

// Field guide: Doppler toy and reference sirens, for learning to read the spectrogram.
// An overlay on the map behind the bottom bar's ? button.
new FieldGuide($('guide'));
const guidePopup = popup($('btn-guide'), $('guide-overlay'));
$('btn-guide-close').addEventListener('click', () => guidePopup.close());

// ---------- Spectrogram ----------
const spectro = new SpectrogramView(
  $<HTMLCanvasElement>('spectro'),
  (t) => {
    setPlaying(false);
    setTime(t);
  },
  settings.display.logFrequency,
);
new SpectroScrollbar($('spectro-scroll'), spectro);
// The log frequency scale is set in Settings (also follows a reset or import)
onSettingsChange(() => spectro.setLogFrequency(settings.display.logFrequency));

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
/** The round's seed, for Restart. */
let roundSeed = 0;
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
/** Leaves the round for the title screen. */
function toMainMenu() {
  setPlaying(false);
  showMission(null);
  tutorialGuide.stop();
  restoreOwnSettings(); // a shared string's or the tutorial's settings were only for that round
  title.show();
}
$('btn-mission-menu').addEventListener('click', toMainMenu);

// Game menu (burger, bottom left): restart this round from the start, or leave for the title
const gameMenu = $('game-menu');
const menuPopup = popup($('btn-menu'), gameMenu);
$('btn-menu').innerHTML = menuIcon(20);
gameMenu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-menu]')?.dataset.menu;
  if (!action) return;
  menuPopup.close();
  if (action === 'main') toMainMenu();
  else if (tutorialRound) void startTutorial();
  else void newRound(roundSeed, false, true); // same seed and settings: the same round again
});

/** Let the browser paint (e.g. the loading overlay) before the next heavy step. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** How long the title screen takes to fade out (#title-screen's transition in style.css). */
const TITLE_FADE_MS = 400;

/**
 * Leaving the title for a round: puts the loading screen up at once, then waits out the
 * title's fade, so the page doesn't freeze on a half-faded title while the round is built.
 */
async function showLoadingFromTitle() {
  setLoading('Preparing');
  await nextPaint();
  await new Promise((resolve) => setTimeout(resolve, TITLE_FADE_MS));
}

let building = false;

/**
 * Deals the round for `seed`; the same seed always gives the same round.
 * `tutorial` marks it as the tutorial's round. `keepSettings` deals it with the
 * live settings even if they are borrowed (the tutorial's, a shared string's, or a
 * restart of the same round); otherwise the player's own come back first.
 * Returns false if a round was already being built.
 */
async function newRound(seed = randomSeed(), tutorial = false, keepSettings = tutorial): Promise<boolean> {
  if (!world || building) return false;
  building = true;
  setPlaying(false);
  if (!tutorial) tutorialGuide.stop();
  if (!keepSettings) restoreOwnSettings(); // borrowed settings were only for their round
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
    const next = timed('Round generated', () => generateRound(world!, seed));
    // The tutorial's round has its crowd thinned around the tram passes it teaches with
    const plan = tutorial ? prepareTutorialRound(next, TUTORIAL_CANDIDATES, TUTORIAL_REMOVED) : null;
    await step(`Simulating ${minutes} minutes of city sound`);
    // In a worker (round-compute.ts): this is the slow part, tens of seconds on a phone
    const { spec, audio } = await computeRound(next.sources, next.target, seed, spectralProfiles, loopLengths, () =>
      setLoading('Rendering the recording'),
    );

    round = next;
    tutorialPlan = plan;
    tutorialRing = null;
    roundString = nextString;
    roundSeed = seed;
    seedLabel.textContent = `Seed ${roundString}`;
    tutorialRound = tutorial;
    arrested = null;
    revealedPeds.clear();
    markedPeds.clear();
    unlockedKinds.clear();
    energy = START_ENERGY;
    renderEnergy();
    showMission(null);
    trays.reset();
    $('target').innerHTML = targetHtml(round.target, round.clues);
    tags = [];
    revealLayer.clearLayers();
    time = 0;
    buildSourceLayers(round.sources);
    buildTowerLayer(round.towers);
    buildPedestrianLayer(round.pedestrians);
    select(null);
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
  syncNearbyTips(); // people walk into and out of the cursor's radius; marked tips reopen after a hover closes them

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

const playBtn = $('btn-play');
function setPlaying(p: boolean) {
  playing = p;
  playBtn.innerHTML = p ? pauseIcon(26) : playIcon(26);
  playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  playBtn.title = p ? 'Pause (Space)' : 'Play (Space)';
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
// Tag picker: the tag button opens a list of source kinds; picking one tags the playhead
const tagPicker = $('tag-picker');
tagPicker.innerHTML =
  (Object.keys(KINDS) as SourceKind[])
    .map((k) => `<button class="bar-option tag-option" data-kind="${k}" style="color:${KINDS[k].color}">${iconSvg(k, 18)}<span>${KINDS[k].label}</span></button>`)
    .join('') + '<button class="bar-option tag-option tag-clear" data-clear>Clear tags</button>';
const tagPopup = popup($('btn-tag'), tagPicker);
$('btn-tag').innerHTML = tagIcon(20);
tagPicker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tag-option');
  if (!btn) return;
  tags = btn.dataset.kind ? [...tags, { t: time, kind: btn.dataset.kind as SourceKind }] : [];
  spectro.setTags(tags);
  tagPopup.close();
});

playBtn.addEventListener('click', () => setPlaying(!playing));
setPlaying(false); // draws the play icon

/** An icon button that toggles on and off; `onChange` gets the new state. */
function iconToggle(id: string, icon: string, onChange: (on: boolean) => void) {
  const btn = $(id);
  btn.innerHTML = icon;
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    onChange(on);
  });
}
iconToggle('toggle-sound', soundIcon(20), (on) => player.setMuted(!on));
iconToggle('toggle-music', musicIcon(20), (on) => music.setMuted(!on));

$<HTMLInputElement>('toggle-paths').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) zones.addTo(map);
  else zones.remove();
});

$('btn-new').addEventListener('click', () => void newRound());

window.addEventListener('keydown', (e) => {
  if (title.visible) return; // game hotkeys are off on the title screen
  if (tutorialGuide.blocking) return; // and while a tutorial step explains the screen
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser zoom shortcuts alone
  if (e.key === 'Escape') {
    closePopups();
  } else if (e.code === 'Space') {
    e.preventDefault();
    // Space on a focused bar button would also click it
    (document.activeElement as HTMLElement | null)?.blur();
    setPlaying(!playing);
  } else if (e.key.toLowerCase() === 't') {
    tagPopup.toggle();
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
const defaultsReady = loadDefaultSettings();
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

async function boot(seed: number, tutorial = false, keepSettings = tutorial): Promise<boolean> {
  setLoading('Loading map data');
  await nextPaint();
  const osm = await osmData;
  setLoading('Building the city');
  await nextPaint(); // building the world blocks the page for a moment
  addBasemap(map, 'basemap', osm).catch((err) => console.error('Basemap failed to render', err));
  world = buildWorld(osm);
  setLoading('Loading sounds');
  await nextPaint();
  const bank = await sampleData;
  if (bank) {
    setRoundAssets({ samples: bank, noiseMap: await noiseMapData });
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
  return newRound(seed, tutorial, keepSettings);
}

let booted = false;

/** The first call loads everything, after that it only deals the round. Resolves true once the round is up. */
async function play(seed: number, tutorial = false, keepSettings = tutorial): Promise<boolean> {
  if (booted) return newRound(seed, tutorial, keepSettings);
  booted = true;
  try {
    return await boot(seed, tutorial, keepSettings);
  } catch (err) {
    console.error(err);
    setLoading('Failed to load. See console.');
    return false;
  }
}

/**
 * The intro's Start button. Uses the seed typed on the title screen, or a
 * random one if the field is empty.
 */
async function startGame() {
  const scenario = title.scenario;
  await showLoadingFromTitle();
  await defaultsReady; // so the defaults file can't land on top of a shared string's settings
  // A shared string brings its settings along, for its round only: the player's own stay saved
  if (scenario?.settings) borrowSettings(scenario.settings);
  void play(scenario?.seed ?? randomSeed(), false, !!scenario?.settings);
}

// ---------- Tutorial ----------
const tutorialGuide = new Tutorial({
  spectro,
  trays,
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
  time: () => time,
  plan: () => tutorialPlan,
  targetFacts: () => {
    if (!round) return '';
    const { profile } = round.target;
    const facts: Record<string, string> = {
      sex: `Gender: ${genderLabel(profile.sex)}.`,
      age: `Age: ${profile.age}.`,
      occupation: `Occupation: ${profile.occupation}.`,
    };
    return round.clues.map((c) => facts[c]).join(' ');
  },
  highlight: (people) => {
    const key = (h: PeopleHighlight | null) => (h ? `${h.tone}:${h.ids.join(',')}` : '');
    if (key(people) === key(tutorialRing)) return;
    tutorialRing = people;
    syncMarkerClasses();
  },
});

/** The title's Tutorial button, and Try again after the tutorial: deals the tutorial's round, then starts the briefing. */
async function startTutorial(fromTitle = false) {
  tutorialGuide.stop();
  if (fromTitle) await showLoadingFromTitle();
  await defaultsReady;
  const scenario = parseScenario(TUTORIAL_SCENARIO)!;
  if (scenario.settings) borrowSettings(scenario.settings);
  if (await play(scenario.seed, true)) tutorialGuide.start();
}

const title = new TitleScreen(startGame, () => void startTutorial(true));
