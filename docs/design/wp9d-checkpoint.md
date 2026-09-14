# WP9d — Further moments

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5, and §10
row **WP9d**. Branch `design/lantern-stage`. Builds on
[`wp9a-checkpoint.md`](./wp9a-checkpoint.md) and
[`wp9b-checkpoint.md`](./wp9b-checkpoint.md).

WP9a shipped the engine and one signature moment; WP9b shipped the other three
and the edges that decide when they happen. WP9d is the remainder of §5.1 — the
moments that were named in the law and had nothing behind them.

---

## Hard half

Three moments — the audio-reactive speaking ring, the theme change, and the
connection state — plus the gate cases that measure them.

Two commits:

| | |
|---|---|
| `2ad8d6e` | the ring takes the voice, and the lights change |
| `21f4f2f` | the gate measures the voice, the lights and the outage |

### 1. The speaking ring takes the voice (§5.1)

> *"The speaking ring breathes between the two alphas in §1.2 at ~1.6 s and,
> where the engine exposes level, brightens with the voice (±15 % intensity,
> 60 ms attack / 240 ms release) — never below the resting ring."*

Half of that shipped in WP0–8: `.pc-speaking` breathes. The other half needed a
number nobody was carrying — every media engine in the app reports a level and
every one of them threw it away at the store boundary.

**The seam.** `MediaEngine.onSpeakingChange` has always been
`(speakers: Map<string, number>) => void`; `voiceStore` only ever read the keys.
Three sources are wired now, and each one is the convention that engine actually
speaks:

