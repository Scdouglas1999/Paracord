# WP-G14 checkpoint: the stage, side by side

Contract: `docs/glass-spec.md` §1, §2, §5, §6 intro, §6.1, §9. Plan: `docs/design/glass-plan.md`
§1.2, §1.3, §8 (owner decisions), the WP-G14 row, §5 and §6 (the native underlay risk). Nothing is
committed. Everything is in `~/Documents/Paracord-glass` (branch `design/glass`).

The Stage slot is real. `components/glass/stage` exports the Glass `Stage`. The G7 stub
(`shell/stubs/StageStub.tsx`) is deleted, along with its adapter block (`.glass-stub-stage`) in
`glass-layout.css`. The `shell/stubs/` directory is now empty and removed. From Sean's client on a
real relay, 28 of 28 checks pass (below). The mocked shots match `04` and the stage part of `06`
to within a pixel on every measured box.

## What the stage does

**Watching** (`useStageWatch.ts`). The stage owns the watch, as G6 and G12 asked.

- **Open.** When the stage opens it calls `startWatch(target)` and `fetchWatchers`. The pill's
  Watch only calls `openStage`.
- **Switch.** Clicking another sharer's tile or chip ("Watch Luke's screen") calls
  `openStage({...target, streamerId})`. The stage then calls `startWatch` again, and the store
  replaces the running watch. There is no stop in between.
- **Close.** `stopWatch()` runs when the stage is *closed* (`glassStore.stage.mode === 'none'`),
  not when the component unmounts. So StrictMode's double mount, and any remount that keeps the
  stage open, never tears the watch down. "Stop watching" and Esc call `closeStage` and then
  `stopWatch`. Neither ever calls `leaveChannel`.
- **No timer anywhere.** A connecting watch reads "Connecting to Vincent's screen…" for as long
  as it takes. The Lantern 1.2 s auto-clear (`glass-fix-rejoin.md`, Bug 2 cause 2) is not
  replicated, and a unit test holds a connecting watch for 10 s to prove it. An `ended` or
  `failed` watch stays down with the server's or transport's own words and offers **Watch
  again**, because the store never retries. The other end states each say what happened:
  `superseded` gives "You started watching on another device.", `revoked` gives the reason with
  no retry, and a streamer who stopped gives "Vincent stopped sharing.".
- **Joining and leaving from the stage** work as G6 designed. The watch rides the call after a
  join and returns to its own session after a leave. The stream is re-subscribed only when
  `watchView.engine` changes (`StreamSurface.tsx`). A name that resolves late never
  re-subscribes it.

**Rendering** reuses the engines' own renderers. The stream is
`watchView.engine.subscribeVideo(streamerId, canvas, onFrame, { preferredTrackId: 'screen' })`,
and the engine decides the route (WebCodecs into the canvas, or a native surface that mirrors
the canvas box) once per track. Camera tiles use `voiceStore.mediaEngine.subscribeVideo(userId,
canvas, …, { preferredTrackId: 'camera' })`, and only while this client is in the watched call.
The stream's own audio belongs to the store (G6) and is never subscribed here.

**Native underlay on Linux** (`nativeUnderlay.ts`). The stream box and each camera tile are
`data-native-surface-boundary` and `data-native-underlay-clear`. Each one listens for
`paracord:native-surface-visibility`. While a surface is live:

- `<html data-native-underlay>` is set, refcounted.
- The box's canvas stops painting, with `visibility: hidden`, while keeping its layout box.
- The hole is nudged with `paracord:native-underlay-hole-ready` after the next paint.
- The controls drawn over the video (S, T, Stop watching) switch to near-solid fills with no
  blur (`html[data-native-underlay] .glass-stage__sbtn`).

The control row and the popovers sit outside the video. The popovers go through
`StreamOverlayPortal`, so the existing underlay CSS keeps them opaque, and they never count as
occluders. Nothing switches a route mid-stream, because the stage never asks for one.

