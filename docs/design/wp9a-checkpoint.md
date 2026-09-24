# WP9a — The motion engine, and "Say something"

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5, and §10
row **WP9a**. Branch `design/lantern-stage`.

Five commits, `c1090b5..e82ac37`. 35 files, +3 632 / −509.

| | |
|---|---|
| `4257537` | the §5.2 motion tokens |
| `6181fe2` | `lib/motion` — the engine, and one reduced-motion switch |
| `4a82dac` | say something — the words lift, the row lands, the window flickers |
| `45c7a6a` | the `/design-tokens` Motion section and the frame-timing gate |
| `e82ac37` | what the frame strip showed — the send moment, watched |

§5 was a law with no runtime behind it. Every animation in the product was a
local CSS keyframe or a `framer-motion` prop, reduced motion was decided in four
different places, and the two curves §5.2 names were one curve short. This
package is the layer the law describes: Web Animations over the tokens, one
switch, and a gate that measures frames rather than trusting them.

---

## 1. The tokens (§5.2)

`client/src/styles/tokens.css` gains the rest of §5.2, inside `@theme` with the
durations that were already there:

```
--ease-spring-settle: cubic-bezier(0.34, 1.2, 0.64, 1)   the ONE curve for movement
--duration-move: 380ms       shared elements, settling plates, sliding indicators
--duration-roll: 180ms       a count flipping over
--stagger-light: 30ms        neighboring lights
--stagger-chrome: 80ms       chrome rising behind the thing it supports
--spring-stiffness: 260 · --spring-damping: 24 · --spring-mass: 1
```

No third traveling curve: `--ease-in` is the dim, `--ease-in-out` the breath,
and neither moves anything. `motion.test.tsx` asserts exactly four `--ease-*`
names exist, so a fifth cannot arrive quietly.

The `--spring-*` values are unitless on purpose — physics constants read by
script, not lengths CSS can use.

## 2. The engine — `client/src/lib/motion/`

No framework. Web Animations plus the tokens; `framer-motion` stays where WP0–8
left it and nothing new is built on it.

| Module | What it is |
|---|---|
| `tokens.ts` | reads the §5 custom properties off the document. `MOTION_TOKEN_FALLBACKS` holds the stylesheet's values for a renderer with no stylesheet (jsdom), and a test reads `tokens.css` and fails if the two ever disagree. `rawToken()` resolves any custom property for the two places WAAPI needs a value rather than a `var()`. |
| `reducedMotion.ts` | **the** switch. OS media query + `uiStore.motion` (`system` / `full` / `reduced`), folded into one answer and published as `data-motion` on `<html>`. `prefersReducedMotion()` for modules, `useReducedMotion()` for components, `:root[data-motion='reduced']` for CSS. |
| `spring.ts` | the damped spring behind `--ease-spring-settle`, solved analytically (under-, critically and over-damped). `springLinearEasing()` samples it into a WAAPI `linear()` string, normalized so it ends at exactly 1; `springEasing()` falls back to the cubic-bezier token where `linear()` is unsupported. `sampleRunning()` reads a running animation's position and velocity so a replacement can retarget from it. |
| `animate.ts` | `bloom` · `dim` · `flicker` · `settleIn` · `stagger` · `press` · `flash` · `liftOut` · `relax` · `fadeIn`. Each cancels the recipe it replaces on that element, returns the `Animation`, and lands its end state instantly under reduced motion. |
| `sharedElement.ts` | `transitionWith(update, { names })` — View Transitions where the webview has them, a Web Animations FLIP everywhere else, the same choreography on both: 380ms spring-settle, `[data-motion-chrome]` rising 80ms later 30ms apart. |
| `flipCounter.tsx` | `<RollingNumber value={n} />` — old up and out, new up and in, 180ms, on a change only. |
| `bus.ts` | `onMotion` / `emitMotion` for the gestures that cross a pane boundary. Gestures, never state. |
| `waapiStub.ts` | test-only: jsdom has no `Element.animate` at all, so the unit suite records what would have been played. |

**The budget is enforced by the shape of the API, not by discipline.** The
recipes only ever write `transform` and `opacity`, except on a light element,
where `box-shadow` and `background` are read *off the element* and scaled — so
the engine can never invent a glow `tokens.css` did not put there
(`scaleShadow`). A unit test walks every keyframe every recipe produces and
fails on any layout property.

