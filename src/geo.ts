// Local flat-earth projection around the test area centre.
// At 2 km scale the error is negligible, and working in metres keeps the
// acoustics maths simple.

export type LatLng = { lat: number; lng: number };
export type Vec = { x: number; y: number }; // metres east (x) / north (y) of CENTER

// Roughly between Sveta Nedelya and the Largo, central Sofia.
export const CENTER: LatLng = { lat: 42.6975, lng: 23.3241 };
export const HALF_SIZE_M = 1000; // 2 km x 2 km box

const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LNG = 111_320 * Math.cos((CENTER.lat * Math.PI) / 180);

export function toLocal(p: LatLng): Vec {
  return {
    x: (p.lng - CENTER.lng) * M_PER_DEG_LNG,
    y: (p.lat - CENTER.lat) * M_PER_DEG_LAT,
  };
}

export function toLatLng(v: Vec): LatLng {
  return {
    lat: CENTER.lat + v.y / M_PER_DEG_LAT,
    lng: CENTER.lng + v.x / M_PER_DEG_LNG,
  };
}

export const BOUNDS = {
  south: CENTER.lat - HALF_SIZE_M / M_PER_DEG_LAT,
  north: CENTER.lat + HALF_SIZE_M / M_PER_DEG_LAT,
  west: CENTER.lng - HALF_SIZE_M / M_PER_DEG_LNG,
  east: CENTER.lng + HALF_SIZE_M / M_PER_DEG_LNG,
};

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function insideBox(v: Vec): boolean {
  return Math.abs(v.x) <= HALF_SIZE_M && Math.abs(v.y) <= HALF_SIZE_M;
}
