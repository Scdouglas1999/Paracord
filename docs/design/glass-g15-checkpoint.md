# WP-G15 checkpoint: theater, browse, and the moves

Contract: `docs/glass-spec.md` §5, §6 (§6.2 theater, §6.3 browse), §9. Plan: `docs/design/glass-plan.md`
(the WP-G15 row, §5, §6 native underlay and motion lint, §8). Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

Theater, browsing in theater, surfacing messages, the S/T/H/C/Esc keys and every stage layout move
(pill to stage and back, side by side to theater and back, browse, hide chat) are built.

- The mocked shots match `05` and `06` to the pixel on every measured box.
- On a real relay, Sean's client drives `05-theater` and `06-browse` through the visible controls.
- A live filmstrip plays the moves on Vincent's real stream.

## What was built

**Theater (§6.2).**

- The stream fills the window.
- The conversation floats as the 380px `--deep` column (G7's geometry). The stream's buttons move to
  the left of it, and the chat button (H) joins them.
- Only the talker gets a tile, 168×112 at 20,88. This is G14's `CameraTile`, now exported: the camera
  once joined, the face before that. Everyone else is a 52px face in a column under it. Faces have
  amber rings for sharing and talking, faint rings otherwise, a light ring on hover (its own layer,
  opacity only), and a 20px mic-off badge when muted. A talker keeps the tile for 2 s after they stop,
  so a breath does not flip the column. Another sharer's face is a "Watch X's screen" button.
- The controls are the same `StageControls`, restyled by CSS alone as a glass capsule centered on the
  visible stream. `StageControls.tsx` is untouched.
- **Surfacing messages** (`SurfacingMessages.tsx`). Only messages that arrive in the hidden
  conversation after it was hidden surface, never your own, at most 3, 6 s each. "Nick in General",
  or "Jeremy mentioned you" with the 1.5px white edge. The bubbles are `--bub` at 92% with a 12px
  blur. A click shows the chat again. Each one is announced once to screen readers
  (`role="status"`), since the chat that would carry it is hidden.

**Browse (§6.3).**

- Side by side: the resting layout was already G7's and G14's (stage 348 w1076, conversation steps
  aside). The move is new.
- Theater: places floats over the stream's left edge. The title, the faces and the capsule move right
  of it. The chat steps out of the way, which is the prototype's layout.
- Picking a channel or server closes browse. In theater a pick also brings that conversation back
  (`GlassFrame`'s route effect sets `chatHidden` false). S or Esc without a pick restores the chat as
  it was.
- The floating places pane takes `--deep` in theater. At `--pane` (.94) a bright frame read through it.

**Keys** (`hooks/useGlassKeybinds.ts`).

- S, T, H, C and Esc, bound on `window` while a stage is on screen.
- Ignored when a modifier is held, when typing, when a menu, dialog or listbox is open, when a sheet is
  open, or when an earlier handler already called `preventDefault` (the voice keybinds do).
- Esc closes browse first, then stops watching. This is G14's logic, moved here from `Stage.tsx`.
- C is G16's exported `triggerClip()`.
- The phone stage answers Esc only.

**The moves** (`stage/stageTransition.ts`, engine in `lib/motion/sharedElement.ts`).

- 650ms on the `--glass-spring` curve.
- **Open:** the stage pane grows out of the pill's capsule (or out of the live row, if that was
  clicked). Its content is revealed from the top left, and it sits above the conversation for the
  move. Places steps back 28px, to 98%, and fades. The pill fades. The conversation narrows against
  its fixed right edge.
- **Close:** a clone of the stage shrinks into the pill, which fades in as it lands. Places comes back.
- **T:** the pane grows to the window. The stream travels with one uniform scale (it never stretches).
  The title, the buttons and the controls glide to their places. The side row and the theater faces
  cross-fade.
- **S / H:** places slides in or out from the left. The faces, title and capsule move over. The
  conversation's step aside is G7's CSS transition.
- **Reduced motion:** every move is a 150ms crossfade in place. The conversation's step aside, which
  CSS makes instant under reduced motion, is crossfaded too.

## How the moves work

- **Measuring without owning the callers.** Every layout change goes through `glassStore`, whoever
  makes it: the pill's Watch, the live row, the buttons, the keys, or a route change closing browse. A
  store listener runs inside `set()`, before React touches the DOM. It measures every part as it is
  seen (transforms included, so an interrupted move retargets from where it was). It then clones what
  is about to leave into a layer above the frame. `GlassFrame`'s layout effect, plus one microtask,
  measures where things went and plays the difference. The microtask is there so the stage's own
  synchronous re-measure (its layout effect now depends on mode, browse and chat) has landed. This is
  still before paint.
- **Nested counter-scaling.** A pane scales from box to box, and its `overflow: hidden` gives the
  "opens up" reveal. Its content counter-scales, so it never stretches. The stream uses a uniform
  "fit" scale. Chrome inside it is counter-scaled again. Each item's transform is solved from its
  ancestors' transforms at the same instant, and the easing is baked into 24 keyframes (linear
  between), so nested inverses cancel exactly. Two animations with the same easing curve are only
  inverse at their ends. Unit-tested in `lib/motion/morph.test.ts`.