**Layout** (`stageModel.ts`, `stageGeometry`). The stream is the full stage width minus 24, at
16:9, radius 18. It shrinks only when the window is too short to keep a 120 px people row. The
people row takes the rest of the height. The controls are 64 px, and the pane has 12 px insets
and gaps (the prototype's numbers). A `ResizeObserver` re-measures, so browse (the stage grows
to 1076 px) and short windows lay out correctly.

- **People row.** Anyone who joined with a camera gets a camera tile. The tiles have equal
  widths and radius 16. The talker gets a 2 px amber inner edge (an `::after` over the picture)
  plus a 24 px amber glow and the waveform. The waveform follows the real voice level when this
  client hears the call, and otherwise loops. Tiles show the name, and mic-off when muted.
- **Chips.** Everyone else gets a 200×52 chip in a column at the end of the row (`--solid`,
  face, name, state, mic-off). That includes listeners ("Listening in") and you ("You · Mic on").
  The state words are the pill's (`rosterState`).
- **Overlay.** The sidebar button (S, `glassStore.toggleBrowse`, `aria-pressed`), the amber live
  dot, "Vincent's screen", and "Game Night Lounge, live for 42 min" from `self_stream_started_at`
  (updated every minute). The watcher count is appended as " · 2 watching". On the right are the
  theater toggle (T, `setStageMode`, theater glyph; split glyph in theater) and **Stop watching**.

**Controls** (`StageControls.tsx`). Join is the only filled button on the screen.

