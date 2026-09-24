# WP9c — Systematic micro-motion

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5, and §10
row **WP9c**. Branch `design/wp9c`, on top of WP9a's engine
([`wp9a-checkpoint.md`](wp9a-checkpoint.md)).

Twenty commits, `b1f0343..HEAD`, the last two of them this file. 58 files,
+2 995 / −706.

| | |
|---|---|
| `c1c31db` | the engine's missing pieces: presence, list FLIP, sliding indicator |
| `45d9cb8` | **3** one enter and one exit, for every overlay in the product |
| `89add48` | **1** controls are tactile — one lift, one press, everywhere |
| `ec52987` | **12** the focus ring arrives rather than appearing |
| `9b43833` | **2** the thumb and the tab indicator slide, never jump |
| `bdf10f8` | **4** a plate settles onto a street that is already there |
| `99a092e` | **5** the sidebar re-sorts by traveling, not by redrawing |
| `99c07a2` | **6** every count that changes now re-rolls |
| `7821b5f` | **7** the phone chat sheet travels instead of resizing |
| `752706b` | **8** the on-air dot breathes only while somebody is talking |
| `2c601a5` | **9** skeletons crossfade to content, and stop pulsing |
| `12cc307` | **10** the hover toolbar arrives, and a reaction pops |
| `3f59c04` | **11** somebody is typing, and the dots breathe |
| `98744ef` | the gate measures a dialog and a reorder |
| `adb00db` | what the frame strips showed — the roll flashed its answer first |
| `f73f543` | a leave starts on the frame it was asked for |
| `e4643cd` | two stills for the surfaces restructured without animating |
| `1303ed5` | this checkpoint |
| `661225d` | the leaving surface is proved to be out of the accessibility tree |

WP9a built the engine and one signature moment. §5.1 describes a product where
*everything* answers — controls, indicators, overlays, lists, counts — and none
of the rest of it did. This package is the rest of it, CSS-first: the engine's
JavaScript is used only where CSS genuinely cannot express the thing (a list
FLIP, a tab indicator's travel, a number rolling, keeping a React node mounted
for its own exit).

**`framer-motion` is now gone from production code.** Ten components were still
on it, and `AppShell` still wrapped the app in `MotionConfig reducedMotion="user"`
— a second reduced-motion authority sitting above the one switch §5.3 names.

---

## 1. The engine's four missing pieces — `client/src/lib/motion/`

WP9a's engine had recipes but no way to hang them on the two places React owns:
an element leaving, and a list changing shape.

| Module | What it is |
|---|---|
| `presence.ts` · `usePresence(open)` | Keeps a node in the tree for the 120ms its leave takes, and nothing more — enter and exit are the shared CSS classes. **Both edges are decided during the render that changed `open`**, never in an effect. |
| `presence.ts` · `useSettleIn()` | §5.1's "a plate entering the street rises 14px", with the exception §5.3 needs: the module flips a flag two rAFs into the app's life, so a plate present at first paint does not settle and one mounting into a lit street does. |
| `flipList.ts` · `useFlipList()` | A container whose marked rows reorder. Moved rows travel on the spring over `--duration-move`; arrived rows `rise` (6px) or `pop` (0.6→1); removed rows leave a falling ghost. Nothing on a first commit. |
| `flipList.ts` · `useFlip` / `flipBetween` | One element that re-lays itself out — the phone chat sheet's height. |
| `flipList.ts` · `useIndicator()` | A tab thumb: the mark and the traveling element are measured in one effect rather than racing, with velocity carried when the mark moves mid-travel. |

Three details in there are the difference between working and looking like it
works, and all three are the sort of thing only a measurement or a recording
finds:

**Opening is synchronous.** Every overlay in this product places itself in a
layout effect keyed on `open` — a popover against its anchor, a menu clamped to
the viewport. A node that arrives one commit *after* that effect has run is
measured as nothing and never placed: the popover renders at `visibility:
hidden` forever. `usePresence` therefore sets `mounted` during the render that
set `open`, using React's documented "adjusting state during render" hatch.
Only the *leave* is deferred, and a leave has nothing to measure. Closing is
decided in render for the smaller version of the same reason: the exit class
has to be on the element on the frame it was asked for, or a 120ms leave spends
its first frame not leaving.