- **Shadows.** A pane whose corners change repaints every frame. So the heavy pane shadow comes off
  for the move, and two shadow ghosts in a layer under the frame (first and last shadow) scale and
  cross-fade instead. They are never repainted: the WebKitGTK cost glass-plan §6 warns about.
- **What animates:** only `transform`, `opacity` and `border-radius`. The motion lint passes with no
  new allowance.
- **Other packages' chrome on the stream** (G17's reactions, my surfacing stack) glides from its old
  box to its new one. An element with a resting transform of its own is left to scale with the stream,
  because a move's transform would replace it for 650ms. The clip toast is one.
- **Theater variables for G16 and G17.** I set G17's `--stream-reactions-right` (32px, or 428px with
  the chat shown) and `--stream-reactions-bottom` (120px) in theater, as the orchestrator asked. I also
  center G16's `.glass-clip-toast` on the visible stream in `glass-stage-modes.css`. Both read
  `--stage-vis-l` and `--stage-vis-r`.

### Why not View Transitions (the "one path" decision)

**I checked WebKitGTK:** 2.52.6 on this box has the API (`startViewTransition` is a function, `ready`
resolves, the UA animations run; probed from a WebKit2 4.1 view under xvfb). Chromium, WebView2 and
WebKit on macOS have it too.

**I chose one path on every platform: Web Animations FLIP.** Four reasons:

1. **It needs the callers.** View Transitions must be started *before* the DOM changes. So every
   caller (the pill, G9's live row, the keys, G7's route effect) would have to wrap its store call.
   The route-change close of browse cannot be wrapped at all: the new page has already rendered when
   the frame learns of it. A store listener sees every change from every caller, and needs nothing
   from them.
2. **It stretches the content.** A snapshot stretches: the conversation going from 1076 to 420 wide
   would squash its text for 650ms unless each pair got custom pseudo-element CSS.
3. **Native video is not in the snapshots.** Native video surfaces are not in view-transition
   snapshots either way, so the poster path below is needed regardless.
4. **Cost.** Snapshotting the whole 1440×900 root on every S, T and H is a new cost on WebKitGTK that
   G23 would have to measure. FLIP here is transforms on a few composited layers.

`transitionWith` (the Lantern View Transitions and FLIP helper) is untouched for its existing users.
The Glass engine is additive.

### Native underlay (plan §6)

A native surface follows its element's box only when the box is reported, never mid-animation.
Worse, the report after a layout change catches the inverted FLIP transform and leaves the surface at
the old place.

- **The shield.** In the desktop app (`isTauri()`), each move puts a transparent full-window shield,
  marked `data-native-overlay-occlude`, in the top layer. Every native surface's occlusion sampler
  reads it as an occluder and hides (its body `MutationObserver` fires on the insert).
- **The poster.** Meanwhile the stream box shows its **poster**: `useStreamPoster`, the shell's
  32×18 `native_render_sample`, drawn once a second into a canvas scaled up. It is visible only while
  the box has no live surface and no notice.