31 unit tests in `client/src/lib/motion/motion.test.tsx`: the spring's overshoot
(peaks at 1.03 between 200 and 400ms, never dips back under 1) and settling time,
the `linear()` sampling, the switch in all three modes and under an OS change,
every recipe's property budget and duration, the stagger step, recipe
cancellation, the shadow scaler, the FLIP delta, the chrome stagger, the View
Transitions path, the roll and its accessibility, and the bus.

### The one switch

Nine call sites moved onto it: `App`, `ConnectionStatusBar`, `RestartBanner`,
`UpdateNotification`, `Tooltip`, `Button`, `SlashCommandPopup`, `MessageInput`
and `Modal` (which had grown its own `matchMedia` probe because consuming tests
mock `framer-motion` down to `{ motion, AnimatePresence }` — `lib/motion` is not
`framer-motion`, so the mock no longer forces a second source of truth).

The two `@media (prefers-reduced-motion: reduce)` blocks in `utilities.css` and
`primitives.css` now read `:root[data-motion='reduced']`. **Do not add a
`prefers-reduced-motion` media query anywhere**: it would be a second source of
truth and the user's explicit "Full motion" could not win against it.

Settings › Appearance gains a Motion control beside the theme picker: *Match my
system* / *Full motion* / *Reduced motion*, with a line underneath saying which
way the switch is actually pointing right now.

## 3. "Say something" (§5.1 "a message has mass")

`MotionSay.html`, implemented against the real send path.

On Enter or a click, **on the same frame as the keystroke and before any await**
(§5.3: motion never delays input):

- the typed words lift out of the composer — 220ms, `--ease-out`, up and away
  along the path they land in the timeline;
- the composer relaxes to 0.992 from its bottom edge and springs back;
- the send control catches `--light-white` for one beat and returns;
- the channel's amber window flickers once.

`MessageList` takes the same gesture off the bus and lands the row that arrives
from it, 26px from below on the spring-settle curve, so the words leaving and
the row arriving read as one object moving.

Three things make it honest:

- **The words are a ghost, not the textarea.** The draft is the source of truth
  until the server answers; the real text is hidden behind the ghost (opacity
  only, the value is never touched) and a failed send restores it by doing
  nothing. Both are DOM the engine owns, not React state — the send frame is the
  one frame that must not be spent re-rendering a 1,600-line composer.
- **Only a row the person caused lands.** Without a gesture on the bus nothing
  animates, which keeps history, channel switches and other people's messages
  still. The transform is on the row itself, under the virtualizer's own
  positioning, so no neighbor moves and the list never reflow-animates.
- **Nothing at all happens for a send that will not go.** A poll, a schedule, an
  attachment, a slash command, an empty or over-long draft, or a conversation
  that will refuse it, all take the ordinary path.

Failure path: the row never lands, the composer text is restored, and the
existing error banner is unchanged. A send that neither resolves nor rejects
gives the words back on its own after 4s.

### The receipt

"Delivered" sits under your last message in the channel. It **cannot** appear
before the server has answered, structurally rather than by a check: this
runtime publishes a message only once the authoritative recovery feed has
vouched for it — there is no optimistic row in this app at all — so the row and
its receipt arrive together, and the receipt fades in 380ms behind the row. It
sits under the timeline rather than inside a row so no message's height ever
depends on it.

### Numbers re-roll

