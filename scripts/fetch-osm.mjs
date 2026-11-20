// Fetches roads, rails and buildings for the test area from the Overpass API
// and writes a compact JSON file the game loads at runtime.
//   node scripts/fetch-osm.mjs
// Data © OpenStreetMap contributors, ODbL.

import { writeFileSync } from 'node:fs';

// Must match CENTER / HALF_SIZE_M in src/geo.ts. Fetch a margin around the box
// so the map does not look cut off at the edges.
const CENTER = { lat: 42.6975, lng: 23.3241 };
const HALF_M = 1000 * 1.35;
const dLat = HALF_M / 111_132;
const dLng = HALF_M / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180));
const bbox = [CENTER.lat - dLat, CENTER.lng - dLng, CENTER.lat + dLat, CENTER.lng + dLng].map((v) => v.toFixed(6)).join(',');

const query = `
[out:json][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|unclassified|residential|living_street|pedestrian)$"](${bbox});
  way["railway"~"^(rail|tram|light_rail)$"](${bbox});
  way["building"](${bbox});
  relation["building"](${bbox});
);
out geom(${bbox});
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function runQuery() {
  let wait = 5;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    console.log(`Querying ${url} (attempt ${attempt + 1}) for bbox ${bbox}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'find-me-prototype/0.1' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.ok) return await res.json();
      console.warn(`  ${res.status} ${res.statusText}`);
    } catch (e) {
      console.warn(`  ${e.message}`);
    }
    console.log(`  retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    wait *= 2;
  }
  throw new Error('All Overpass attempts failed');
}

const ROAD_RANK = {
  motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0,
  secondary: 1, tertiary: 1, secondary_link: 1,
  unclassified: 2, residential: 2, living_street: 2, pedestrian: 2,
};

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const line = (geom) => geom.filter(Boolean).map((g) => [r6(g.lat), r6(g.lon)]);

// A way clipped by the bbox has null entries where it leaves the box.
// Split there so we never invent a straight segment across the gap.
const pieces = (geom) => {
  const out = [];
  let cur = [];
  for (const g of geom) {
    if (g && g.lat !== undefined) cur.push([r6(g.lat), r6(g.lon)]);
    else if (cur.length) (out.push(cur), (cur = []));
  }
  if (cur.length) out.push(cur);
  return out;
};

const json = await runQuery();

const out = { bbox: bbox.split(',').map(Number), roads: [], rails: [], buildings: [] };
for (const el of json.elements) {
  const tags = el.tags ?? {};
  if (el.type === 'way' && tags.highway && el.geometry) {
    if (tags.tunnel === 'yes') continue;
    const o = tags.oneway === 'yes' ? 1 : tags.oneway === '-1' ? -1 : 0;
    for (const p of pieces(el.geometry)) {
      out.roads.push({ r: ROAD_RANK[tags.highway] ?? 2, h: tags.highway, ...(o ? { o } : {}), p });
    }
  } else if (el.type === 'way' && tags.railway && el.geometry) {
    if (tags.tunnel === 'yes') continue;
    for (const p of pieces(el.geometry)) out.rails.push({ t: tags.railway === 'tram' ? 'tram' : 'rail', p });
  } else if (el.type === 'way' && tags.building && el.geometry) {
    out.buildings.push(line(el.geometry));
  } else if (el.type === 'relation' && tags.building) {
    for (const m of el.members ?? []) {
      if (m.role === 'outer' && m.geometry) out.buildings.push(line(m.geometry));
    }
  }
}
out.roads = out.roads.filter((r) => r.p.length > 1);
out.rails = out.rails.filter((r) => r.p.length > 1);
out.buildings = out.buildings.filter((b) => b.length > 2);

const file = 'public/data/sofia-center.json';
writeFileSync(file, JSON.stringify(out));
console.log(`Wrote ${file}: ${out.roads.length} roads, ${out.rails.length} rails, ${out.buildings.length} buildings`);