- **After the move.** When the shield comes off, the surfaces report their settled geometry and
  reappear.
- The shield also takes the pointer for 650ms. The web build has no shield and no poster
  subscription.
- **Not run in Tauri** (see What is left).

## Files

**New**

- `client/src/components/glass/stage/stageTransition.ts`: the choreography, the layers, the shield,
  `useStreamPoster`.
- `stage/TheaterPeople.tsx`, `stage/SurfacingMessages.tsx`.
- `client/src/hooks/useGlassKeybinds.ts`.
- `client/src/styles/glass-stage-modes.css`: theater, faces, capsule, surfacing, poster, morph
  layers, and the underlay and reduced-transparency variants.
- Tests:
  - `lib/motion/morph.test.ts` (7).
  - `hooks/useGlassKeybinds.test.tsx` (7).
  - `stage/stageTransition.test.tsx` (7).
  - `stage/TheaterPeople.test.tsx` (3).
  - `stage/SurfacingMessages.test.tsx` (5).
  - `stage/TheaterStage.test.tsx` (5).
- `client/e2e/glass-theater.spec.ts` and `glass-theater.config.ts`: mocked shots on ports 4433/4435,
  reusing G14's `glass-stage-dev.mjs`.
- `client/scripts/glass-scene/moves-live.mjs`: the live filmstrip.

**Changed**

- `lib/motion/sharedElement.ts`: the morph engine appended (`morphFrames`, `playMorph`,
  `cubicBezier`, `containedPicture`, `GLASS_LAYOUT_CURVE`).
- `stage/Stage.tsx`:
  - It chooses the layout: side row or `TheaterPeople`.
  - Theater overlay: the chat button; the data attributes `data-mode`, `data-browse`, `data-chat`.
  - Poster canvas, `SurfacingMessages`, and `data-glass-move` markers.
  - Esc moved to the keybinds hook.
  - The geometry effect re-measures on mode, browse and chat changes.
  - The tree keeps the same shape in both modes, so the stream never remounts (tested: same canvas,
    one subscription).
- `stage/StagePeople.tsx`: `CameraTile` exported (one word).
- `shell/GlassFrame.tsx`: the morph layers and `useStageTransitions`; theater browse puts the chat
  away; a pick in theater brings the chat back.
- `styles/glass-layout.css`: `--deep` for the floating theater places pane, and a comment.
- `styles/globals.css`: one import after `glass-stage.css`.
- `pages/AppShell.test.tsx`: +2 tests.
- `scripts/glass-scene/shots.mjs`: `05-theater` implemented; `06-browse` settles and checks
  1076/places.
- `scripts/glass-scene/ui.mjs`: `theater`, `sideBySide`, `hideChat`, `showChat`.

