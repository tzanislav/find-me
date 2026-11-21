# Noise map alignment

Real strategic noise map of central Sofia, aligned to the game map on 2026-11-20.
Used by the audio render (`src/noisemap.ts`, `src/audio/render.ts`): the traffic bed under each clip follows the level at the listener, power-averaged over 25 m. The black and white image is read, mapping each grey level back to its band (0, 20, 32, 65, 88, 116, 159, 207, 255 = quietest to loudest; the two loudest bands are both white).

## Files

| File | What it is |
|---|---|
| `public/data/noise-map.png` | Original colour map, 1398 × 936 px, 10 colour bands |
| `public/data/noise-map bw.png` | Black and white version of the same map, same 1398 × 936 pixel grid. Brighter is louder. |
| `public/data/noise-map.json` | Machine-readable alignment, written by `scripts/fit-noise-map.mjs` |

Both images share one pixel grid, so the alignment below applies to both.

## Image corners

| Pixel (u, v) | Corner | Latitude | Longitude |
|---|---|---|---|
| (0, 0) | top left | 42.704701 | 23.305269 |
| (1398, 0) | top right | 42.705269 | 23.335369 |
| (1398, 936) | bottom right | 42.690433 | 23.335885 |
| (0, 936) | bottom left | 42.689865 | 23.305786 |

The image is rotated about 1.47° relative to north, so it is not an axis-aligned rectangle in latitude and longitude.

## Pixel to map transform

Local metres are measured east (x) and north (y) of the game map centre in `src/geo.ts`, 42.6975 N, 23.3241 E.

```
x = s * ( cos(r) * u + sin(r) * v) + tx
y = s * ( sin(r) * u - cos(r) * v) + ty

s  = 1.7620686   metres per pixel
r  = 0.0256150   radians (1.47°)
tx = -1540.614   metres
ty =   800.271   metres
```

Inverse, from local metres to pixel:

```
dx = (x - tx) / s,  dy = (y - ty) / s
u  =  cos(r) * dx + sin(r) * dy
v  =  sin(r) * dx - cos(r) * dy
```

## Fit quality

The fit pulled the map's loudest road pixels onto the major roads of the OSM snapshot.

| Measure | Value |
|---|---|
| Loud road pixels within 10 m of a major road | 77% |
| Mean distance to the nearest major road | 10.7 m |

## Coverage

The map covers roughly 2.5 km east to west and 1.7 km north to south. It misses thin strips along the north, south and east edges of the 2 × 2 km play box.

## Colour bands

Ordered quietest to loudest. The order was measured from which colours border each other in the image. The dB values are an assumption, the usual 5 dB steps, because the image came without a legend.

| Colour | RGB | Assumed level |
|---|---|---|
| Dark green | 8, 114, 48 | 30–35 dB |
| Green | 74, 172, 49 | 35–40 dB |
| Light green | 189, 230, 188 | 40–45 dB |
| Light yellow | 255, 255, 172 | 45–50 dB |
| Yellow | 255, 246, 65 | 50–55 dB |
| Orange | 255, 149, 40 | 55–60 dB |
| Red | 254, 0, 0 | 60–65 dB |
| Dark red | 114, 0, 0 | 65–70 dB |
| Purple | 148, 8, 97 | 70–75 dB |
| Blue | 9, 65, 124 | 75 dB and above |

## Refitting

`node scripts/fit-noise-map.mjs [image] [u v x y]` refits a new or larger map and rewrites `public/data/noise-map.json`. It needs the colour palette above, since it looks for the purple and blue road bands.