**A leaving surface is scenery.** `usePresence` hands back `scenery` props
(`aria-hidden`, `inert`) and `.pc-exit` takes the pointer out of it. A dismissed
menu that is still clickable and still announced for 120ms is not an animation.

**Rows are measured against the container, not the viewport.** A viewport rect
moves when a list scrolls, so a store update arriving mid-scroll read every row
as having moved and animated the whole column back to where the scroll had just
taken it. Deltas are computed in the container's own content box, so a delta
only ever means a reorder. A removed row's ghost is `position: fixed` and would
escape the container's clip, so it is only painted where the row was actually
visible, and it carries the container's own z-index.

## 2. The items

### 1 · Controls are tactile
`.pc-pressable` / `.pc-pressable-accent` in `primitives.css`; carried by
`Button` (every variant but `link`), `IconButton`, `NavRow`, `Chip`, and by
`.btn-primary`, `.icon-btn`, `.context-menu-item`, `.hover-action-btn`,
`.command-icon-btn` in `components.css`/`layout.css`.

Hover is a 1px lift and a `--bg-mod-subtle` wash over `--duration-fast`; press
is 0.96 for 80ms on `--ease-out` and a spring back on `--duration-normal`
(a single symmetric transition reads as a wobble); accent buttons take the
one-beat `--light-white` flash as an opacity-only veil. Disabled gets none of
it, and the hover half is behind `(hover: hover)`.

**The wash is a gradient, not a background color.** `none` → gradient is a
*discrete* step in CSS: a `background-image` transition from nothing snaps
instead of easing, so the bloom §5.1 asks for over 120ms simply appeared. It is
transparent-to-transparent at rest, which interpolates, and it layers over
whatever fill a variant already carries.

`Button` also stops being a `motion.button`: its `whileTap` was 0.97 on a curve
that is in neither of §5.2's two, on the most-rendered component in the product.

### 2 · Switch, tabs, segmented controls
`Switch.tsx`, `Tabs.tsx`, `flipList.ts#useIndicator`.

The Switch thumb was traveling on `--ease-out` over `--duration-fast` — the
fade curve at the fade speed. It is `--duration-normal` on the spring now, and
its `--thumb-glow` is a real light that fades in over `--duration-warm-up` when
the switch goes on rather than being painted into the thumb's fill.

Tabs had no indicator at all: selection moved by one tab painting its own
raised surface and another un-painting. There is now ONE surface and the engine
slides it — the segmented pill and the underline bar are the same element with
different geometry.

### 3 · Modal / ConfirmDialog / Popover / ContextMenu / Tooltip / Toast
`primitives.css` (the shared set), `Modal`, `Popover`, `ContextMenu`, `Tooltip`,
`Toast`, `ImageLightbox`, `AppShell` (five overlays), `ConnectionStatusBar`,
`RestartBanner`, `UpdateNotification`, `LayoutTour`, `SlashCommandPopup`,
`MessageInput`, `EmojiPicker`, `GifPicker`, `StickerPicker`, `UserProfile`.

One arrival and one departure: `pc-enter` is opacity + a 6px rise on the spring
over `--duration-slow`; `pc-exit` is opacity + a 4px fall on `--ease-in` over
`--duration-fast`; `pc-fade` is what a backdrop does; `pc-drawer-*`, `pc-sheet-*`
and `pc-banner-*` are the same recipe pointed at their own edge. Each keyframe
declares only its OFF state, so a surface that stays mounted animates exactly
once and the pair reads the same forwards and backwards.

The five ad-hoc keyframes (`modal-enter`, `overlay-enter`, `popup-enter`,
`scale-in`, `toast-slide-in`) are **deleted**.

Toasts are one FLIP'd stack. `ContextMenu` gained an `open` prop because its
four call sites unmounted it to close it, which is a leave nobody can see; it
keeps the last position so the exit plays where the menu was. The on-air dock
stops animating its own `height`, which §5.3 forbids outright.

