import 'leaflet/dist/leaflet.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/share-tech-mono/400.css';
import './style.css';
import L from 'leaflet';
import { BOUNDS, dist, toLatLng, type Vec } from './geo';
import {
  CLIP_SECONDS,
  KINDS,
  headingAt,
  iconSvg,
  isActive,
  isMoving,
  positionAt,
  type SoundSource,
  type SourceKind,
  type Track,
} from './sources';
import { simulate } from './sim';
import { renderListenerAudio, type AudioAssets } from './audio/render';
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- State ----------
let world: World | null = null;
let audioAssets: AudioAssets | null = null;
let round: Round | null = null;
let time = 0;
let playing = false;
let tags: Tag[] = [];
let selected: Pedestrian | null = null;
let revealed = false;

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
map.fitBounds(box);
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
  '.c-zone{color:#5ad1ff}.c-hit{color:#ff3b5c}';
document.head.appendChild(kindStyle);

// ---------- Source layers (rebuilt every round) ----------
// Moving sources are drawn as their vehicle icon only, with no route.
// Fixed sources (bells, construction) also get a ring marking where they are.
const zones = L.layerGroup().addTo(map);
const sourceLayer = L.layerGroup().addTo(map);
const pedLayer = L.layerGroup().addTo(map);
const revealLayer = L.layerGroup().addTo(map);
let sourceMarkers: L.Marker[] = [];
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

function buildSourceLayers(sources: SoundSource[]) {
  zones.clearLayers();
  sourceLayer.clearLayers();

  for (const src of sources) {
    if (isMoving(src)) continue;
    const k = KINDS[src.kind];
    L.circle(ll(src.path[0]), { radius: 45, color: k.color, weight: 1.5, dashArray: '3 5', fillOpacity: 0.06, className: `neon-line c-${src.kind}` })
      .bindTooltip(`${src.name}, active ${src.start}-${src.end}s`, { className: 'neon-tip' })
      .addTo(zones);
  }

  sourceMarkers = sources.map((src) =>
    L.marker(ll(positionAt(src, 0)), {
      icon: L.divIcon({
        className: 'src-marker',
        html: `<div class="src-icon" style="color:${KINDS[src.kind].color}">${iconSvg(src.kind)}</div>`,
        iconSize: [28, 28],
      }),
      interactive: false,
      zIndexOffset: 1000, // keep vehicles above the pedestrian crowd
    }).addTo(sourceLayer),
  );
}

// ---------- Pedestrians ----------
const fullName = (p: Pedestrian) => `${p.profile.firstName} ${p.profile.lastName}`;

function profileHtml(p: Pedestrian) {
  return `<div class="ped-name">${fullName(p)}</div><div class="ped-meta">${p.profile.occupation} · ${p.profile.age}</div>`;
}

function buildPedestrianLayer(people: Pedestrian[]) {
  pedLayer.clearLayers();
  pedMarkers = people.map((p) => {
    const m = L.marker(ll(positionAt(p, 0)), {
      icon: L.divIcon({ className: 'ped', html: '<span class="ped-dot"></span>', iconSize: [14, 14] }),
      riseOnHover: true,
    })
      .bindTooltip(profileHtml(p), { className: 'neon-tip ped-tip', direction: 'top', offset: [0, -6] })
      .on('click', () => select(p))
      .addTo(pedLayer);
    return m;
  });
}

function markerOf(p: Pedestrian | null) {
  if (!p || !round) return null;
  return pedMarkers[round.pedestrians.indexOf(p)] ?? null;
}

function select(p: Pedestrian | null) {
  if (revealed) return;
  markerOf(selected)?.getElement()?.classList.remove('selected');
  selected = p;
  markerOf(selected)?.getElement()?.classList.add('selected');
  $<HTMLButtonElement>('btn-submit').disabled = !selected;
  $('selected').innerHTML = selected
    ? `<div class="label">Suspect</div>${profileHtml(selected)}`
    : '<div class="muted">No one selected. Hover the white dots for profiles, click to select.</div>';
}

map.on('click', () => select(null));

