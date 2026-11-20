// Static OpenStreetMap snapshot produced by scripts/fetch-osm.mjs.
// Data © OpenStreetMap contributors, ODbL.

export type Pt = [number, number]; // [lat, lng]

export interface OsmRoad {
  r: number; // 0 major, 1 secondary, 2 minor
  h: string; // OSM highway tag
  o?: 1 | -1; // oneway: 1 along the points, -1 against them
  p: Pt[];
}

export interface OsmData {
  bbox: [number, number, number, number]; // south, west, north, east
  roads: OsmRoad[];
  rails: { t: 'tram' | 'rail'; p: Pt[] }[];
  buildings: Pt[][];
}

let cache: Promise<OsmData> | null = null;

export function loadOsm(): Promise<OsmData> {
  cache ??= fetch(`${import.meta.env.BASE_URL}data/sofia-center.json`).then((r) => {
    if (!r.ok) throw new Error(`Map data failed to load: ${r.status}`);
    return r.json();
  });
  return cache;
}