### 4 · Plates settle
`Plate.tsx`, `RoomThumbnail.tsx`, via `useSettleIn`.

### 5 · List reorder FLIP
`BuildingsColumn.tsx` (the container), `BuildingSection.tsx` and `RoomRow.tsx`
(the keys), `Toast.tsx` (the stack).

The Servers column is ranked by attention and re-sorts whenever a channel lights
or a mention lands; every one of those was a silent redraw. Interruptible (a
second re-rank retargets from the velocity the row had), silent on first mount,
instant under reduced motion.

### 6 · Number re-roll
`RoomRow` (mention chip), `BuildingsColumn` (needs-you and unread chips),
`BuildingSection` ("24 in", "N more channels"), `AvatarStack` ("+M"),
`InboxOverlay` (tab counts, per-conversation mentions), `MessageList`
(reaction tallies) — on top of WP9a's `TopBar` and `HereNowStrip`.

Every one passes `announce={false}`: each already sits inside an element that
carries the whole sentence, and a second live region inside it would say the
number twice. The two that DO announce are the two that *are* the sentence.
Durations are left alone, as §5.1 says.

### 7 · Phone chat sheet and drawers
`RoomChatRibbon.tsx`; the drawers landed with item 3 (`AppShell`'s mobile
sidebar and context panel slide from their own edge on `--duration-move`, leave
on `--ease-in`, backdrop fading against them).

The sheet swapped `shrink-0` for `flex-1` — a size change, the one thing §5.3
will not let a keyframe touch. The engine measures the two layouts and plays the
difference back as a transform: up into its open height on the spring, back
down on `--ease-in` at the fade speed. The phone column already clips, so the
travel stays inside the Stage.

### 8 · OnAirPill
`useLights.ts` (`OnAir.speaking`), `OnAirPill.tsx`, `CallDock.tsx`,
`.pc-live-dot.is-speaking`.

`OnAir` did not carry whether anybody had the floor, so §5.1's "speaking is a
breath" was wired to nothing and the dot sat at a fixed glow for the whole call.
It breathes only while somebody is speaking now. The sidebar dock arrives and
leaves on the shared sheet recipe in both its full and its 64px-rail form.

### 9 · Skeletons → content
`Skeleton.tsx` (`.pc-skeleton`, `SkeletonSwap`), `EmojiPicker`, `GifPicker`,
`StickerPicker`, `DiscoveryPage`; `MessageList`, `Lobby` and `GuildStateScreens`
for the pulse.

The pulse was an inline `animation` style, so reduced motion reached it only
through the global 0.01ms override — which does not *stop* a pulse, it runs it
to its end. It is a class now with an explicit `animation: none`, on the breath
timing. Tailwind's `animate-pulse`, a second placeholder recipe on three more
surfaces, is gone the same way.

`SkeletonSwap` keeps a picture of the placeholder while `busy` and, on the
commit where `busy` drops, paints it back over itself as an `aria-hidden` ghost,
fades the ghost out and the content in over `--duration-normal`, and drops the
ghost. The ghost is positioned over the wrapper rather than in flow, so the
content lands at its real size on the first frame — the crossfade costs nobody a
millisecond of waiting and nothing below it moves.

### 10 · Message hover actions
`MessageList.tsx` (`pc-hover-in` on the toolbar, `ReactionRow`).

The toolbar appeared at full opacity the instant the pointer crossed a row — the
one place in the product where something snapped into existence under your hand.
Reactions pop through the list hook rather than a mount class, which is what
keeps the pop honest: a message scrolling into view carrying six reactions is
still, and only a reaction that *arrives* while you are looking pops.

### 11 · Typing indicator
`MessageList.tsx` (`TypingDots`), `.pc-typing-dots`.

The literal ellipsis is three dots on the breath, 200ms apart, `aria-hidden`
because the sentence beside them already says it.

### 12 · Focus rings
`pc-ring-in` in `primitives.css`; `.pc-focusable`, `.pc-focusable-composed`,
`.pc-checkbox`, `.btn-primary`, `.input-field`, `.icon-btn`,
`.context-menu-item`, `.command-icon-btn`.