| State | Row |
|---|---|
| Not joined (and listening, and connecting) | flame, heart, **Clip** \| mute preference (the pill's `useJoinMuteStore`, default muted), **Join** |
| Joined | mic, camera, share \| flame, heart, Clip \| **More**, **Leave** |

- **Actions** reuse the pill's (`pillActions.ts`): Join is `joinCall`, which applies the mute
  preference first and, from listening, is the in-place upgrade. Leave is `leaveCall`. The mic
  is `toggleMic`. The mute circle is `toggleJoinMute`. Camera is `toggleVideo`, with the failure
  toasted. Share (`useShareScreen.ts`) uses the same store calls and default quality as the
  Lantern bar. The desktop app uses its own source picker (`ScreenSharePickerModal`), and a
  failure is toasted with the reason.
- **Mic menu** (right-click, Shift+F10, or a long press on touch; `DeviceMenu`): **Deafen**
  (`toggleDeaf`, `aria-pressed`), plus the microphone and speaker pickers. The pickers use the
  same apply-then-persist logic as `InCallDeviceMenu`, which cannot be opened from outside, so
  the logic is ported rather than reused.
- **More** (joined only; a `role="menu"` with arrow, Home and End keys, and Esc returning focus):
  - Soundboard (with `USE_SOUNDBOARD`; the existing `SoundboardPopover`, anchored to More).
  - Watch together (when `useTogether()` has a call; `TogetherSheetFor`).
  - Invite people (with `CREATE_INSTANT_INVITE`; `InviteModal`).
  - Microphone and speaker (the mic's menu).
  - Connection check (`VoiceConnectionCheck`).
- **Narrow panes** give things up in order (`controlsFit`): first Clip loses its label, then
  flame and heart move into More.
- **Flame, heart and Clip** call the G16 and G17 stubs. Until those are filled, each is
  `aria-disabled` with its reason as the tooltip, and a press says "…not available in this
  version yet." as a toast. Nothing pretends to work.

**Keyboard.** Esc is Stop watching, bound on `window` so that any handler on the way can claim
the key first. Esc does not stop watching in these cases:

- While typing (input, textarea, select, contenteditable).
- While an on-screen menu, dialog or listbox is open.
- While a sheet (`glassStore.sheet`) is open.
- While browsing: Esc then puts the places panel away first.

Every control has an accessible name, and S, T, C and Esc are declared as `aria-keyshortcuts`.
The S, T and C keys themselves are G15's (`useGlassKeybinds`).

**Glow** (`useStageGlow.ts`). The watched stream is sampled once a second through G8's
`createViewFrameSource('watch', …)`, which follows the watch across engines and uses the shell's
downsample on the native route. The left and right fifths of a 16×9 draw are averaged, lifted
and clamped with G8's `roomColorFromAverage`, then eased (τ 1.5 s). The results are written as
channel numbers to `--stage-glow-l` and `--stage-glow-r` on the stage pane, which is the one
element outside the slot this package writes to. `glass-stage.css` turns them into the two side
shadows, `-50px 10px 140px` at 14% and `60px 0 150px` at 18%. Until the first sample, the room's
`--room-rgb` stands in for both. That write is at most once a second on one element, and nothing
animates a custom property.

**Phone** (390×844). The stage is the shell's 16:9 block above the conversation: the stream
fills it, and the overlay has the title, the count and a 36 px Stop watching. On the phone the
pill keeps the call controls (G12), so the stage draws no people row and no control row. G20
finishes it (spec §8: back, clip "30s", fullscreen).

## Stub contracts for G15, G16 and G17 (the next packages own these files)

**G16: `client/src/lib/media/clips/useClip.ts`**

```ts
export interface ClipTarget { serverId: string; guildId: string; channelId: string; streamerId: string; streamerName: string }
export interface ClipControl {
  available: boolean;               // a clip can be cut now
  unavailableReason: string | null; // sentence for the tooltip when not
  saving: boolean;
  clip: () => Promise<void>;        // resolves when saved (the toast then offers Post to General); rejects with the reason
}
export const CLIP_SECONDS = 30;
export function useClip(target: ClipTarget | null): ClipControl;
```

The stage calls `useClip({ ...target, streamerName })` for the Clip button. The stub returns
`available: false` and a rejecting `clip()`.

**G16: `client/src/components/glass/stage/ClipToast.tsx`.** It exports
`ClipToast({ target }: { target: ClipTarget })`, and the stub renders `null`. It is mounted inside
the stream box (chrome over the video, inside the native-surface boundary), after the overlay. It
decides for itself where "Post to General" posts, which is the route's channel. The C key is the
G15/G16 keybind. `aria-keyshortcuts="C"` is already on the button.

**G17: `client/src/components/glass/stage/StreamReactionsLayer.tsx`**

```ts
export type StreamReactionKind = 'fire' | 'heart';
export interface StreamReactionTarget { serverId: string; guildId: string; channelId: string; streamerId: string }
export interface StreamReactions { available: boolean; unavailableReason: string | null; send: (kind: StreamReactionKind) => void }
export function useStreamReactions(target: StreamReactionTarget | null): StreamReactions;
export function StreamReactionsLayer(props: { target: StreamReactionTarget }): JSX.Element | null;
```

The flame and heart buttons (and their More entries on a narrow pane) call `send`. The layer is
mounted inside the stream box, positions itself (bottom right, 24 px in, §6.5) and must stay
`pointer-events: none`. The stubs return `available: false` and render nothing.

**G15.**

- **Theater.** `Stage` receives `mode`. Until G15 lands, theater draws the side-by-side layout in
  the full-window pane. Branch in `Stage.tsx` to a `Theater*.tsx` of G15's. The watch, Esc and
  the glow hooks are mode-independent and should stay in `Stage`.
- **Keybinds.** Move the Esc listener into `useGlassKeybinds` if you centralize keys. The rules
  in `escapeBelongsElsewhere` are what make Esc safe.
- **Transition.** There is no pill-to-stage transition yet. The stage appears in place.
- **Hooks for the move.** `.glass-stage__stream` is the element to move. On the native route,
  show a poster during the move and let the surface attach after the move settles (plan §6).
- **Browse.** It works now through the shell (G7) and the S button. Only the move is missing.

## Files

New:

| File | What it is |
|---|---|
| `client/src/components/glass/stage/Stage.tsx` | The slot: overlay, stream, people, controls, geometry, Esc, glow |
| `stage/stageModel.ts` | Pure: people, labels, notices, geometry, control fit |
| `stage/useStageData.ts` | Store slices to the model; the watcher count; a minute clock |
| `stage/useStageWatch.ts` | Watch lifecycle; `stopWatching()` |
| `stage/StreamSurface.tsx` | The stream box and its canvas subscription |
| `stage/StagePeople.tsx` | Camera tiles and chips; switching the watch |
| `stage/StageControls.tsx` | The two control sets, More, dialogs |
| `stage/StageMenus.tsx` | The mic's menu (Deafen, devices) and More |
| `stage/useShareScreen.ts` | Share start and stop, the desktop source picker |
| `stage/nativeUnderlay.ts` | The underlay hole refcount and visibility hook |
| `stage/useStageGlow.ts` | The sampled side glow |
| `stage/StreamReactionsLayer.tsx`, `stage/ClipToast.tsx` | G17 and G16 stubs |
| `client/src/lib/media/clips/useClip.ts` | G16 stub |
| `client/src/styles/glass-stage.css` | All of the above's styles (tokens only), the pane glow, underlay and reduced-transparency rules |
| `stage/stageModel.test.ts` (18), `stage/Stage.test.tsx` (25) | Unit tests |
| `client/e2e/glass-stage.spec.ts`, `glass-stage.config.ts`, `glass-stage-dev.mjs` | Mocked shots on ports 4423/4425 |
| `client/scripts/glass-scene/stage-live.mjs` | The live proof |

Changed:

- `stage/index.ts`: the real export.
- `styles/globals.css`: one import line after `glass-pill.css`, unlayered.
- `styles/glass-layout.css`: the `.glass-stub-stage` block removed.
- `pages/AppShell.test.tsx`: the stage slot is mocked instead of `StreamViewer`, and the side
  test asserts the slot gets the target and mode.
- `scripts/glass-scene/shots.mjs`: `04-side-by-side` is driven through the Glass controls: pill
  Join, then pill Watch, then Vincent's scene verified inside the stage's stream box.
  `06-browse` is reachable now (pill Watch, then S). `keepStageFrame` is the shared check.
- `scripts/glass-scene/ui.mjs`: `CONTROLS` knows `Join Lounge`, `Leave Lounge`,
  `Stop watching` and `Show servers and channels`.

Deleted: `components/glass/shell/stubs/StageStub.tsx`.

## Commands

Run in `~/Documents/Paracord-glass/client`.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 397 files, 4,040 tests (the whole client, other packages' work in progress included) |
| `npx vitest run src/components/glass/stage` | pass: 2 files, 43 tests |
| `npm run test:tokens` | pass (812 files) |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors, 253 warnings, the same count G12 reported. `npx eslint` on every file of mine: 0 problems |
| `npm run test:contrast` | pass (52,950 comparisons) |
| `npm run test:a11y:static` | pass |
| `PARACORD_E2E_GLASS_WP=g14 npx playwright test -c e2e/glass-stage.config.ts` | pass, 8/8 (own ports 4423/4425) |
| `node scripts/glass-scene/stage-live.mjs` against a live instance | pass, 28/28 |
| `glass-scene.mjs --shot 04-side-by-side,06-browse` against a live instance | both shot through the Glass controls |

## Live proof (2026-09-30, the embedded build, a real relay)

Setup:

- `npm run build`, then `touch crates/paracord-server/src/embedded_ui.rs`, then
  `pc-cargo.sh build --release --bin paracord-server`.
- The served bundle `assets/index-CK_FiGkG.js` matched `client/dist`.
- `live-env.mjs --port 18740` with its data in the scratchpad.
- `glass-scene.mjs --hold` (Vincent sharing, Brendan on camera, Nick muted, each in their own
  Chromium).

Unlike G6 and G12, the probe does not use a Vite server or store imports. Sean and Luke run the
very build the instance serves, and the probe drives only visible controls.

`client/scripts/glass-scene/stage-live.mjs` passed 28 of 28 (shots in
`output/design-reference/glass-build/g14/live/`):

- **Watch without joining.** The pill's Watch opens the stage and the pill steps aside. Vincent's
  frames render in the stream box: 4,817 px teal and 18,130 px amber in a screenshot of that box.
  The relay does not have Sean, and the stage offers Join. The overlay names "Vincent's screen"
  and "Game Night Lounge". Brendan has a camera tile. The server counts 1 watcher, and Sean's
  stage says "1 watching".
- **Visible to others.** Luke, another account in his own browser, opens the same stream. His
  stage says "2 watching", and so does Sean's. Luke stops, and Sean's goes back to "1 watching".
- **Join from the stage.** The relay has Sean, and the stage switches to the joined controls
  (Leave, no Join). Brendan's camera draws in his tile (546 colors). The stream is still on
  screen immediately and 6 s later, when the watch has moved onto the call. It is still counted
  once.
- **Stop watching keeps the call.** The stage closes, the relay still has Sean, the pill shows
  "Leave Lounge", and the server's count drops to 0.
- **Leave from the stage.** Sean watches again inside the call and presses Leave on the stage.
  The relay drops Sean and the stage stays open. The stream is still on screen immediately and
  6 s later, because the watch moved back to its own session. It is counted once.
- **Esc** stops watching. There were no page errors in either client.

`glass-scene.mjs --shot 04-side-by-side,06-browse` (shots in
`output/design-reference/glass-build/g14/live-scene/`):

- **04.** Sean joins with the pill's Join and watches with its Watch. Vincent's scene shows in
  the stage (4,830 px teal, 10,422 px amber), and the share is still there 3 s later.
- **06.** From Clips, Sean presses Watch and then S. The places panel is back, the stage is
  1076 px wide, and Vincent's scene is on screen.

Everything I started was stopped afterwards: the scene holder by SIGINT (it left the call), then
live-env, and the Playwright servers exit with their run. Ports 18740/18741 and 4423/4425 are
free.

## Against the references (mocked, 1440×900; `output/design-reference/glass-build/g14/`)

| | Reference (`04` / `06`) | Mine |
|---|---|---|
| Stage pane | 16,16 972×868 r28 | 16,16 972×868 (the shell) |
| Stream | 28,28 948×533 r18 | 28,28 948×533 |
| People row | tiles at y 573, 223 tall; chips 200×52 at x 776, 60 apart | tiles y 573 h 223; chips x 776, y 573 / 633 / 693 |
| Conversation | 1004,16 420×868 | 1004,16 420×868; a staged draft survives opening the stage (e2e) |
| `06` controls | flame 715, heart 769, Clip 823–907, mute 936, Join 990–1058 | 714.1, 768.1, 822.1–906.4, 935.5, 989.5–1057.9 |
| `06` browse | stage 348 w1076; stream 1052×592; row 164 | 348 w1076; 1052×592; 164 |
| `04` controls | mic 260, cam 314, share 368, flame 441, heart 495, Clip 549–633, Leave | the same run with **More** (44 px) before Leave, so the row sits 27 px further left |

Shots: `stage-04-side-joined-desktop.png`, `stage-06-side-not-joined-desktop.png`,
`stage-06b-browse-not-joined-desktop.png`, `stage-more-menu-desktop.png`,
`stage-mic-menu-desktop.png`, `stage-04-phone.png`, `stage-06-phone.png`, and `stage-rects.json`.

Differences, each deliberate or someone else's:

1. **More** is in the joined row. The owner decided that (plan §8.4), and the reference predates
   it.
2. **" · 2 watching"** follows "live for 42 min". The brief requires the count to be visible,
   and `04` has no place for it. Remove the one span if the owner disagrees.
3. **Vincent has no camera** in either scene, so he is a chip ("Sharing screen") and Brendan's
   tile takes both tile slots. The reference's cast gives Vincent a camera. Nothing is tuned to
   that.
4. **Not joined, the camera tiles show faces, not video** (`06` shows video). A watch carries
   exactly one stream, the screen and its own audio (G5 relay: "a view session: receive-only,
   one stream"). Before you join, Brendan's tile shows his face where the picture will be, and
   the picture arrives on Join, which was proven live. Showing cameras before joining needs the
   view to carry camera tracks. That is a G5/G6 and owner question, because it changes what
   "Watch" costs and what it reveals.
5. **Camera tiles letterbox** instead of cropping (see the live shots: Brendan's 4:3 fake camera
   has side bars). `CanvasRenderer.measureRenderSize` in `lib/media/video/canvasRenderer.ts`
   hard-codes *contain*. It is not mine to change. Oversizing the canvas and cropping it with CSS
   would push a native surface past the tile's edges on the Linux route, because native surfaces
   are not clipped by CSS. The fix is a `fit: 'cover'` option on `subscribeVideo` and in
   `CanvasRenderer` (lib/media owner), after which the tile passes `fit: 'cover'`.
6. **The mocked stream** is G2's fixture (its crystals resolve to cream under Glass). Live, it is
   Vincent's real scene, teal and amber.
7. **The glow** in the mocked shots is the fixture's gray-amber, and the live one is sampled
   teal and amber. It is subtler than the prototype's hand-set teal. The strengths are the
   prototype's alphas (14% and 18%), applied to clamped room colors.
8. **Faces are initials** in the mocked shots and real avatars live.

## Left for others, and what to remove later

- **G22 (retire Lantern).**
  - `pages/guild/VoiceStageChannel.tsx` is still what a voice channel's route renders
    (`GuildPage.tsx:176`), with its own watch path (`setWatchedStreamer`), `SplitPane`,
    `StreamViewer`, `useWebcamTiles`, `useScreenShareSubscriptions` and the 1.2 s auto-clear.
    None of it is on the Glass watching path any more, which is the stage alone.
  - `pages/DMPage.tsx:297` still shows a DM call's stream with `StreamViewer`.
  - `StreamViewer` keeps its own underlay refcount beside `stage/nativeUnderlay.ts`. The two
    only conflict if a Lantern `StreamViewer` and the stage show a live native surface at once,
    which cannot happen on the Glass watching path. Delete it with `StreamViewer`, or have DM
    calls use `nativeUnderlay.ts`.
  - `useShareScreen.ts` and `StageMenus.tsx` port `getStreamErrorMessage` and the
    `InCallDeviceMenu` device logic. Dedupe them when `VoiceControlBar` and `InCallDeviceMenu`
    go.
- **Voice channel chat beside the stage** (owner decision, §8.4). The conversation beside the
  stage is the route's channel, and G7 keeps it mounted. A voice channel's route still renders
  the Lantern `VoiceStageChannel` instead of its text chat (`RoomChat`) in the conversation
  pane. That is `GuildPage` (G7, G9, G19), not the stage.
- **G15.** Theater, the transitions, and the S, T, H and C keys (see above).
- **G16 and G17.** Fill the stubs (see above).
- **G20.** The phone stage's back, clip "30s" and fullscreen overlays, and radius 22. Its
  compact-frame side by side (768 to 859 px) squeezes the stage beside the 420 px conversation.
  The stage lays itself out correctly there, and the controls give up labels, but the frame
  decides whether that layout should exist.
- **lib/media (G6b's area).** A `fit: 'cover'` option for camera tiles (difference 5).
- **Desktop app not run.** The native-underlay route is implemented by the same contract
  `StreamViewer` follows (the same events, attributes and CSS) and is unit-tested at the event
  level. It was not run in Tauri/WebKitGTK here; that is WP-G23.