Not touched: `StageControls.tsx`, `glassStore.ts`, and G16's and G17's files (I only import
`triggerClip`, and style `.glass-clip-toast`'s `left` in theater).

## Commands (in `client/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 414 files, 4,209 tests (whole client, others' work in progress included) |
| `npm run test:tokens` / `test:motion-lint` | pass / pass (no new allowance) |
| `npm run lint` | 0 errors, 254 warnings; `npx eslint` on every file of mine: 0 problems |
| `npm run test:contrast` / `test:a11y:static` | pass / pass |
| `PARACORD_E2E_GLASS_WP=g15 npx playwright test -c e2e/glass-theater.config.ts` | pass, 9/9 |
| `glass-scene.mjs --shot 05-theater,06-browse` (live) | both shot through the controls |
| `glass-scene/moves-live.mjs` (live) | PASS: the picture was on screen after every move |

## Against the references (mocked, 1440×900, `output/design-reference/glass-build/g15/`)

| | Reference (prototype numbers) | Mine |
|---|---|---|
| `05` talker tile / faces | 20,88 168×112; 52px faces 12 apart | 20,88 168×112; faces at 212 / 276 / 340 |
| Theater capsule center | 522 chat shown, 720 hidden, 894 browsing | 522.0, 720.0, 894.0; bottom 24, 64 tall |
| Buttons' right edge | 1440 − 410 (chat shown), 1440 − 14 | 1030, 1426 |
| Title while browsing | left 348 | 348; tiles at 348 |
| Surfacing | left 20, bottom 112, width 380 | 20, bubbles end at 792.7, 380 |
| `06` browse | stage 348 w1076, stream 1052×592 | 348 w1076, 1051.9×592 |
| Theater chat | 1044,16 380×868 | 1044,16 380×868 |

**Shots**

- Resting states: `theater-05-chat-desktop.png`, `theater-05-hidden-desktop.png` (against `05`),
  `browse-06-side-desktop.png` (against `06`), `browse-06-theater-desktop.png`,
  `browse-06-theater-picked-desktop.png`.
- Filmstrips: `move-open-*`, `move-close-*`, `move-theater-*`, `move-side-*`, `move-browse-*` (0 to
  650 ms), plus `strip-*.png`.
- Live: `live/05-theater.png`, `live/06-browse.png`, `live/moves/open-*`, `live/moves/theater-*`,
  `live/strip-*.png`.

**Differences**, each deliberate or not mine:

1. **Face order** comes from the model (the pill's order). Live, Nick comes before Vincent; the
   reference has Vincent first. Faces are initials in the mocked shots and real avatars live.
2. **" · 2 watching"** follows the subtitle (G14's decision).
3. **More** is in the joined capsule (owner decision §8.4). The reference predates it.
4. **The mocked stream** is the fixture scene. Live it is Vincent's.

## What is left, and known limits

- **Desktop app not run.** The shield and poster path is built on the contract `nativeVideoTile.ts`
  already honors (the `data-native-overlay-occlude` occluder, the body `MutationObserver`, the 32×18
  sample), and is unit-tested only at the level of "no subscription on the web". WP-G23 must run
  pill-to-stage and T on a native route in Tauri/WebKitGTK:
  - Is the surface hidden before the first frame of the move? There may be one or two frames of
    latency: the report is rAF-throttled and then goes over IPC.
  - Does it come back at the settled box?
  - What does the move cost in `WebKitWebProcess` CPU?
- **Camera tiles on the native route** show their black canvas while hidden during a move. There is
  no per-camera poster, because no camera sample exists.
- **Letterbox band.** With a stream whose shape differs from the window, the first frames of side to
  theater show the stream box's letterbox band over the top of the people row. The picture scales
  uniformly, and the box's own bars ride with it. It is gone within about 100ms.
- **The clip toast** (it has a resting transform) scales with the stream during T instead of gliding.
  After an H or S in theater it moves to its new center at once.
- **The pointer.** The shield blocks the pointer for 650ms per move on desktop.
- **Phone and compact.** The phone frame has no moves (G20 owns the phone shell). Compact browse is G7's
  overlay.
- **The pill clone** is a static copy that fades over the first 22% of the open. The pill itself is
  G12's and was not marked `data-motion-shared`; I find it by its classes (`.glass-pill[data-layout="row"]
  .glass-pill__surface`). If G12 renames those, the stage opens with a scale-and-fade instead (the
  no-origin branch).
- **Daily word conflict.** `DailyWordView` listens to letters on `window` without `preventDefault`.
  With the Daily word open beside a stage, S, T, H and C also act on the stage. The fix is one line in
  its handler, for its owner (G19/G21).
- **A PTT key bound to S, T, H or C** is claimed first by the voice keybinds (they `preventDefault`),
  so the stage key does not fire. That is the intended precedence.
- **Browse file.** No `Browse*.tsx` was needed: browse is the shell's panel plus this package's move
  and CSS.
- **Harness noise.** The mocked harness raises "Failed to save read position" toasts: the realtime
  stub refuses read-state acks. The spec clears them before each shot. Not a stage issue.
- **Processes.** I stopped everything I started: the scene holder by SIGINT (it left the call), Vite
  on 4437, the live instance on 18790, and the Playwright servers with their run. A second
  `paracord-server` (port 18760, data in `scratchpad/live-data`) was running before I began, is not
  mine, and was left alone.
