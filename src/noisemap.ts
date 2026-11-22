// The aligned strategic noise map of central Sofia (docs/noise-map.md).
// Reads the black and white version, where each colour band is one grey level,
// and turns it into a traffic noise level in dB at any point of the map.

import type { Vec } from './geo';

/** Grey level of each colour band in "noise-map bw.png" and the band's middle in dB, quietest first. */
const GREY_TO_DB: [number, number][] = [
  [0, 32.5],
  [20, 37.5],
  [32, 42.5],
  [65, 47.5],
  [88, 52.5],
  [116, 57.5],
  [159, 62.5],
  [207, 67.5],
  [255, 72.5], // the two loudest bands share pure white
];

function greyToDb(g: number): number {
  for (let i = 1; i < GREY_TO_DB.length; i++) {
    const [g1, db1] = GREY_TO_DB[i];
    if (g <= g1) {
      const [g0, db0] = GREY_TO_DB[i - 1];
      return db0 + ((db1 - db0) * (g - g0)) / (g1 - g0);
    }
  }
  return GREY_TO_DB[GREY_TO_DB.length - 1][1];
}

interface Transform {
  scale: number;
  rotation: number;
  tx: number;
  ty: number;
}

export class NoiseMap {
  private readonly cos: number;
  private readonly sin: number;

  constructor(
    private readonly db: Float32Array, // per pixel
    private readonly width: number,
    private readonly height: number,
    private readonly tf: Transform,
  ) {
    this.cos = Math.cos(tf.rotation);
    this.sin = Math.sin(tf.rotation);
  }

  /**
   * Level in dB at one point. The map doesn't cover the whole play field, so
   * points beyond its edges wrap around to the other side: not real levels,
   * but a plausible mix of streets for the prototype.
   */
  levelAt(v: Vec): number {
    const dx = (v.x - this.tf.tx) / this.tf.scale;
    const dy = (v.y - this.tf.ty) / this.tf.scale;
    const u = Math.floor(this.cos * dx + this.sin * dy);
    const w = Math.floor(this.sin * dx - this.cos * dy);
    const uw = ((u % this.width) + this.width) % this.width;
    const ww = ((w % this.height) + this.height) % this.height;
    return this.db[ww * this.width + uw];
  }

  /**
   * Power average of the level over a disc around v, so a listener hears a
   * nearby boulevard before reaching it and the level doesn't jump at band
   * edges. Outside the map it wraps around, like levelAt.
   */
  levelAround(v: Vec, radiusM: number, steps = 4): number {
    let pow = 0;
    let n = 0;
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        if (i * i + j * j > steps * steps) continue;
        const db = this.levelAt({ x: v.x + (i / steps) * radiusM, y: v.y + (j / steps) * radiusM });
        pow += Math.pow(10, db / 10);
        n++;
      }
    }
    return 10 * Math.log10(pow / n);
  }
}

export async function loadNoiseMap(): Promise<NoiseMap> {
  const meta = await (await fetch('data/noise-map.json')).json();
  const img = new Image();
  img.src = encodeURI('data/noise-map bw.png');
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const db = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < db.length; i++) db[i] = greyToDb(px[i * 4]);
  return new NoiseMap(db, canvas.width, canvas.height, meta.transform);
}