An animation rather than a transition, so it never joins a control's own
transition list: it plays the moment `:focus-visible` starts matching and leaves
nothing behind. One keyframe covers every ring in the product because a shadow
list interpolates against a shorter one by padding it with transparent layers,
so the `from` is simply whatever shadow the element already carried and no ring.
`.input-field` publishes its well shadow as `--pc-base-shadow` so the inset well
stays put while the ring comes up around it.

Also fixed in passing: `layout.css`'s generic `:focus-visible` fallback used
`var(--accent)`, which was never a token — the rule drew nothing at all.

## 3. Reduced motion

One place, as §5.3 requires, and it is still the `data-motion` attribute in
`utilities.css`. WP9c added exactly three targeted rules beside it, each because
`animation-duration: 0.01ms` *finishes* an animation rather than stopping it:
`.pc-skeleton`, `.pc-typing-dots > span` (which also drops to a legible resting
alpha), and `.pc-live-dot.is-speaking` via the existing breathing rule. No
component added a `prefers-reduced-motion` media query; there are still none in
the stylesheets.

## 4. The gate

`PARACORD_E2E_MOTION=1 npx playwright test` (`npm run test:motion`), extended
with the two moments WP9c is answerable for. Both are driven on
`/design-tokens`, where the gesture is deterministic and a reviewer can replay
exactly what was measured — the Motion section gains a **List reorder** card for
it, and the feedback section gains **Raise a toast** / **Raise three** and a
`.pc-pressable` button beside the engine's `press()` demo.

Both assert the thing actually happened before they trust the frames: a dialog
that never opened and a list that never moved would both pass a frame budget
with nothing in flight.

Measured on this box (Chromium, headless, software rendering, Vite dev server):

| moment | worst animating frame | p95 | longest animation | sequence |
|---|---|---|---|---|
| say something (keyboard) | 16.8ms | 16.7ms | 380ms | 600ms |
| say something (pointer) | 33.4ms × 1 | 16.7ms | 380ms | 600ms |
| bloom | 16.7ms | 16.7ms | 380ms | 380ms |
| dim | 16.8ms | 16.8ms | 400ms | 400ms |
| flicker | 16.7ms | 16.7ms | 200ms | 200ms |
| settle | 16.8ms | 16.7ms | 380ms | 380ms |
| press | 16.8ms | 16.8ms | 240ms | 240ms |
| stagger (6 lights) | 16.8ms | 16.7ms | 380ms | 530ms |
| roll | 16.8ms | 16.8ms | 180ms | 180ms |
| shared element (FLIP) | 16.8ms | 16.8ms | 380ms | 490ms |
| shared element (View Transitions) | 50.0ms | 33.4ms | 380ms | 380ms |
| **dialog enter** | **16.7ms** | **16.7ms** | **220ms `pc-enter`** | **220ms** |
| **dialog exit** | **16.7ms** | **16.7ms** | **160ms** | **160ms** |
| **list reorder (FLIP)** | **16.8ms** | **16.7ms** | **380ms** | **380ms** |

No dropped frames in any of the three new moments. The two exceptions WP9a
records are unchanged and still allowed by name (the send moment's one frame;
the View Transitions path, not gated on frames).

**The dialog's leave is measured, not pictured.** This harness serves two
screencast frames across a 120ms fade, and "it was there, then it was not" is
exactly what an exit that had silently stopped playing would look like. The gate
samples the panel's own computed opacity across the leave instead: 11 frames, 6
of them below full opacity, floor 0.25, and `aria-hidden` on every one of them.

Reduced motion has its own case, now covering both new moments: a reorder plays
nothing, and a dialog opens *and closes* with `document.getAnimations()` empty —
the close being where `usePresence` has to unmount on the spot rather than hold
the panel for an exit nobody asked to see.

## 5. Frames

`output/design-reference/motion/frames-wp9c/` (gitignored). Regenerate with:

