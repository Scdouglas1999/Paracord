# WP-G8 checkpoint: room light

Contract: `docs/glass-spec.md` §1.2, §2.1, §4, §9. Plan: `docs/design/glass-plan.md` (WP-G8 row,
§5, §6 risks), with the owner's decision in §8 (ambient view accepted). Nothing is committed.
Everything is in `~/Documents/Paracord-glass` (branch `design/glass`).

The room slot is filled. One pair of 32x18 canvases sits behind both panes, blurred and graded in
its own pixels and scaled up to the window by the browser. It is lit by the current server's
busiest live stream (the ambient view), by the watched stream while a stage is open, else by the
server's banner, else its icon, and rests on a neutral room at Home. The same controller writes one
custom property, `--room-rgb`, which tints every surface through the `color-mix()` derivation G0
put in `tokens.css`.

**Read first, before approving:** the pane color transition the plan asked for is the largest cost
the room causes, by a wide margin, on WebKitGTK and in Chromium (see "CPU" and item 1 under "Not
done"). The fix is two declarations in files outside this package.

## How it works

```
source (FrameSource: stream tap, native sample, banner/icon, DEV fixture)
  └─ analyze (lib/room/analyzeFrame.ts + pixels.ts)
       draw into a 128x72 CPU canvas, cropped to 16:9 like object-fit: cover
       box-average down to 32x18; room color from a chroma-weighted mean of that grid
       Gaussian blur (sigma 1.4 grid px, about blur(64px) at 1440 wide), saturate, brightness,
       then cap every pixel at 60% white
  ├─ backdrop (roomController.ts): the lit layer eases toward each new grid (tau 600 ms,
  │    95% after about 1.8 s), stepped at 4 Hz only while moving; a step under one 8-bit
  │    level is not painted; paint = one putImageData of 576 pixels
  └─ token (tokenWriter.ts): the room color eases the same way, is clamped into the box,
       and is written as channel numbers ("222, 109, 35") on <html>, at most 4 times a
       second, only when it moved 10 or more channel units (a surface takes at most 6%
       of the room, so 0.6 of a unit), plus the exact value the ease settles on
```

- **Source choice** (`lib/room/sources.ts`, pure): stage open, then the watched stream (4 Hz cap,
  sampled at 3); else the current server's busiest live stream through `voiceStore.startAmbient`
  (1 Hz cap, keyframes); else banner; else icon; else nothing. "Busiest" is the voice channel with
  the most people **among those with a stream**, ties to the listed order (the places panel's
  order); within a channel the stream that started first (`self_stream_started_at`); never your own
  stream (this client does not receive it back). A server that declares a banner whose URL is not
  loadable yet (a browser waiting for its download ticket) waits for the banner rather than flashing
  the icon first.
- **Ambient lifecycle** (`components/glass/room/useRoomSource.ts`): the room owns the client's one
  ambient view. `startAmbient` for the busiest stream of the route's server; `stopAmbient` on Home
  and DMs (fixing G6's note that `selectedGuild` is not cleared on Home), in a server with nothing
  live, and on unmount. It stays requested while a stage is open (it then rides the watch or waits,
  costing nothing), so closing the stage relights the room at once. Hidden window and "server not
  current" are G6's (the view pauses and reopens by itself); on top of that the controller
  unsubscribes its source and stops ticking while `document.visibilityState` is hidden.
- **Crossfade** (1.2 s, `--glass-ms-room`): a new source always paints the layer that was not lit
  last; once its first frame is in, the two layers swap `data-lit` and CSS fades opacity. The old
  layer is held until then, at most 1 s; a source that has not delivered by then lets the old light
  go and rests the surfaces on the neutral room (`data-room-phase="waiting"`), rather than keep
  another server's light on.
- **Native-surface route** (desktop app when WebCodecs cannot decode): when the tap reports
  `native-surface`, `viewFrameSource.ts` polls `native_render_sample(streamId, trackId)` at the
  source rate (`lib/room/nativeSample.ts`) instead. See "Rust" below and item 2 under "Not done".
- **Diagnostics**: the backdrop carries `data-room-source` (`stream-ambient`, `stream-watch`,
  `banner`, `icon`, `none`) and `data-room-phase` (`idle`, `waiting`, `lit`). Failures (a still that
  cannot load or be read, a shell that cannot sample, a track the native route names but the engine
  does not list) are `console.error`s with the reason; nothing falls back to another source.

### The clamp box (what `--room-rgb` can ever be)

HSV, defined once in `client/src/lib/room/color.ts` (`ROOM_CLAMP`):

| | range |
|---|---|
| hue | any |
| saturation | 0 to 0.85 |
| value | 0.78 to 1 |

A frame's color is its chroma-weighted mean with saturation lifted x2.4 (an average is far grayer
than any color in it; 2.4 was calibrated on the prototype's own room art: its cave averages to
saturation .37 and its banner to .18, where the designer's samples are .84 and .69), value mapped
into .78-1 by scene brightness, then clamped. Eased values (RGB easing between hues passes through
darker grays) are clamped again before they are written. Both reference samples (222,109,35: s .84
v .87; 80,158,255: s .69 v 1) and the neutral room (209,209,209) are inside the box. Gray stays gray.

`scripts/contrast-audit.mjs` now **reads the box from `color.ts`** and sweeps exactly it: every 15
degrees of hue at saturation 0 / .425 / .85 and value .78 / .89 / 1, plus the two reference samples
and the neutral room (it fails if any of those three leaves the box). The old dim-warm and black
tints are gone: the room can no longer write them. The backdrop's own pixels are capped at 60% white
in `pixels.ts`, which is the `WORST_BACKDROP` the audit already composites panes over.

### Reduced transparency and reduced motion

- Reduced transparency (`data-reduced-transparency="true"`): the backdrop stays, drawn with no blur
  pass (a `MutationObserver` re-reads the source when it flips); panes turn opaque through G0's rule.
- Reduced motion: streams are sampled every 4 s instead of 1-3 times a second, so the room drifts
  rather than follows; the server crossfade is the 150 ms one (`--glass-ms-reduced`, a rule in
  `glass-room.css` more specific than utilities.css's zeroing switch, as §9 asks for layout moves).
  The color ease itself is unchanged.

## Rust (`client/src-tauri/src/native_media/native_render/`)

- `sample.rs` (new): `SampledSurface` wraps a native surface (or nothing) and keeps a 32x18 RGB
  downsample of what it presents, box-sampled from the decoded I420 with the frame's own BT.709/601
  integer matrix (the shader's coefficients) and cropped to 16:9. It samples only while somebody
  asked in the last 2 s, and at most every 200 ms: 9,216 reads, whatever the frame size. A
  GPU-resident handle it cannot read back is an error, not a quiet `waiting`.
- `mod.rs`: every surface `native_render_attach` makes is wrapped. Two commands (both registered in
  `lib.rs`):
  - `native_render_sample(stream_id, track_id)` returns `{status: "sample", width, height, seq, rgb}`,
    `{status: "waiting"}` or `{status: "noSurface"}` (nothing on this device decodes that track).
  - `native_render_attach_sampler(stream_id, track_id, owner_id)` binds a sampler with nothing on
    screen, so the native side decodes a track that is sampled but not shown (the ambient view).
    Nothing calls it yet: see item 2 under "Not done".
- Tests: 7 in `sample.rs` (flat frame, matrix, crop, short buffer, sampled only while asked and at
  most 5 Hz, replaced surface not forgotten, JSON shape).

## Files

New: `client/src/lib/room/{color,pixels,analyzeFrame,tokenWriter,roomController,sources,imageFrameSource,viewFrameSource,nativeSample,devFixture,testClock}.ts`,
tests `client/src/lib/room/{color,pixels,tokenWriter,roomController,sources}.test.ts`,
`client/src/components/glass/room/{RoomBackdrop.tsx,useRoomSource.ts,RoomBackdrop.test.tsx}`,
`client/src/styles/glass-room.css`, `client/src-tauri/src/native_media/native_render/sample.rs`,
`client/e2e/glass-room.{spec,config}.ts`.

Changed: `client/src/components/glass/room/index.ts` (the real export), `client/src/styles/globals.css`
(one import line), `client/src/styles/glass-layout.css` (the stub's room block deleted),
`client/src-tauri/src/native_media/native_render/mod.rs`, `client/src-tauri/src/lib.rs` (two
registration lines), `client/scripts/contrast-audit.mjs` (the tint set only),
`client/e2e/fixtures/glass/install.ts` (one opt-out option, `roomFixture`, default on, that sets
`window.__PARACORD_ROOM_FIXTURE__ = 'stream'` so the mocked harness lights stream-lit states from the
DEV fixture; `lib/room/devFixture.ts` reads it only under `import.meta.env.DEV`).

Deleted: `client/src/components/glass/shell/stubs/RoomBackdropStub.tsx`.

The production bundle contains neither the fixture nor the switch (checked in `dist/`).

## Measured

### Write and paint rates

| Where | Source | `--room-rgb` writes | Max in any 1 s | Canvas paints | Other `<html>` style changes |
|---|---|---|---|---|---|
| Mocked harness, Chromium (`room-budget.json`) | DEV fixture, 1 Hz | 4 in 10 s | 2 | 16 in 10 s | none |
| Live, Chromium, final build | Vincent's drifting warm/teal share, ambient 1 Hz | 18 in 20 s | 3 | about 4/s while easing | none |
| Live, Chromium, first build (deadband 3) | same | 40 in 20 s | 4 | | none |
| WebKitGTK probe (below) | synthetic source drifting 150 degrees of hue every 7 s | about 1.5/s | 3-4 | about 3.7/s | none |

Unit budget tests: 60 offers a second for 10 s give at most 41 writes, never two within 250 ms, only
`--room-rgb`, only channel numbers (`tokenWriter.test.ts`); a 30 fps source for 10 s closes every
frame, writes at most 42 times and paints at most 42 times (`roomController.test.ts`).

### CPU

**Live, headless Chromium** (one page, Sean, 1440x900, the real Lounge call; whole browser, % of one
core over 20-30 s, two runs of the final build; headless Chromium composites with software GL, so
absolute numbers are high; the first build, deadband 3, measured D at 121-122):

| State | Total | GPU process | Renderer |
|---|---|---|---|
| Game Night, everything as built | 114-122 | 89-92 | 21-33 |
| B: room drawing and token writes off (ambient still decoding) | 80-94 | 72-86 | 7.5-8.5 |
| C: B with every other CSS animation paused | 3.2-3.7 | 0.8-1.1 | 2.3-2.5 |
| D: room on, every other CSS animation paused | 73-91 | 48-67 | 24-25 |
| E: D with the panes' room color transition off | 14-15 | 6.7-6.9 | 7.4-8.4 |
| F: D with that transition at 250 ms (one write interval) | 38 | 26 | 12 |
| Basecamp, banner-lit, settled | 16 | 12 | 4 |
| Home, neutral, ambient stopped | 1 | 0.2 | 0.8 |

**WebKitGTK 2.52** (`MiniBrowser`, the system webkit2gtk-4.1 the desktop app embeds; visible
1440x900 window; `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` as the app sets on this NVIDIA box;
`WebKitWebProcess` % of one core over 20 s, two runs each). The desktop app itself was not run (see
item 5), so this is a probe page: the built app CSS, the shell's pane classes, 9 rows and 16 bubbles
on `--sel`/`--bub`, the backdrop canvases, and **the real controller, analyzer and token writer**
bundled from `lib/room` fed by a drifting canvas scene. Probe and script:
`output/design-reference/glass-build/g8/webkit-probe/`.

| Mode | WebKitWebProcess |
|---|---|
| idle (no room) | 1.1-1.7 |
| D: room on, panes' 1.2 s color transition as built | 54.6-55.5 |
| E: panes' room color transition off | 3.7-3.8 |
| F: panes' transition 250 ms | 24.7-25.9 |

The room itself (canvas, analysis, writes and the restyles they cause) costs about 2-3% of a core
on WebKitGTK. Each write restarts a 1.2 s `background-color` transition on both panes (glass.css
`.glass-pane`, glass-layout.css `.glass-frame__*`), which repaints them every frame for its whole
length; any stream whose color keeps moving writes often enough to keep them animating all the
time. Raising the deadband to 16 or 24 did not help (49.7% and 48.9%): even one write every
1.4 s keeps a 1.2 s transition running.

Also for WP-G23: with the room off, the other CSS animations on Game Night (pill and live-row
waveforms, the typing dots) cost 80-90% of a core in headless Chromium's software compositing.

## Screenshots

Mocked (`output/design-reference/glass-build/g8/`, harness plus `glass-room.spec.ts`):
`01-conversation-desktop.png` and `room-01-warm.png` (fixture-lit, warm), `02-quiet-desktop.png`
(see item 3) and `room-02-cool.png` (banner-lit, cool), `room-crossfade-{0000..2500}ms.png` with
`room-crossfade.json` (opacities 1/0, .93/.07, .42/.58, .12/.88, 0/1: a true crossfade),
`room-home-neutral.png`, `room-02-reduced-transparency.png`.

Live (`glass-build/g8/live/`, rebuilt client and release server; served `assets/index--nsLo3TX.js`
matched `client/dist`; `glass-scene.mjs` holding the Lounge call with Vincent's share):
`live-01-game-night.png` (stream-lit, `--room-rgb` about 230,168,35), `live-02-basecamp.png`
(banner-lit, 44,143,232), `live-crossfade-*.png`, `live-room.json`, `live-room-ab.json`.

Against the references (pixels sampled at the same points):

- **01**: backdrop dark teal on the left (live 6,32,27 vs 9,18,15), warm glow on the right (39,32,18
  vs 44,29,16), panes warm (places 27,26,22 vs 26,25,23). The live share has black bars top and
  bottom, so those edges are 0,0,0 where the render has 2,7,7. The fixture used in the mocked shots
  is a gray cave with a warm lamp (its teal became white when G0 remapped the tokens it reads), so
  the mocked 01 is a weaker warm than live; nothing was tuned to it.
- **02**: blue-gray above (32,51,70 vs 29,39,50), cool panes (places 22,27,30 vs 22,26,31), warm
  toward the lower right from the banner's sun. The live banner reads a little brighter and bluer
  than the render's.
- The crossfade, Home's neutral room and reduced transparency behave as described above.

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | my files clean. The tree currently has errors in other packages' work in progress: `lib/media/*MediaEngine.roles.test.ts` (media follow-up) and `components/glass/stage/Stage.tsx` (stage) |
| `npx vitest run --exclude '**/DailyWordView.test.tsx'` | 394 files, 3,984 tests pass |
| `npx vitest run src/lib/room src/components/glass/room` | 38 pass |
| `npm run test:tokens`, `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors (253 warnings, none in these files) |
| `npm run test:contrast` | pass: 52,950 comparisons over 150 room tints (the clamp box, the references, the neutral room); references reproduced at dE 1.50 |
| `npm run test:a11y:static` | pass |
| `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g8 npx playwright test e2e/glass-review.spec.ts --grep "0[127]-"` | 6 pass |
| `PARACORD_E2E_GLASS_WP=g8 npx playwright test -c e2e/glass-room.config.ts` (ports 4393/4395) | 6 pass: warm, cool, crossfade, budget, Home, reduced transparency |
| `pc-cargo.sh check --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on, untouched) | pass |
| `pc-cargo.sh clippy --manifest-path client/src-tauri/Cargo.toml --all-targets -- -D warnings` | pass |
| `cargo fmt -- --check` (client/src-tauri) | pass |
| `pc-cargo.sh test --manifest-path client/src-tauri/Cargo.toml --lib -- native_render` | 15 pass (7 new) |

Everything started was stopped: the scene holder (SIGINT), `live-env` on 18747, MiniBrowser, the
probe's HTTP server, the Playwright web servers.

## Not done, and what the orchestrator should decide

1. **The panes' room color transition** (55% of a core on WebKitGTK with a drifting stream, against
   4% without it). Recommended: drop `background-color var(--glass-ms-room) ease` from `.glass-pane`
   (`styles/glass.css:106`) and from `.glass-frame__places/__stage/__conversation`
   (`styles/glass-layout.css:68`). The controller already eases at 4 Hz, and in steady state each
   write moves a surface by about half an 8-bit level, which no transition can make smoother. If a
   blend is still wanted, 250 ms linear (one write interval) halves the cost (25%). Outside this
   package's scope, so not changed. The rows' 120 ms hover transitions also run on each write, but
   they are short.
2. **Ambient on the desktop's native-surface route decodes nothing.** WP-G6's headless tap branch
   (`lib/media/tauriMediaEngine.ts`, `else if (nativeSurfaceAvailable && headless)`) settles the route
   and subscribes nothing, so no frame of the ambient stream is decoded, and `native_render_sample`
   answers `noSurface` (the room says so once and waits). The watched stream on the stage is sampled,
   because its surface is wrapped. The fix belongs to lib/media's owner: in that branch, call
   `native_render_attach_sampler` (through `invokeCleanup`, like `native_render_attach`), register
   the relay track subscription on the lowest layer (`registerTrackSubscription`), and detach the
   sampler (`native_render_detach`) in `stop`. A surface attached later for the same track takes the
   binding over (one per track, G6 gap 5).
3. **Banner race in `guildStore`.** The server's READY carries no `banner_hash`; only the REST guild
   list does. When READY lands while `fetchGuilds` is in flight, `addGuild` records a `put` mutation
   and the finished list is replaced by that partial projection, so the banner is lost until
   something else fetches the guild. In the mocked harness this happens every time (02-quiet is
   lit by Basecamp's icon, not its banner; `glass-room.spec.ts` puts the REST banner back to test the
   banner path). Live it did not happen in my runs. Suggested fix (guildStore owner): merge a `put`
   recorded during a fetch into the fetched guild (`{ ...fetched, ...put }`) instead of replacing it.
4. **`useAuthenticatedImage` returns the previous URL for one render after its input changes**, so a
   route change reads "no banner" for a render. The room works around it (it takes loadable URLs as
   they are), but the hook's other users see the same stale render.
5. **The desktop app was not run.** Logging a WebKitGTK window in needs input automation that does
   not work on this KDE Wayland session (xdotool typing into an XWayland MiniBrowser did not reach
   the page). The WebKitGTK numbers are from the probe page above, on the same engine build; WP-G23
   should measure the app with a live stream.
6. The live scene holder's cast started getting 401 on `/stream/ticket` about 40 minutes in; the
   stream kept flowing. Not investigated (not this package).
7. With several streams in one channel, the room picks the earliest-started; the places panel names
   the first sharer in speakers-first order. They can differ.
8. `components/glass/room/useRoomSource.ts` stops the ambient view on unmount; the pill's preview
   (G12) reads `ambientView`, so it sees what the room asked for and nothing else.
