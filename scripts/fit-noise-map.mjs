// Aligns a raster noise map image to the OSM snapshot and writes its georeference.
//   node scripts/fit-noise-map.mjs [image] [u v x y]
//
// Fits a similarity transform (scale, rotation, translation) from image pixels to
// local metres (see src/geo.ts) by pulling the image's loudest-band road pixels
// (purple / blue) onto our major roads. Needs a rough starting point: one image
// pixel (u, v) and the local metres (x, y) it shows, plus roughly north-up and
// ~1.8 m/px. Defaults are for public/data/noise-map.png.
//
// Output: public/data/noise-map.json, read by src/noisemap.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const imageFile = process.argv[2] ?? 'public/data/noise-map.png';
const [u0, v0, x0, y0] = process.argv.length >= 7 ? process.argv.slice(3, 7).map(Number) : [470, 380, -717, 158];
const START_SCALE = 1 / 0.55; // m per image pixel

const png = PNG.sync.read(readFileSync(imageFile));
const data = JSON.parse(readFileSync('public/data/sofia-center.json', 'utf8'));

// Must match src/geo.ts
const CENTER = { lat: 42.6975, lng: 23.3241 };
const M_LAT = 111_132;
const M_LNG = 111_320 * Math.cos((CENTER.lat * Math.PI) / 180);
const toLocal = ([lat, lng]) => [(lng - CENTER.lng) * M_LNG, (lat - CENTER.lat) * M_LAT];

// ---- Distance field of our major roads (rank 0 and 1) on a 2 m grid ----
const HALF = 1350;
const RES = 2;
const N = (2 * HALF) / RES;
const dt = new Float32Array(N * N).fill(1e9);
const cell = (x, y) => [Math.floor((x + HALF) / RES), Math.floor((HALF - y) / RES)];
for (const r of data.roads) {
  if (r.r > 1) continue;
  for (let i = 1; i < r.p.length; i++) {
    const [ax, ay] = toLocal(r.p[i - 1]);
    const [bx, by] = toLocal(r.p[i]);
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (RES / 2)) + 1;
    for (let k = 0; k <= steps; k++) {
      const [cx, cy] = cell(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
      if (cx >= 0 && cy >= 0 && cx < N && cy < N) dt[cy * N + cx] = 0;
    }
  }
}
// Two-pass chamfer distance transform
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    const i = y * N + x;
    let v = dt[i];
    if (x > 0) v = Math.min(v, dt[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, dt[i - N] + 1);
      if (x > 0) v = Math.min(v, dt[i - N - 1] + Math.SQRT2);
      if (x < N - 1) v = Math.min(v, dt[i - N + 1] + Math.SQRT2);
    }
    dt[i] = v;
  }
for (let y = N - 1; y >= 0; y--)
  for (let x = N - 1; x >= 0; x--) {
    const i = y * N + x;
    let v = dt[i];
    if (x < N - 1) v = Math.min(v, dt[i + 1] + 1);
    if (y < N - 1) {
      v = Math.min(v, dt[i + N] + 1);
      if (x < N - 1) v = Math.min(v, dt[i + N + 1] + Math.SQRT2);
      if (x > 0) v = Math.min(v, dt[i + N - 1] + Math.SQRT2);
    }
    dt[i] = v;
  }
const CAP = 60; // metres; caps the influence of pixels with no matching road
const distAt = (x, y) => {
  const [cx, cy] = cell(x, y);
  if (cx < 0 || cy < 0 || cx >= N || cy >= N) return CAP;
  return Math.min(CAP, dt[cy * N + cx] * RES);
};

