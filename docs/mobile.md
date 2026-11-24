# Game screen layout and mobile mode

Plan for a new game screen layout that also works on phones and small tablets. Written 2026-11-24, before implementation.

The new layout replaces the current one **everywhere**, on desktop and on mobile. Mobile mode only changes a few behaviours on top of it: the trays start closed and close themselves, there are touch gestures, and hover features are off (see [Mobile mode](#mobile-mode)).

## Screen layout

```
+---------------------------+
|T|                         |   T = Target tray tab (red)
|O|        MAP  65%         |   O = Tools tray tab (cyan)
| |                         |
| |                         |
+---------------------------+
|                           |
|    SPECTROGRAM  35%       |
|                           |
| ====[########]=========== |   view scrollbar
| ?   3:43  ( â–¶ )  t  ðŸ”Š â™ª |   bottom bar
+---------------------------+
```

- `#app` grid rows change from `2fr 1fr` to `13fr 7fr` (65 / 35).
- The spectrogram toolbar becomes a bottom bar **below** the canvas and the scrollbar.

### Bottom bar

Three zones: left, centre and right. The Play button is centred on the bar itself, not in the space left over between the sides (a three-column grid, `1fr auto 1fr`).

| Zone | Contents |
|---|---|
| Left | `?`: small button that opens the Field Guide |
| Centre | Time readout, then Play / Pause (the big button, at least 48 Ã— 48 px), then the tag button (a small outline tag icon) |
| Far right | Sound and Music: small icon toggles, a speaker and a music note. Dimmed with a strike when off. Buttons with `aria-pressed`, not checkboxes |

Removed from the bar:

| Item | Now |
|---|---|
| Tag select, Tag, Clear tags | Replaced by the tag button and its picker (below) |
| Zoom âˆ’, +, Fit | Hidden. The keys (`+`, `-`, `0`), the wheel, two-finger gestures and the scrollbar replace them |
| Log checkbox | Hidden. The saved setting still applies and can be changed in Settings |
| Instruction hint ("Click or drag to scrubâ€¦") | Removed |

The Sound and Music toggles keep driving `player.setMuted` / `music.setMuted` as now; only their markup changes.

### Tag picker

The same on desktop and mobile.

- The tag button opens a small tray that pops up above it, listing every source kind with its icon and colour (the same list as the legend), and **Clear tags** at the end.
- Picking a kind puts a tag of that kind on the timeline at the playhead and closes the tray. Clear tags removes all tags and closes it.
- The tray also closes on the tag button again, or on a click or tap anywhere else.
- The `T` key opens and closes the picker, instead of tagging straight away.

### Field Guide

The Field Guide panel leaves the map. The `?` button opens it as an overlay over the map, with a close button. It closes on the close button, on `?` again, or on a click or tap outside it.

The legend (`#legend`) is at the top of the guide, in two columns; it has no tray of its own.

The guide overlay also takes the map's leftover bits, under the guide's own content:

- The intro text from `#side` ("One of these people recorded the sound belowâ€¦"), at the top.
- The siren note (`#siren-note`), once police or ambulance data is bought.
- The round's seed label (`#seed-label`), still click to copy.

The arrest result (`#result`) is dropped: the mission overlay already shows it. `FieldGuide` itself doesn't change; only its container moves.

## Map: trays

Panels that now sit on the map become trays: a narrow tab on the map edge that slides its panel out when clicked or tapped.

### Tabs

- A bar about 22 px wide with vertical text (`writing-mode: vertical-rl`, rotated so it reads bottom to top), in the tray's colour with the existing neon glow.
- When the tray opens, the panel slides out and the tab rides on its outer edge, so the same tab closes it.

### The trays

| Tray | Edge | Colour | Contents (current elements) |
|---|---|---|---|
| Target | Left, upper tab | Red | `#target` (target profile) |
| Tools | Left, lower tab | Cyan | Energy (`.energy-panel`), data access (`#intel`), "Show fixed source zones" toggle, New round |

### Open and close rules

| | Desktop | Mobile |
|---|---|---|
| At round start | All trays open | All trays closed |
| How many open | Any number, each on its own | One at a time; opening one closes the other |
| Closes when | Its tab is clicked | Its tab is tapped, another tab is tapped, the map or spectrogram or bottom bar is touched, or something is selected |

- On both, a tray doesn't close while a hold-to-confirm button inside it is held (`holdingIn`).
- **Mobile, trays and the inspector:** opening the Tools or Target tray closes the inspector but keeps the selection. When the tray closes, the inspector reopens if something is still selected. On desktop both fit side by side.
- Switching between desktop and mobile (resize, rotation) resets the trays to that mode's starting state.
- Tray state lives in one small module (`trays.ts`): `open(name)`, `close(name)`, `toggle(name)`, `closeAll()`, and in mobile mode a `pointerdown` listener on the document that closes the open tray when the press starts outside it.

## Map: inspector

- No inspector panel when nothing is selected. The empty "Nothing selectedâ€¦" text goes away.
- Selecting a tower or person opens the inspector; `select(null)` closes it. In mobile mode, opening it also closes any open tray.
- It slides in from the right edge, 320 px wide (`min(320px, 85vw)` on mobile), as tall as the map, and scrolls inside.
- **Dragging or pinching the map does not deselect.** Only a click or tap on empty map does. Leaflet fires `click` only for presses that moved less than its tolerance, so `map.on('click', â€¦)` should already behave this way. Check this on a real device, and add a moved-distance guard if it doesn't.
- Clicking a person in a tower's connected list switches the inspector to that person, as now.

## Spectrogram

### View scrollbar

A strip under the canvas, above the bottom bar, the plot's width (aligned with the plot, not the axis labels). On desktop and mobile.

- The track is a dim, thin blue line (about 2 px, `rgba(90, 140, 255, 0.3)`).
- The thumb is a bright, thicker cyan bar (about 6 px, `#2ee6ff` with glow) covering the visible slice of the clip.
- Each end of the thumb has a handle. Dragging a handle moves that edge (zooms), down to the minimum span of 5 s.
- Dragging the thumb's middle pans the view. Clicking the track jumps the thumb there.
- The thumb and handles get a grab area at least 32 px tall, larger than what is drawn.
- Always shown, even when fully zoomed out (the thumb then fills the track).
- The time scroll indicator that `draw()` paints in the canvas goes away. The frequency one stays for now, since only desktop can zoom frequency.

`SpectrogramView` needs a small public API for this: `view(): { t0, t1 }`, `setTimeView(t0, t1)`, and an `onViewChange` callback the scrollbar listens to. The scrollbar is its own small class (`spectro-scrollbar.ts`), drawn as DOM elements.

### Mouse (desktop)

Unchanged: click and drag scrubs, wheel zooms time, Shift+wheel zooms frequency, right drag pans, double-click resets. Edge scrolling (below) also applies to mouse drags.

### Touch

All gestures go through pointer events on the canvas, with `touch-action: none` so the browser doesn't scroll or zoom the page.

| Gesture | Action |
|---|---|
| One finger tap | Moves the playhead there (pauses playback, as clicking does now) |
| One finger drag | Scrubs the playhead under the finger |
| One finger drag into an edge zone | Scrolls the view in that direction while the playhead follows the finger (see below) |
| Two fingers, spread or pinch | Zooms time around the midpoint of the fingers |
| Two fingers, move together | Pans time |

- When a second finger lands, scrubbing stops and pan/zoom takes over. If the second finger lands within about 120 ms of the first, the playhead goes back to where it was before the touch, so starting a pinch doesn't move it.
- Lifting one of two fingers ends the pinch. The remaining finger doesn't start scrubbing until it lifts and touches again.
- Frequency zoom by touch comes later.

### Edge scrolling while scrubbing

- The edge zones are the outer 12% of the plot width on each side, at least 32 px.
- While the finger or mouse is in a zone, the view scrolls toward that edge every frame. The speed scales with how deep it is in the zone and with the visible span: at full depth it scrolls one visible span per second. So zoomed in it moves slowly in seconds of audio but at the same speed on screen.
- The playhead stays under the finger, so time keeps advancing while the view scrolls.
- Scrolling stops when the finger leaves the zone or lifts, and at the clip's start or end.
- This replaces the current clamp in `seekFromEvent` that keeps the playhead inside the visible window.

## Performance: playhead before the map

Today `setTime` does everything in one go: the readout, the spectrogram redraw, every source marker, every pedestrian marker, nearby tooltips and the tower inspector. Scrubbing fires `pointermove` faster than the map can keep up, so the playhead lags along with the map.

The goal is that the playhead always follows the finger at full frame rate, and the map catches up when it can. This applies to desktop and mobile.

1. **Split `setTime` in two.**
   - `setTime(t)`: sets `time`, the readout, and calls `spectro.setTime(t)`. Cheap, runs at once.
   - `updateMap()`: markers, tooltips, hit line, tower inspector. Never called directly; requested through `requestMapUpdate()`.
2. **Coalesce map updates.** `requestMapUpdate()` schedules one `requestAnimationFrame` if none is pending. When it runs, it uses the latest `time`. Ten pointer moves in a frame cost one map update.
3. **Coalesce spectrogram draws too.** `SpectrogramView.setTime` marks the canvas dirty and draws once per frame, so a burst of moves doesn't redraw it several times.
4. **Draw the playhead first.** Within a frame, the spectrogram draws before the map update runs, so if the map update is slow the playhead is already on screen.
5. **Skip what you can't see.** Only update markers inside the map's visible bounds (plus a margin). On `moveend` / `zoomend`, update the rest. Most of the crowd is off screen on a phone.
6. **If that isn't enough, spread the map update over frames.** Update pedestrians in chunks with a time budget of about 4 ms per frame, always resuming with the latest `time`. A marker may be a frame or two behind while scrubbing, but nothing blocks the playhead.

Measure each step with the console timings already used in `newRound` before going on to 5 and 6.

A bigger option, only if needed: draw pedestrians on one Leaflet canvas layer (`L.circleMarker` with the canvas renderer) instead of a DOM element per person. It's a much bigger change (highlight classes, tooltips and hit testing all move), so it waits until measurements show it's needed.

## Loading: off the main thread

On a phone, dealing a round blocked the page long enough for Chrome to call it unresponsive. With the CPU slowed 4x in Chrome, simulating the spectrogram blocked the main thread for 7.5 s and rendering the recording for 33 s.

Both now run in a Web Worker (`src/round-worker.ts`; the main thread's side is `src/round-compute.ts`). The sound samples and noise map go to the worker once; each round sends the sources, the target, the seed and a copy of the current settings (so borrowed tutorial and shared-seed settings still apply). The spectrogram and the recording come back as transferred buffers. If the worker can't start, the round is computed on the main thread as before.

The total loading time on a phone is about the same, since the worker runs at phone speed, but the page stays responsive and the loading screen keeps updating.

Still on the main thread, at 4x slowdown: building the city graphs and drawing the basemap (about 2.9 s and 2.6 s, once per session), and drawing the new round's spectrogram image and markers (about 2.6 s). Move these too if they still cause trouble.

## Game menu

A burger button left of `?` in the bottom bar, the same size as the tag, sound and music buttons. It opens a small popup:

- **Restart:** the same round again from the start (same seed and settings). In the tutorial it restarts the tutorial.
- **Main Menu:** back to the title screen, like the mission overlay's Main Menu button.


### Switching

- Mobile mode is on when the viewport is at most **768 px wide** or at most **500 px tall** (`MOBILE_MAX_WIDTH`, `MOBILE_MAX_HEIGHT` in `src/mobile.ts`). The height rule catches phones held sideways.
- One `matchMedia('(max-width: 768px), (max-height: 500px)')` listener in JS toggles `body.mobile`. CSS keys its few mobile rules off `.mobile`, not a separate `@media` block, so CSS and JS can never disagree.
- The listener fires on resize and rotation, so switching works live.

### What changes in mobile mode

- **Trays** start closed, and only one is open at a time (see [Open and close rules](#open-and-close-rules)).
- **Height:** the app uses `100dvh`, so the browser's address bar doesn't push the bottom bar off screen.
- **Hover:** there's no hover on touch, so the tower range shows only for the selected tower (as it already does), and the IDs near the cursor (`syncNearbyTips`) are off. Marked people still show their IDs.
- **Tap targets:** pedestrian dots are 14 px. Their marker gets a larger invisible hit area (about 32 px), with the dot drawn the same size.
- **Inspector** width becomes `min(320px, 85vw)`.

### On every device

- **Hold buttons:** `[data-hold]` buttons have `user-select: none`, `-webkit-touch-callout: none` and `touch-action: none`, and their context menu is blocked, so a long press doesn't select text or open the system menu.
- **Shorter holds on mobile:** some mobile browsers treat a long press as a right click, so in mobile mode holds are shorter: buying data 0.5 s instead of 1 s, arresting 0.9 s instead of 2 s. Each hold button carries both times (`data-hold`, `data-hold-mobile`, see `holdAttrs` in `hold.ts`).
- **Keyboard shortcuts** stay, and do nothing on touch.

## Tutorial

The tutorial box (`src/tutorial.ts`) is titled TUTORIAL.

- **Trays:** a step lists the trays it explains or needs (`trays`) and opens them when it starts. On mobile, the open box also closes every tray its step doesn't need. Presses on the tutorial don't count as outside presses, so they don't close a tray the step opened.
- **Narrower beside a tray:** a step with trays uses a narrower box (340 px) placed beside the tray. If there is no room beside it (phones), the box goes below the map, over the spectrogram.
- **Waiting on the player:** a step with a task (`need`, `done`) keeps Next in place but disabled. Clicking it shows a tooltip saying what is needed, for 4 s. When the task is done (`done` holds), the tutorial moves on by itself.
- **Minimize:** a button in the box's header minimizes it to a green horizontal TUTORIAL tab on the map's bottom edge, at the right (the OpenStreetMap credit is top right). Minimized, the box and the dark overlay go, but the frames and people rings stay, and the game is open. The tab brings it back, and so does every step change, including finishing a task.
- **Exit is a hold** (1 s, 0.5 s on mobile), so a stray tap can't end the tutorial. A plain tap shows a tooltip saying to hold it.
- **Touch wording:** the scrubbing step and the "play it" step describe touch controls on mobile.

## Open questions

Each has the default this plan uses, unless decided otherwise. More will come up once there's a working prototype.

1. **Landscape phones.** Short screens (at most 500 px tall) now use mobile mode too. Still open: whether landscape needs the map and spectrogram side by side instead of 65 / 35. Decide once it has been tried on a device.
2. **Title, settings and mission screens.** Not covered here. Check them on a phone once the game screen works.

## Files touched

| File | Change |
|---|---|
| `index.html` | Tray tabs and wrappers, `?` button, tag button and picker, icon toggles, scrollbar element, bottom bar order |
| `src/style.css` | New layout: grid split, trays, inspector, bottom bar, scrollbar. Plus the few `.mobile` rules |
| `src/mobile.ts` (new) | `MOBILE_MAX_WIDTH`, the `matchMedia` listener, `isMobile()` |
| `src/trays.ts` (new) | Tray open and close state, desktop and mobile rules |
| `src/spectro-scrollbar.ts` (new) | The view scrollbar |
| `src/spectrogram.ts` | Touch gestures, edge scrolling, view API, draw once per frame |
| `src/main.ts` | Split `setTime` / `updateMap`, inspector auto open and close, visible-only marker updates, hover features off on mobile |
| `src/tutorial.ts` | Open trays and the guide for the steps that point at them |
| `src/hold.ts` | Nothing; only CSS for its buttons |

## Order of work

1. New layout: 65 / 35 split and the bottom bar (`?`, time, Play, tag picker, icon toggles, hidden controls), Field Guide behind `?` with the leftover map bits.
2. Trays (desktop rules) and the inspector's auto open and close.
3. Mobile mode switch and the mobile tray rules.
4. Scrollbar, then touch gestures on the spectrogram.
5. Edge scrolling while scrubbing.
6. Performance steps 1 to 4, measure, then 5 and 6 if needed.
7. Tutorial fixes for the trays and the guide.
8. Check everything on a real phone (Chrome Android and Safari iOS).