| source | what it reports | mapped by |
|---|---|---|
| native (Tauri) / browser QUIC engines | the RTP audio-level header, 0–127 as −dBov, so **lower is louder** | `levelFromDbov` — 45 (the noise gate's own threshold) is silence, 10 is full voice |
| LiveKit | `Participant.audioLevel`, already 0–1 | taken as reported |
| the local mic analyser | LiveKit's `calculateVolume` RMS, where an ordinary voice is ~0.05–0.25 | `levelFromAnalyser` — 0.25 is full |

The local analyser is published as its own source and merged by **loudest wins**,
because it knows how loud you are about 200 ms before the server's speaker report
does, and your own ring is the one on screen whose latency a person can feel.

**The driver — `client/src/lib/motion/voiceLevel.ts`.** This is the only part of
the engine that runs on *every frame* for as long as somebody is talking, so its
shape is entirely about cost. Four rules, each load-bearing:

1. **One loop for every tile.** Not one per `StageTile`, not one per `LitAvatar`.
   A ten-person channel is one `requestAnimationFrame` callback, and it exits the
   moment the last voice has released to silence.
2. **No React state, ever.** A level is fifty updates a second; a store write
   would re-render the channel fifty times a second to move a glow. The property is
   written straight onto DOM the engine found — which is also why a re-render
   cannot wipe it (WP9a's first lesson): it is re-applied on the next report
   regardless.
3. **Nothing is allocated per frame.** Elements are collected when the engine
   *reports* (a few times a second), never in the loop; the level is quantised to
   1/64 and looked up in a table of strings built once, so a frame that does not
   move a ring writes nothing and a frame that does allocates nothing. The gate
   measures this (§5 below): **0.0 KiB across 300 frames**.
4. **A level is never invented.** Where an engine reports speaking but no level,
   the ring simply breathes — which is exactly what §5.1's "where the engine
   exposes level" leaves channel for.

The envelope is a **linear slew**, not an exponential one, so "60 ms attack"
means exactly that and a unit test can hold it: silence to full voice takes 60 ms
and full voice to silence takes 240 ms. One frame may never carry more than
64 ms of it, so a backgrounded tab coming back cannot snap a ring.

**The CSS half, and the one thing that had to change in `tokens.css`.** A custom
property is substituted *where it is declared*, and descendants inherit the
already-resolved value — which means a ring recipe composed on `:root` reads the
root's level and can never read a person's. So the three ring recipes are now
written in **parts**:

```
--light-ring-rgb · --ring-edge · --ring-glow-lit · --ring-glow-speaking
--ring-a-lit-edge · --ring-a-lit-glow
--ring-a-speaking-edge · --ring-a-speaking-glow · --ring-a-peak-edge
```

`--ring-lit`, `--ring-speaking` and `--ring-speaking-peak` are composed from
them and resolve to exactly the values they always had (the literals still live
in `tokens.css` and nowhere else, per §1). `primitives.css` composes the
voice-scaled ring at the **point of use**, on `.pc-speaking`, where the level
actually is:

```css
.pc-speaking {
  --voice-gain: calc(1 + 0.15 * var(--voice-level));
  --ring-speaking-voice: … rgba(var(--light-ring-rgb), min(1, calc(var(--ring-a-speaking-edge) * var(--voice-gain)))) …;
}
```

Every alpha is 15 % higher at full voice; the geometry is untouched, because
§5.1 asks for intensity and not for a ring that grows. The keyframes take the
same treatment with a fallback to the plain tokens, so `.voice-connected-pulse`
— which borrows `pc-breathe` for the on-air dot and has no voice of its own —
is unchanged.

Two marks carry it. `data-motion-person` is already on every `LitAvatar` (the
property inherits down to the rim inside it); **`data-motion-speaking`** is new,
for anything that carries the ring without a face in it — a `StageTile` is a
12 px well around a video surface.

**"Never below the resting ring" is arithmetic, not a promise.** The voice
multiplies the ring; it never replaces it, and `min(1, …)` means High contrast —
whose speaking edge alpha is already 1 — simply stays where it is. The gate
reads the composed `box-shadow` at rest and at full voice and asserts the layer
count is identical and every alpha is `rest × 1.15`.

### 2. The theme change is the lights changing (§5.1)

`client/src/lib/motion/lights.ts`. The whole shell crosses over
`--duration-dim`, and the light elements re-bloom once the new ground has
settled — so the windows, lamps and rims are the last thing to arrive in the new
light rather than being repainted along with everything else.

Two engines, one shape:

- **View Transitions**, where the webview has them: the browser holds a snapshot
  of the old server and crosses it with the new one, at `--duration-dim` on
  `--ease-out` (`primitives.css`, under the `lights-change` stamp).
- **The crossfade**, everywhere else: there is no snapshot to cross with, so the
  lights go **down to the street's own colour and back up in the new one** — a
  dip, 200 ms on `--ease-in` and 200 ms on `--ease-out`, over one fixed
  rectangle, on opacity alone.

**The theme is applied inside the crossfade, by `useTheme`'s own effect.** The
store write reaches the DOM two ticks later, so `changeLights` is *told how to
recognise that it landed* (`applied: () => html[data-theme] === next`) and polls
for it in macrotasks — never a frame, which inside a View Transition's update
callback never comes (WP9a's hang). Bounded at 400 ms: a change that never lands
must not hold the page's rendering open.

Wired at the one place a person chooses a theme — `ThemeSelector`'s button,
which is what both Settings › Appearance and the reference page go through. A
theme arriving from *server settings* is the picture arriving, not somebody
acting, and deliberately does not animate (§5.3).

### 3. The power goes (§5.1, and "never a spinner on the street")

The gateway being away is the one piece of state that is about the *whole*
server rather than anything in it, so it is drawn on the whole server: it
dims 30 % and holds there until the gateway is back.

- **The edge** is `client/src/lib/attention/outage.ts` — pure and injectable,
  the same shape as WP9b's `lightsOn.ts`, with no store, React, DOM or ambient
  clock. It refuses to dim a server that has not been up yet (that is the app
  starting, not the power going), and it enforces a **600 ms grace**: a gateway
  blips several times an hour — a token refresh, a laptop lid, a Wi-Fi handover
  — and a server that dims and undims for 80 ms is precisely the flashing
  blocker WP9a spent a commit removing.
- **The dim** is a scrim the engine owns: one fixed rectangle of the street's own
  colour, `pointer-events: none` so you can keep typing through an outage,
  `contain: strict` and `will-change: opacity` so it is the compositor's bill and
  not the main thread's. **Not the shell's own opacity** — that would put an
  opacity on an ancestor of every dialog, popover and toast, and an element with
  opacity is a containing block for `position: fixed` descendants, so a reconnect
  would visibly move furniture.
- **The relight is WP9b's moment, replayed.** `relightBuilding` lifts the scrim
  and nothing else: a gateway coming back is already §5.1's second "lights on"
  trigger, and that path waits for presence to actually be re-delivered before it
  sweeps. What the outage owns is the **scope** — `takeDimmedPlates()` hands the
  sweep the plates that were under the scrim, and `playRelight` blooms their
  windows, lamps and rims **without settling the plates**, because a plate rises
  when it *enters* the street and these never left it. A reconnect too short to
  dim anything hands over nothing, and the sweep does what it has always done.

And the banner's spinning loader is gone. A spinner says "wait"; a dark server
says what is actually true, which is that nothing on screen is answerable for
right now and you can keep reading it. `ConnectionStatusBar` still says the
words — light is never the only cue (§9) — with a static glyph.

### 4. What the frame strips showed

One defect, and it was invisible in code review because it is not in any of this
package's code.

**A theme change fires a colour transition on every surface in the app.**
`.pc-transition` alone is five properties, and nearly every plate, chip, row and
control in the product carries one for its own hover state. Swapping the theme
restyles all of them at once: several hundred 160 ms property transitions running
*underneath* a 400 ms crossfade. The gate caught it as a dropped frame; §5
rejects it for a better reason, which is that the base does not animate and only
light and the things people do move. `primitives.css` now suppresses transitions
for the length of the stamp, and removes the suppression with it, so the
properties are already at their new values by the time anything can transition
again and nothing jumps.

The measurement that came out of fixing it is the most interesting number in this
package. With the engine switched off entirely, the same click on
`/design-tokens` costs a **149.9 ms frame** — that is the page's own restyle, and
it is printed on every run from the reduced-motion case. With the crossfade over
it, the worst frame is 33 ms and usually 17. **The dip is not dressing the
change; it is hiding the restyle** — which is the same service the View
Transitions path gets from holding a snapshot, arrived at from the other
direction.

### 5. The gate

Three cases on WP9a's sampler, plus one back door on the realtime stub.

**`POST /__offline`** makes the stream endpoint stop answering and cuts every
open stream. WP9b's `__drop` is a *blip* — the client's first retry is
deliberately 0 ms, so it is back before anybody could see it, which is exactly
what "lights on" wanted. An outage is a gateway that is really away, and the only
honest way to drive one is to stop answering. The suite restores it in
`afterEach` whatever happened, because a spec that leaves the gateway down takes
every later one with it.

**The level driver is measured differently from every other moment here**,
because it is not an animation: nothing it does appears in
`document.getAnimations()` (and the breathe it rides on is infinite, which §5.3
exempts). So the frames are judged on their own, the composed `box-shadow` is
read at both ends of the level to prove the ring really is 15 % up, and the heap
is measured across 300 frames of somebody talking. `performance.memory` is
skipped with a printed note where it is absent.

Measured on this box (Chromium, headless, software rendering, Vite dev server —
the worst case the product will meet):

| moment | worst animating frame | p95 | longest animation | sequence |
|---|---|---|---|---|
| the ring takes the voice (154 frames) | 16.8 ms | 16.8 ms | — (a rAF loop, not an animation) | the 2.2 s phrase |
| theme change (crossfade) | 16.8 ms | 16.7 ms | 220 ms `bloom` | 910 ms |
| theme change (View Transitions) | 33.4 ms | 16.8 ms | 400 ms (UA fade) | 910 ms |
| outage — the lights go down | 16.8 ms | 16.7 ms | 400 ms `outage-dim` | 400 ms |
| outage — the lights come back | 16.8 ms | 16.7 ms | 400 ms `outage-dim` | 400 ms |

And what is not about frames:

- **the level loop grows nothing**: heap 36 426 KiB → 36 426 KiB, **0.0 KiB**
  over 300 frames with somebody talking for all of them;
- **the ring really is 15 % up**: alphas `[0.737, 0.243]` at rest →
  `[0.847, 0.280]` at full voice, same layer count. (Those absolute numbers are
  the *breathe's* interpolated value at the instant of the read, not the resting
  token — the voice rides on top of the breath rather than replacing it, which is
  exactly §5.1.) Peak level driven through the real publish path: **0.828**, back
  to **0.000** at rest.
- **the outage holds 30 % and takes no clicks**: computed opacity `0.30`,
  `pointer-events: none`, and no `.animate-spin` anywhere on the street;
- **the relight does not move the street**: `outage-relight` and `bloom`, and
  `settle` asserted absent;
- **reduced motion** now covers all three: no scrim appears for an outage, the
  theme change reports `none` and runs nothing, and the level driver leaves
  `--voice-level` at `0`.

One named allowance is added, and printed on every run, in the same form as
WP9a's and WP9b's: **the crossfade may drop the one frame the theme is applied
on**, at one — the second fails. §4 above has the measurement behind it.

### 6. Frames

`output/design-reference/motion/frames-wp9d/` (gitignored, like every other
package's captures). Regenerate with:

```
cd client
PARACORD_E2E_MOTION=1 PARACORD_E2E_MOTION_FRAMES=1 npx playwright test --grep "capture the WP9d"
```

- `voice-0000ms.png` … `-2100ms.png` — the ring through a two-second phrase,
  captured on `/design-tokens` because a level only exists inside a call. The
  ring itself is the product's own.
- `_voice-level-000.png` … `-100.png` and `_voice-levels.png` — **a calibration
  strip, and it is the one that actually shows the moment.** A photograph of the
  ring cannot separate the voice from the breath: the same shadow is swinging
  between two alphas over 1.6 s, and it swings further than 15 %. Here the
  breathe is held at a fixed phase and only the level moves, 0 → 1 in quarters.
  The rim brightens monotonically (mean luminance over the ring: 26.65 → 26.94 →
  27.22).
- `lights-change-0000ms.png` … `-0900ms.png` — Night → Daylight on the crossfade
  path: whole at 0–120 ms, down to the street's own colour at 200–280 ms, and up
  in Daylight from 360 ms. Captured on the crossfade because the View Transitions
  path composites its snapshots off the main thread and a screencast of it on a
  software-rendered headless Chromium is a black rectangle (WP9a §4).
- `outage-0000ms.png` … `-1400ms.png` — the server going dark over the Lobby:
  mean luminance 23.15 → 19.62 across the 400 ms, then held.
- `relight-0000ms.png` … `-2000ms.png` — the mirror.
- `_voice-strip.png`, `_lights-change-strip.png`, `_outage-strip.png`,
  `_relight-strip.png` — the same frames stacked into one sheet each. Montages
  for reading a moment in one go, not captures.

The outage strips are zeroed on the frame the **engine** started moving, not on
the request — WP9b's convention, and this moment needs it more than anything
there did: the gateway has to be away for the whole 600 ms grace on top of
however long the client takes to notice, so a strip labelled from the request
would be most of a second of a server sitting still.

### 7. The gate, run

```
cd client
npm run typecheck            clean
npm run test:unit            2 354 tests, 249 files, green
npm run test:tokens          497 files, no literal colour
npm run build                clean
npx playwright test          84 passed (mocked smoke + encrypted storage)
npm run test:motion          15 passed (3 frame-capture cases opt-in)
npx eslint src e2e           0 errors (pre-existing warnings only)
```

The real-server suites were not run — they need a release build.

### 8. Deviations from §5, and why

Three, all recorded here because §5 is the contract.

1. **§5.1 says "±15 % intensity".** It is implemented as +15 % at full voice
   with the floor pinned at the resting ring, which is what the same sentence's
   "never below the resting ring" requires: the ring only ever rises from where
   it rests. A true ±15 % would put a speaking ring *below* the resting one on a
   quiet syllable.
2. **§5.3's frame budget** gains one named allowance — the crossfade's single
   frame, the one the theme is applied on (§4, §5). The View Transitions path is
   still not gated on frames, for the reason WP9a recorded.
3. **"Lights on replays for the affected plates only."** "Affected" is the set
   the outage actually dimmed, recorded when the scrim went up. With one server
   connected that is every plate on screen; the mechanism is what matters, and it
   is asserted (the relight blooms windows and never settles a plate). A
   per-server connection status does not exist in `uiStore` — it aggregates — so
   a second instance's server going dark on its own is not something this can
   distinguish yet.

### 9. Known, not fixed here

- **The theme change is most visible where you cannot watch it.** Settings is a
  full-height surface, so the windows and rims that re-bloom behind it are
  covered while you are choosing the theme. The moment is correct either way and
  is recorded on `/design-tokens`, which is also where both engines can be held
  against each other.
- **The relight frame strip is frame-starved in its tail.** The lift is a
  compositor-only opacity fade, so the screencast emits very few frames across
  it; the shape is right (dark until 300 ms, rising after) but the later labels
  are the nearest frame rather than the frame.
- **The `--voice-level` write is a style recalculation per speaking tile per
  frame.** It is quantised to 1/64 so a steady voice writes nothing, and the gate
  measures the whole thing at 16.8 ms worst with ten tiles' worth of work
  available; a fifty-person stage has not been measured.
- **`framer-motion`** still drives `Modal`, `Tooltip`, toasts,
  `SlashCommandPopup` and the connection banner itself. Nothing new is built on
  it.
