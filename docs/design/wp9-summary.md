# WP9 — every motion moment in the product

One page. What moves, where it lives, which gate case watches it, and what the
gate is allowed to forgive. The law is
[`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5; the per-package
reasoning is in the checkpoints beside this file
([WP9a](wp9a-checkpoint.md) · [WP9b](wp9b-checkpoint.md) ·
[WP9c](wp9c-checkpoint.md) · [WP9d-light](wp9d-light-checkpoint.md) ·
[WP9d-hard](wp9d-checkpoint.md)).

Every gate case below lives in `client/e2e/motion-gate.spec.ts` and runs under
`PARACORD_E2E_MOTION=1 npm run test:motion` (28 cases: 22 measured, 6 frame
strips that are opt-in behind `PARACORD_E2E_MOTION_FRAMES=1`).

---

## WP9a — the engine, and one signature moment

| Moment | Where it lives | Gate case |
|---|---|---|
| The motion engine: recipes, the one reduced-motion switch, `run()`'s `data-motion-recipe:<name>` ids | `client/src/lib/motion/` (`animate.ts`, `arrive.ts`, `flip.ts`, `index.ts`), tokens in `styles/tokens.css` §5.2 | every case (the ids are what the gate reads) |
| **Say something** — the words lift out of the composer, the composer relaxes, the send control catches a beat of light, the room's window flickers, the row lands 26px from below | `message/MessageInput.tsx`, `message/MessageList.tsx`, `layout/TopBar.tsx`; the recipes (`liftOut`, `relax`, `flash`, `flicker`, `arriveIn`) in `lib/motion/animate.ts`, handed over on `lib/motion/bus.ts` | `say something holds 60fps and stays inside the duration budget` · `a pointer send plays the same moment` |
| The receipt fading in behind the row | `MessageList.tsx` | (inside the send cases) |
| Numbers re-roll | `RollingNumber` in `lib/motion/flipCounter.tsx`; `TopBar`, `HereNowStrip` | `every engine recipe on /design-tokens holds the budget` (`#motion-roll`) |
| Frame strips | — | `capture the send moment as a frame strip` → `output/design-reference/motion/frames-wp9a` |

## WP9b — the building's three moments

| Moment | Where it lives | Gate case |
|---|---|---|
| **Lights on** — the building wakes after a reconnect: plates settle, windows and rims bloom, staggered | `components/motion/MotionDirector.tsx`, the edge in `lib/attention/lightsOn.ts`, the sweep in `lib/motion/lightsOn.ts` | `lights on: the building wakes, and the whole sequence lands inside 1.6s` · `lights on does not fire again for a route change or a re-render` |
| **Walk into a room** — the room card becomes the Stage's dominant tile; chrome recedes | `rooms/lobby/RoomCard.tsx`, `voice/stage/StageLayout.tsx`, `lib/motion/walk.ts` (`walkIntoRoom` / `recedeAround`) over `lib/motion/sharedElement.ts` | `walk into a room: the Web Animations path` · `walk into a room: the View Transitions path is the same choreography` |
| **Someone arrives / leaves** — the window lights, the rim takes them, the strip and the counts move | `lib/attention/arrivals.ts`, `lib/motion/arrive.ts`, `light/LitAvatar.tsx`, `light/AvatarStack.tsx`, `light/HereNowStrip.tsx`, `light/WindowMap.tsx` | `someone arrives: window, rim, the strip, and the counts` · `five people in one beat are one choreography, not five` · `leaving is the mirror` |
| Frame strips | — | `capture the three moments as frame strips` → `frames-wp9b` |

## WP9c — systematic micro-motion

Twelve items; the engine's four missing pieces (`presence.ts`, `flipList.ts`)
are what most of them ride on. **`framer-motion` left production code here.**

| Moment | Where it lives | Gate case |
|---|---|---|
| **Controls are tactile** — 1px hover lift + wash, 0.96 press, spring back | `.pc-pressable` / `.pc-pressable-accent` in `styles/primitives.css`; `Button`, `IconButton`, `NavRow`, `Chip`; `.btn-primary`, `.icon-btn`, `.context-menu-item`, `.hover-action-btn`, `.command-icon-btn` | `every engine recipe…` (`#motion-press`) |
| **Switch, tabs, segmented controls** — one travelling indicator | `ui/Switch.tsx`, `ui/Tabs.tsx`, `lib/motion/flipList.ts#useIndicator` | `every engine recipe…` (tabs strip) |
| **One enter, one exit for every overlay** — `pc-enter` / `pc-exit` / `pc-fade` / `pc-drawer-*` / `pc-sheet-*` / `pc-banner-*` | `styles/primitives.css`; `Modal`, `Popover`, `ContextMenu`, `Tooltip`, `Toast`, `ImageLightbox`, `AppShell`, `ConnectionStatusBar`, `RestartBanner`, `UpdateNotification`, `LayoutTour`, `SlashCommandPopup`, `MessageInput`, `EmojiPicker`, `GifPicker`, `StickerPicker`, `UserProfile` — all via `lib/motion/presence.ts#usePresence` | `a dialog opening and closing holds the budget` (enter, exit, and the exit's own opacity samples) |
| **Plates settle** onto a street that is already there | `ui/Plate.tsx`, `light/RoomThumbnail.tsx`, `lib/motion/presence.ts#useSettleIn` | `every engine recipe…` (`#motion-settle`) |
| **Lists re-sort by travelling** | `layout/sidebar/BuildingsColumn.tsx`, `BuildingSection.tsx`, `RoomRow.tsx`, `ui/Toast.tsx`, `lib/motion/flipList.ts` | `a list reordering holds the budget` |
| **Every count re-rolls** | `RoomRow`, `BuildingsColumn`, `BuildingSection`, `AvatarStack`, `InboxOverlay`, `MessageList` | `every engine recipe…` (`#motion-roll`) |
| **The phone chat sheet travels** instead of resizing | `voice/stage/RoomChatRibbon.tsx`, `flipList.ts#flipBetween` | (covered by the reduced-motion case and the WP9c strips) |
| **The on-air dot breathes only while somebody talks** | `hooks/useLights.ts`, `light/OnAirPill.tsx`, `layout/sidebar/CallDock.tsx`, `.pc-live-dot.is-speaking` | infinite breathe — asserted present, exempt from the duration budget |
| **Skeletons crossfade to content** and stop pulsing | `ui/Skeleton.tsx` (`SkeletonSwap`), `EmojiPicker`, `GifPicker`, `StickerPicker`, `DiscoveryPage`, `MessageList`, `Lobby`, `GuildStateScreens` | reduced-motion case (`.pc-skeleton` must be silent) |
| **Message hover actions arrive** | `MessageList.tsx` (`pc-hover-in`) | WP9c strips (`_still-hover-actions.png`) |
| **The typing ellipsis breathes** | `MessageList.tsx` (`TypingDots`), `.pc-typing-dots` | reduced-motion case |
| **Focus rings arrive** rather than appearing | `pc-ring-in` in `primitives.css`; `.pc-focusable`, `.pc-checkbox`, `.btn-primary`, `.input-field`, `.icon-btn`, `.context-menu-item`, `.command-icon-btn` | — (CSS-only, no JS to measure) |
| Frame strips and two stills | — | `capture the WP9c moments as frame strips` → `frames-wp9c` |

## WP9d-light — further moments, the surface half

| Moment | Where it lives | Gate case |
|---|---|---|
| **A reaction pops** — yours from 0.6 with the emoji over-rotating 8°, theirs from 0.8; removing shrinks it back out | `MessageList.tsx` (`ReactionRow`), `lib/motion/flipList.ts` (`enter: 'pop'`, `data-flip-own`, `data-flip-glyph`) | `a reaction pops — yours bigger, theirs smaller, the leave shrinks` (asserts the declared keyframes, not just the ids) |
| **The room's window breathes while somebody writes** — half the speaking ring's amplitude | `layout/TopBar.tsx`, `.pc-window.is-writing` in `primitives.css`, `--glow-window-amber-breathe` in `tokens.css` (all three themes) | `the typing pulse breathes while somebody writes, and ends when they stop` (scoped to the room, proven running then proven stopped) |
| **Contextual plates slide in from their edge** | `pc-drawer-in/out-left/right` in `primitives.css`; `pages/AppShell.tsx`, `layout/ContextPanel.tsx`, `user/UserProfile.tsx`, `MessageList.tsx`, `pages/FriendsPage.tsx` | `a contextual plate slides in from its edge` (enter, exit, and the exit's own opacity samples) |
| **The phone's pull reveals the room's lamp** | `MessageList.tsx` (`data-motion-lamp`, coarse-pointer only) | `a pull far enough lights the lamp, flickers, and refetches` · `a pull that lets go early just dims the lamp back out` |
| Frame strips | — | `capture the WP9d-light moments as frame strips` · `pulling the timeline down, frame by frame` → `frames-wp9d` |

## WP9d-hard — the ring, the lights, the power

| Moment | Where it lives | Gate case |
|---|---|---|
| **The speaking ring takes the voice** — +15% of the resting glow at full voice, 60ms attack / 240ms release, never below rest | `lib/motion/voiceLevel.ts` (one rAF loop for every tile), the ring parts in `tokens.css`, `.pc-speaking` composed in `primitives.css`; marks `data-motion-person` and `data-motion-speaking`; sources wired in `stores/voiceStore.ts` | `the speaking-ring level driver holds 60fps and grows nothing` (frames, composed `box-shadow` alphas at rest vs full voice, and heap growth over 300 frames) |
| **The theme change is the lights changing** — the shell crosses over `--duration-dim`, then the light elements re-bloom | `lib/motion/lights.ts` (`changeLights`), the `lights-change` stamp in `primitives.css`, `ThemeSelector` | `theme change: the whole shell crosses over, and the lights re-bloom` · `theme change: the View Transitions path is the same moment` |
| **The power goes** — the gateway is away, so the whole building dims 30% and holds; the relight replays WP9b's sweep over the plates that went dark | `lib/attention/outage.ts` (600ms grace), `lib/motion/lights.ts` (`dimBuilding` / `relightBuilding`, the `#pc-motion-lights` scrim), played by `components/motion/MotionDirector.tsx` | `the gateway goes away: the building dims, and relights when it is back` |
| **No spinner on the street** — the banner says the words with a static glyph | `components/ConnectionStatusBar.tsx` (on `usePresence` + `pc-banner-in/out`) | the outage case asserts `.animate-spin` has count 0 |
| Frame strips | — | `capture the WP9d-hard moments as frame strips` (plus a `_voice-level-*` calibration strip that holds the breathe still) → `frames-wp9d` |

## Across every package

| | |
|---|---|
| `/design-tokens` › Motion | Fifteen cards, each replaying a real recipe: `#motion-bloom`, `#motion-dim`, `#motion-flicker`, `#motion-settle`, `#motion-press`, `#motion-stagger`, `#motion-roll`, `#motion-reorder`, `#motion-pop`, `#motion-writing`, `#motion-plate`, `#motion-voice`, `#motion-outage`, `#motion-lights-change`, `#motion-shared`. `every engine recipe on /design-tokens holds the budget` sweeps the nine finite element recipes; the other six have their own cases (`#motion-reorder` → the reorder case, `#motion-shared` → the two walk-in paths, `#motion-voice` / `#motion-outage` / `#motion-lights-change` → the WP9d-hard cases, `#motion-writing` → the typing pulse, which is an infinite breathe and so is asserted rather than budgeted). |
| Reduced motion | One authority — the `data-motion` attribute in `utilities.css`, plus the four targeted `animation: none` rules where the 0.01ms blanket would *finish* a breathe instead of stopping it (`.pc-skeleton`, `.pc-typing-dots > span`, `.pc-window.is-writing`, `.pc-speaking` — which also pins the ring back to `--ring-speaking`, since the level driver does not run either). Gate case: `reduced motion runs no animations at all`, which carries every package's assertions. |

---

## The budget, and what is allowed by name

The default for every measured moment (`expectBudget`):

- no animating frame over **32ms** (§5.3), at the 95th percentile and as a count;
- no frame anywhere in the moment over **50ms** — a long task fails regardless;
- no single animation longer than **500ms**; no staggered sequence past **1600ms**.

Everything below is an exception written into the spec file by name, with the
measurement that justifies it. There are no others.

| Allowance | Case | Why |
|---|---|---|
| **1 dropped frame** | `say-something (keyboard)` · `say-something (pointer)` | `MessageList`'s own render of the arriving row. It drops with motion switched off entirely — the reduced-motion case plays nothing and drops the same frame. |
| **1 dropped frame** | `walk-in (flip)` | The destination route's first render. The reduced-motion case measures and reports the same click with the engine silent (`walk-in (reduced motion — the app alone)`). |
| **1 dropped frame** | `arrival burst (4 at once)` | The app's commit of four arriving faces into the stacks that hold them — ~33ms at +50ms with nothing in flight but the stacks' own `margin-left`. Reported with the engine off as `arrival burst (reduced motion — the app alone)`. |
| **1 dropped frame** | `lights-change (crossfade)` | The frame `data-theme` is applied on: React re-renders the page and the browser restyles every surface under it. The dip exists so it happens where nobody can see it. Reported with the engine off as `lights-change (reduced motion — the app alone)`. |
| **Frames not gated** (`{ frames: false }`) | `motion-shared (view transitions)` · `walk-in (view transitions)` · `lights-change (view transitions)` | The browser snapshots the whole viewport and composites off the main thread; this harness is a software-rendered headless Chromium with no GPU (wp9a-checkpoint §4). The choreography is still asserted, and the Web Animations path of each is frame-gated. |
| **Exempt from the 500ms duration budget** | the speaking ring, the writing pulse, the on-air dot | Infinite breathes. §5.3 exempts breathing; the sampler skips infinite animations, and each one is asserted to *exist* and to be scoped correctly instead. `#motion-writing` is deliberately absent from the recipe-card sweep for this reason. |
| **Animations under 1ms active duration ignored** | `reduced motion runs no animations at all` | Chromium leaves 0.01ms `scrollbar-color` transitions that a headless page never produces a frame to retire, so `document.getAnimations()` is never literally empty. The filter is "nothing that could move"; any real-duration animation still fails. |
| **Frame strips are opt-in** | the six `capture …` cases | A CDP screencast is the only way to get real frames out of a 120–600ms moment. They skip unless `PARACORD_E2E_MOTION_FRAMES=1`, and all six share one `captureStrip` writer — zeroed on the act by default, or on the first frame the engine moved (`zeroOnEngine`) where the moment starts with a gateway round trip. |
