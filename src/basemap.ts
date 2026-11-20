// Static neon basemap, DEFCON style.
// The OSM snapshot in public/data is rendered once into a large image at
// startup, then shown as a Leaflet image overlay. No tile server involved.

import L from 'leaflet';
import type { OsmData, Pt } from './osm';

const SIZE = 3072; // ~0.9 m per pixel, matches max zoom 17
const GLOW_SIZE = 192; // low-res density map for the blue "nebula"

const STYLE = {
  background: '#02030f',
  nebula: '#1834ff',
  buildingFill: 'rgba(28, 55, 190, 0.28)',
  buildingStroke: 'rgba(95, 140, 255, 0.55)',
  roads: [
    { width: 7, color: '#8fd0ff', glow: '#2f8bff', blur: 22 }, // major
    { width: 4.5, color: '#62b0ff', glow: '#2f6bff', blur: 12 }, // secondary
    { width: 2.4, color: 'rgba(80, 140, 255, 0.8)', glow: '#2040ff', blur: 5 }, // minor
  ],
  tram: { width: 2, color: 'rgba(69, 255, 156, 0.75)', glow: '#00c85f', blur: 6, dash: [] as number[] },
  rail: { width: 3, color: '#e9f6ff', glow: '#9fd8ff', blur: 10, dash: [14, 9] },
};

export async function addBasemap(map: L.Map, pane: string, data: OsmData): Promise<void> {
  const [s, w, n, e] = data.bbox;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  const pathOf = (lines: Pt[][], size: number, close: boolean) => {
    const p = new Path2D();
    for (const line of lines) {
      line.forEach(([lat, lng], i) => {
        const x = ((lng - w) / (e - w)) * size;
        const y = ((n - lat) / (n - s)) * size;
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      });
      if (close) p.closePath();
    }
    return p;
  };

  // 1. Background
  ctx.fillStyle = STYLE.background;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // 2. Nebula: building density, rendered tiny then blown up and blurred
  const glow = document.createElement('canvas');
  glow.width = glow.height = GLOW_SIZE;
  const g = glow.getContext('2d')!;
  g.fillStyle = STYLE.nebula;
  g.fill(pathOf(data.buildings, GLOW_SIZE, true));
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(60px)';
  ctx.globalAlpha = 0.75;
  ctx.drawImage(glow, 0, 0, SIZE, SIZE);
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 0.35;
  ctx.drawImage(glow, 0, 0, SIZE, SIZE);
  ctx.restore();

  // 3. Buildings
  const buildings = pathOf(data.buildings, SIZE, true);
  ctx.fillStyle = STYLE.buildingFill;
  ctx.fill(buildings);
  ctx.strokeStyle = STYLE.buildingStroke;
  ctx.lineWidth = 1.4;
  ctx.stroke(buildings);

  // 4. Roads, minor first, each rank batched into one path for one glow pass
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const rank of [2, 1, 0]) {
    const st = STYLE.roads[rank];
    const p = pathOf(data.roads.filter((r) => r.r === rank).map((r) => r.p), SIZE, false);
    strokeGlow(ctx, p, st.width, st.color, st.glow, st.blur);
  }

  // 5. Rails
  for (const kind of ['tram', 'rail'] as const) {
    const st = STYLE[kind];
    const p = pathOf(data.rails.filter((r) => r.t === kind).map((r) => r.p), SIZE, false);
    ctx.setLineDash(st.dash);
    strokeGlow(ctx, p, st.width, st.color, st.glow, st.blur);
    ctx.setLineDash([]);
  }

  // 6. Scanlines for a CRT feel
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  for (let y = 0; y < SIZE; y += 4) ctx.fillRect(0, y, SIZE, 1);

  // 7. Fade the data edges into the void so the map has no hard border.
  // The play box starts ~13% in from each edge, so the fade stays outside it.
  ctx.globalCompositeOperation = 'destination-in';
  for (const horizontal of [true, false]) {
    const grad = horizontal ? ctx.createLinearGradient(0, 0, SIZE, 0) : ctx.createLinearGradient(0, 0, 0, SIZE);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.12, 'rgba(0,0,0,1)');
    grad.addColorStop(0.88, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
  ctx.globalCompositeOperation = 'source-over';

  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  L.imageOverlay(URL.createObjectURL(blob), [[s, w], [n, e]], { pane, interactive: false }).addTo(map);
}

function strokeGlow(ctx: CanvasRenderingContext2D, p: Path2D, width: number, color: string, glow: string, blur: number) {
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(p);
  ctx.restore();
}