// Legend
$('legend').innerHTML =
  (Object.keys(KINDS) as SourceKind[])
    .map((k) => `<div class="legend-item" style="color:${KINDS[k].color}">${iconSvg(k, 18)}<span>${KINDS[k].label}</span></div>`)
    .join('') + '<div class="legend-item" style="color:#fff"><span class="legend-dot"></span><span>Pedestrian</span></div>';

// Field guide: Doppler toy and reference sirens, for learning to read the spectrogram
new FieldGuide($('guide'));

// ---------- Spectrogram ----------
const spectro = new SpectrogramView($<HTMLCanvasElement>('spectro'), (t) => {
  setPlaying(false);
  setTime(t);
});

// ---------- Rounds ----------
function newRound() {
  if (!world) return;
  const seed = Math.floor(Math.random() * 2 ** 31);
  round = generateRound(world, seed);
  revealed = false;
  tags = [];
  revealLayer.clearLayers();
  buildSourceLayers(round.sources);
  buildPedestrianLayer(round.pedestrians);
  select(null);
  $('result').textContent = '';
  spectro.setTags(tags);
  spectro.setData(simulate(round.sources, round.target, seed));
  if (audioAssets) {
    const t0 = performance.now();
    player.setSamples(renderListenerAudio(round.sources, round.target, seed, audioAssets));
    console.info(`Audio rendered in ${Math.round(performance.now() - t0)} ms`);
  }
  setPlaying(false);
  setTime(0);
  console.info(`Round seed ${seed}. ${round.pedestrians.length} pedestrians, ${round.sources.length} sources.`);
}

function reveal() {
  if (!round || !selected) return;
  revealed = true;
  const { target } = round;
  const correct = selected === target;

  markerOf(target)?.getElement()?.classList.add('target');
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

  const d = dist(positionAt(selected, time), positionAt(target, time));
  $('result').innerHTML = correct
    ? `<b class="win">TARGET IDENTIFIED</b><br>${fullName(target)} it is.`
    : `<b class="hot">WRONG PERSON</b><br>The target was ${fullName(target)}, ${Math.round(d)} m from your suspect at ${time.toFixed(0)}s.`;
  $<HTMLButtonElement>('btn-submit').disabled = true;
  setTime(time);
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
    // Vehicles exist only between spawn and arrival; fixed sources just dim when silent.
    el.classList.toggle('despawned', isMoving(src) && !active);
    el.classList.toggle('inactive', !isMoving(src) && !active);
    if (src.kind === 'airplane') {
      (el.firstElementChild as HTMLElement).style.transform = `rotate(${headingAt(src, t)}deg)`;
    }
  });

  round.pedestrians.forEach((p, i) => pedMarkers[i].setLatLng(ll(positionAt(p, t))));

  if (revealed && selected && selected !== round.target) {
    hitLine.setLatLngs([ll(positionAt(selected, t)), ll(positionAt(round.target, t))]);
  }
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

$('btn-submit').addEventListener('click', reveal);
$('btn-new').addEventListener('click', newRound);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.key.toLowerCase() === 't') {
    addTag();
  }
});

// ---------- Boot ----------
async function boot() {
  $('result').textContent = 'Loading map data...';
  const noiseMap = loadNoiseMap().catch((err) => {
    console.error('Noise map failed to load, traffic bed uses a flat level', err);
    return null;
  });
  const samples = loadSamples().catch((err) => {
    console.error('Sound samples failed to load, the clip will be silent', err);
    return null;
  });
  const osm = await loadOsm();
  addBasemap(map, 'basemap', osm).catch((err) => console.error('Basemap failed to render', err));
  world = buildWorld(osm);
  const bank = await samples;
  if (bank) audioAssets = { samples: bank, noiseMap: await noiseMap };
  console.info(
    `Graphs: road ${world.road.nodes.length}, tram ${world.tram.nodes.length}, walk ${world.walk.nodes.length} nodes.`,
  );
  newRound();
}

boot().catch((err) => {
  console.error(err);
  $('result').textContent = 'Failed to load map data. See console.';
});