// ---- Loudest-band pixels in the image: purple (70-75 dB) and blue (75+) ----
const near = (r, g, b, [R, G, B]) => (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2 < 30 ** 2;
const pts = [];
for (let v = 0; v < png.height; v += 3)
  for (let u = 0; u < png.width; u += 3) {
    const i = (v * png.width + u) * 4;
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (near(r, g, b, [148, 8, 97]) || near(r, g, b, [9, 65, 124])) pts.push([u, v]);
  }
console.log(`Loud road pixels sampled: ${pts.length}`);

// Image (u, v) -> metres. v grows downward, y grows north.
const apply = ([s, th, tx, ty], u, v) => [s * (Math.cos(th) * u + Math.sin(th) * v) + tx, s * (Math.sin(th) * u - Math.cos(th) * v) + ty];
const cost = (p) => pts.reduce((sum, [u, v]) => sum + distAt(...apply(p, u, v)), 0) / pts.length;

// ---- Coarse grid search around the starting point, then Nelder-Mead ----
const start = [START_SCALE, 0, x0 - START_SCALE * u0, y0 + START_SCALE * v0];
let best = start;
let bestC = cost(best);
const cu = png.width / 2;
const cv = png.height / 2;
const [cx0, cy0] = apply(start, cu, cv);
for (const ds of [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15])
  for (let th = -0.2; th <= 0.2001; th += 0.025)
    for (let dx = -300; dx <= 300; dx += 25)
      for (let dy = -300; dy <= 300; dy += 25) {
        const p = [START_SCALE * ds, th, 0, 0];
        const [ox, oy] = apply(p, cu, cv);
        p[2] = cx0 - ox + dx;
        p[3] = cy0 - oy + dy;
        const c = cost(p);
        if (c < bestC) (bestC = c), (best = p);
      }

function nelderMead(f, x0, steps, iters = 400) {
  let simplex = [x0, ...steps.map((d, i) => x0.map((v, j) => (j === i ? v + d : v)))].map((x) => ({ x, f: f(x) }));
  const n = x0.length;
  for (let k = 0; k < iters; k++) {
    simplex.sort((a, b) => a.f - b.f);
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const worst = simplex[n];
    const at = (t) => c.map((v, j) => v + t * (worst.x[j] - v));
    const r = { x: at(-1) };
    r.f = f(r.x);
    if (r.f < simplex[0].f) {
      const e = { x: at(-2) };
      e.f = f(e.x);
      simplex[n] = e.f < r.f ? e : r;
    } else if (r.f < simplex[n - 1].f) {
      simplex[n] = r;
    } else {
      const ct = { x: at(0.5) };
      ct.f = f(ct.x);
      if (ct.f < worst.f) simplex[n] = ct;
      else {
        const b0 = simplex[0].x;
        simplex = simplex.map((p, i) => {
          if (i === 0) return p;
          const x = p.x.map((v, j) => b0[j] + 0.5 * (v - b0[j]));
          return { x, f: f(x) };
        });
      }
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0];
}
const nm = nelderMead(cost, best, [0.05, 0.02, 20, 20]);
best = nm.x;
const within10 = pts.filter(([u, v]) => distAt(...apply(best, u, v)) <= 10).length / pts.length;

const [scale, rotation, tx, ty] = best;
const corners = [
  [0, 0],
  [png.width, 0],
  [png.width, png.height],
  [0, png.height],
].map(([u, v]) => {
  const [x, y] = apply(best, u, v);
  return { u, v, lat: +(CENTER.lat + y / M_LAT).toFixed(6), lng: +(CENTER.lng + x / M_LNG).toFixed(6) };
});

const out = {
  image: imageFile.replace(/^public\//, ''),
  width: png.width,
  height: png.height,
  note: 'Image pixel (u, v) -> local metres around src/geo.ts CENTER: x = s(cos r*u + sin r*v) + tx, y = s(sin r*u - cos r*v) + ty',
  transform: { scale, rotation, tx, ty },
  corners,
  fit: { meanRoadDistanceM: +nm.f.toFixed(2), roadPixelsWithin10m: +within10.toFixed(3) },
};
writeFileSync('public/data/noise-map.json', JSON.stringify(out, null, 2));
console.log(`Scale ${scale.toFixed(4)} m/px, rotation ${((rotation * 180) / Math.PI).toFixed(2)} deg`);
console.log(`Mean distance to nearest major road ${nm.f.toFixed(2)} m, ${(within10 * 100).toFixed(1)}% within 10 m`);
console.log('Wrote public/data/noise-map.json');