```
cd client
PARACORD_E2E_MOTION=1 PARACORD_E2E_MOTION_FRAMES=1 npx playwright test --grep "WP9c moments"
```

`button-hover`, `button-press`, `dialog-open`, `dialog-close`, `toast`,
`reorder`, `roll`, `tabs` — each a strip of screencast frames labeled in ms
after the gesture — plus `_still-emoji-picker.png` and
`_still-hover-actions.png` for the two surfaces that were restructured without
being animated, where the risk is layout rather than timing.

### What looking at them changed

**The roll flashed its answer before rolling it.** `RollingNumber` decided there
was an outgoing value in an ordinary effect, so the browser painted one frame
carrying the new number alone and the ghost of the old one arrived over it on
the next: the strip read "5, 4, 5" instead of "4, 5". Both of its effects are
layout effects now (`adb00db`).

**The leave started a frame late.** Measuring the close after the strip could
not picture it showed the exit class landing one render after `open` dropped.
Deciding it in render took the opacity floor over the leave from 0.44 to 0.25
(`f73f543`).

**The Press card demonstrated the wrong press** — the engine's `press()`, which
one control in the product calls, with nothing on the page carrying
`.pc-pressable`. And there was no way to see the toast *stack* behave, which is
the whole point of FLIP'ing it. Both fixed on `/design-tokens` (`adb00db`).

## 6. The gates, run

```
cd client
npm run typecheck            clean
npm run test:unit            2 313 tests, 248 files, green
npm run test:tokens          488 files, no literal color
npm run build                clean
npx playwright test          84 passed (mocked smoke + encrypted storage)
npm run test:motion          6 passed (1 skipped: the opt-in frame capture)
npx eslint <changed>         0 errors; no warning introduced by this package
```

The real-server suites were not run — they need a release build, and the brief
excludes them.

## 7. Skipped, and why

1. **"Follow the finger on drag" (item 7).** There is no drag to follow. The
   phone sheet's handle is a `<button>` and the sheet has two states, so the
   clause has nothing to attach to. Adding a drag gesture is a feature, not
   micro-motion, and it would need its own decisions about thresholds, velocity
   hand-off and what a half-open sheet means.
2. **The timeline's skeleton is not wrapped in `SkeletonSwap` (item 9).** Its
   branches size themselves against the scroll container the virtualizer
   measures; a wrapper between them changes the scroll geometry, which is a
   bigger change than a crossfade is worth. Its placeholders still take the
   `.pc-skeleton` pulse and its reduced-motion stop.
3. **The Servers column's FLIP is not measured against live data.** The gate
   measures the same hook on `/design-tokens`, because the mocked fixture has no
   way to make the attention ranking re-sort on demand. What is gated is the
   hook; what is not is the particular sort that drives it.
4. **`WindowMap`'s caption does not re-roll (item 6).** "2 channels lit · 3
   reading" is a sentence assembled in `lib/attention`, not a count in a slot.
   Rolling the whole string vertically would be rolling words, which §5.1's line
   is not about.

## 8. Two items §10 files under WP9d

§10's WP9c row does not name **reaction pop** or **typing pulse** — they sit in
the WP9d row. The WP9c brief asks for both, and both are here (items 10 and 11):
a reaction pops through the same list hook the sidebar reorders with, and the
typing ellipsis is three dots on the breath. WP9d keeps the rest of its row,
including the audio-reactive ring that `OnAir.speaking` only gets a boolean of
here.

## 9. Left after this

- **WP9b** still owns lights-on and the arrival path; `useSettleIn` deliberately
  refuses to play at first paint so that package can own the whole street rising
  at once.
- **WP9d** still owns the audio-reactive speaking ring (`OnAir.speaking` is a
  boolean here; §5.1 wants ±15% on level, 60ms attack / 240ms release), theme
  change as the lights changing, contextual plates and the phone
  pull-to-refresh lamp.
- `bloom` and `dim` still have no product call sites — they wait on WP9b's
  presence edges, as WP9a recorded.
- The timeline still drops one frame when a message arrives. It is
  `MessageList` render cost, not motion, and unchanged by this package.