`<RollingNumber>` carries the here-now counts in the channel header (`TopBar`, "5
reading · 19 lights on") and in `HereNowStrip`'s default caption ("4 here · 20
lights on"). One live region per strip announces the count that changed; the
other is readable but silent, so a change never announces twice.

### What the frame strip showed

Recording the moment and looking at it turned up four defects the study never
has. All four are fixed in `e82ac37`, and all four were invisible in code
review:

1. **The send control never caught the light.** `flash` added a class and the
   send's own re-render rewrote `className` microseconds later. Inline style
   now, which React does not own — plus `transition: none` for the beat, because
   the control's color transition had been turning the flash into a 140ms ramp
   that peaked at 93%.
2. **A 180px card appeared and vanished under the composer.** Every send passes
   through the durable outbox, and `MessagingQueuePanel` drew a "Queued message"
   card for the ~200ms it took — a layout animation, in the middle of the moment
   that must read as one object. A send that is merely in flight now waits 1.5s
   before it is worth a card. Failures, prepared discards, saved edits and
   deletions, and recovery drafts are unchanged and immediate.
3. **A blocker banner flashed for 80ms.** Delivery readiness dips out of `ready`
   while the runtime recovers the channel you just posted to, so the composer
   said "wait for this account's authenticated message recovery" and took it
   back before anyone could read it. A blocker now has to still be there 400ms
   later.
4. **A spinner flashed inside the send.** The control swapped to a spinning
   loader for the ~100ms of the vault commit. Uploads, polls and scheduling keep
   it; a plain send's feedback is its beat of light.

And the flicker was too polite to see: it now takes the window's glow to the
study's ratios (8px/.5 → 18px/.95 → 14px/.8) and pushes the fill toward
`--light-white` at the first peak.

## 4. The gate — `client/e2e/motion-gate.spec.ts`

`PARACORD_E2E_MOTION=1 npx playwright test`, or `npm run test:motion`. Mocked
exactly like the smoke (`e2e/fixtures/motionFixture.ts`), on the same dev server
and port. A `requestAnimationFrame` sampler runs across each moment and records
every frame interval **together with what the engine had in flight when that
frame was served**, so a failure names the frame, its offset from the action and
the recipe.

Four budgets, all §5.3:

- the 95th-percentile frame while the engine is animating ≤ **32ms**;
- at most the declared number of dropped frames while animating — **0**
  everywhere except the send — and none over **50ms** anywhere in the moment;
- no single animation's active duration over **500ms**;
- no staggered sequence past **1.6s**.

Measured on this box (Chromium, headless, software rendering, Vite dev server —
i.e. the worst case the product will meet):

| moment | worst animating frame | p95 | longest animation | sequence |
|---|---|---|---|---|
| say something (keyboard) | 33.3ms × 1 | 16.8ms | 380ms `relax` | 600ms |
| say something (pointer) | 33.3ms × 1 | 16.7ms | 380ms `relax` | 600ms |
| bloom | 16.8ms | 16.8ms | 220ms | 220ms |
| dim | 16.8ms | 16.7ms | 400ms | 400ms |
| flicker | 16.7ms | 16.7ms | 200ms | 200ms |
| settle | 16.8ms | 16.8ms | 380ms | 380ms |
| press | 16.7ms | 16.7ms | 240ms | 240ms |
| stagger (6 lights) | 16.8ms | 16.7ms | 380ms | 530ms |
| roll | 16.8ms | 16.8ms | 180ms | 180ms |
| shared element (FLIP) | 16.8ms | 16.7ms | 380ms | 490ms |
| shared element (View Transitions) | 33.4ms | 33.3ms | 380ms | 380ms |

Two numbers in that table need saying plainly rather than hiding behind a
threshold.

**The send moment drops exactly one frame**, at the moment the row arrives. It
is `MessageList`'s own render of the new row — it is there, to the frame, with
motion switched off entirely (the reduced-motion case plays nothing and drops
the same frame), and it survived every optimization this package could make
without restructuring the timeline. The gate allows it *by name*, at one: a
second dropped frame fails.

**The View Transitions path is not gated on frames.** The browser snapshots the
whole viewport to run it, and this harness has no GPU: the same click costs ~63
frames where the FLIP path costs ~147 over the same window, with nothing of ours
on the main thread in between. That is the compositor's bill on a software
renderer, and gating on it would be measuring the CI box. The path is still
gated on everything else — that it runs, that it is the same choreography, and
that it stays inside the duration budget — and `/design-tokens` offers both
engines as separate buttons so a reviewer can hold them against each other.

Reduced motion has its own case: `<html data-motion="reduced">` is what CSS is
reading, a send lands its row with `document.getAnimations()` empty afterwards,
and a Replay on `/design-tokens` plays nothing.

Building the gate found three real bugs, all fixed in `45c7a6a`:

- `sharedElement` awaited a `requestAnimationFrame` **inside** the View
  Transition update callback. The browser suspends rendering for that callback,
  so the frame never came, the transition never finished, and the page's
  rendering stayed suspended — a hang, not a stutter. It waits a macrotask now.
- the send moment built its lifting words through React state (see §3).
- the View Transitions path ran on the UA's 250ms `ease`, which is neither of
  §5.2's two curves. `::view-transition-*` now takes `--duration-move` and
  `--ease-spring-settle`, and the root snapshot crosses at the plain fade speed
  so nothing but the element that traveled draws the eye.

## 5. `/design-tokens` › Motion

Every recipe as its own card: the tokens it spends, the physical model §5.1
gives it, something to play it on, and a **Replay** button — a recipe that
cannot be replayed cannot be judged. The shared element gets both engines as
separate buttons and reports which one ran. The page prints the switch's current
answer and the actual easing the spring resolved to, sampled, so what the engine
is doing is on the page rather than in a comment.

The Motion token table in "Spacing, radii, sizes, motion" now lists the full
§5.2 set.

## 6. Frames

`output/design-reference/motion/frames-wp9a/` (gitignored, like every other
package's captures). Regenerate with:

```
cd client
PARACORD_E2E_MOTION=1 PARACORD_E2E_MOTION_FRAMES=1 npx playwright test --grep "frame strip"
```

- `say-0000ms.png` … `say-0900ms.png` — the send moment at 1280×800, one frame
  per label, the clock zeroed **on the keystroke**. 0ms the control is white and
  the words are still in the composer; 40–120ms the words lift and thin while
  the row fades up through the same space; 160–280ms the row is on its mark;
  500ms "Delivered" answers.
- `flicker-0000ms.png` … `flicker-0220ms.png` — the flicker recipe on
  `/design-tokens`. The channel's own window is captured dark in the fixture
  because nobody is reading it, so the flicker is shown where it can be seen;
  it is the same `flicker()` the channel header calls.
- `_strip-a.png` / `_strip-b.png` / `_flicker-strip.png` — the same frames
  cropped to the composer band and to the window, stacked into one sheet each.
  Montages for reading the moment in one go, not captures.
- `_settings-motion.png` — Settings › Appearance with the new Motion control.

## 7. The gate, run

```
cd client
npm run typecheck            247/247 files, clean
npm run test:unit            2 298 tests, 247 files, green
npm run test:tokens          486 files, no literal color
npm run build                clean
npx playwright test          84 passed (mocked smoke + encrypted storage)
npm run test:motion          4 passed
npx eslint <changed>         0 errors (pre-existing warnings only)
```

The real-server suites were not run — they need a release build.

## 8. Deviations from §5, and why

Two, both recorded here because §5 is the contract.

1. **§5.3 says "a frame over 32 ms fails the motion gate".** The gate applies
   that to the frames the engine owns, allows the send moment exactly one
   dropped frame belonging to the timeline's own render, and does not gate the
   View Transitions path on frames at all. §4 has the measurements behind each.
   Nothing is hidden: every number is printed on every run.
2. **§5.1 says a receipt "fades in only after the server answers".** There is no
   receipt UI in the product to fade — WP9a introduces the first one. It is
   deliberately minimal ("Delivered", under your last message) because the
   read-receipt half needs read-state fan-out that does not exist yet.

## 9. Left for WP9b / WP9c / WP9d

WP9a ships the engine and one signature moment. Everything below is wired
against `lib/motion` and needs no new primitives.

**WP9b — the other three signature moments.**
- *Lights on* (`MotionLightsOn.html`): plates settle, windows bloom on a 30ms
  stagger, the lamp fades in after the first lit window, rims catch, captions
  last. `settleIn` + `stagger` + `bloom` exist; what is missing is the presence
  edge to hang them on.
- *Walk into a channel / back to the pill* (`MotionWalkIn.html`): `transitionWith`
  is built and demonstrated but has **no call site in the product yet**. The
  Lobby card and the Stage need matching `data-motion-shared` names, and the
  Stage's header, tile strip and control bar need `data-motion-chrome`.
- *Someone arrives / leaves* (`MotionArrives.html`): window blooms → rim catches
  120ms later → they spring into the here-now strip → counts re-roll → the
  inline channel event fades in last. `RollingNumber` is already on the counts;
  the arrival path needs the presence-delta selectors.

**WP9c — systematic micro-motion.** `press` is on the send control only; it
belongs on every `Button`, `IconButton` and tile. Hover's 1px lift, the
dialog/toast/menu enter-exits (still `framer-motion` and still hand-rolled CSS
keyframes in `components.css`), tab and toggle indicators on the spring-settle
curve, list FLIP, phone sheet physics, and `RollingNumber` on every remaining
count (unread badges, "N in", Lobby captions).

**WP9d — further moments.** The audio-reactive speaking ring (`animate.ts` has
no level input yet — §5.1 wants ±15% at 60ms attack / 240ms release), theme
change as the lights changing, reaction pop, typing pulse, contextual plates,
the phone pull-to-refresh lamp.

**Known, not fixed here.**
- The timeline drops one frame when a message arrives (§4). It is `MessageList`
  render cost, not motion, and shrinking it means changing how the virtualizer
  measures — a package of its own.
- `framer-motion` still drives `Modal`, `Tooltip`, toasts, `SlashCommandPopup`
  and the composer's upload sweep. WP9c should retire it; nothing new uses it.
- `bloom` and `dim` have no call sites in the product yet — the light components
  still cross-fade through `.pc-transition`. WP9b's presence edges are where
  they get used.
