# WP9b — Lights on · Walk into a channel · Someone arrives

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5, and §10
row **WP9b**. Branch `design/lantern-stage`. Builds on
[`wp9a-checkpoint.md`](./wp9a-checkpoint.md).

Four commits, `cc070f8..2909630`. 43 files, +3 124 / −93.

| | |
|---|---|
| `cc070f8` | the engine's other half — lights on, arrivals, walking in |
| `f82c514` | the three moments, wired to the surfaces that hold them |
| `8470b13` | the gate measures the other three moments |
| `2909630` | what the frame strip showed — walking in, watched |

WP9a shipped the engine and one signature moment, and left three described and
unbuilt: `bloom` and `dim` had no call sites in the product, `transitionWith`
had none either, and §5.1's arrival path had nowhere to hang. This package is
those three, the edges that decide when they happen, and a gate that measures
each of them.

---

## 1. The shape of it

Three layers, and the boundary between them is the point.

| | |
|---|---|
| **When** | `client/src/lib/attention/lightsOn.ts` and `arrivals.ts` — pure state machines. No store, React, DOM or ambient clock. "Did the lights actually just come on?" and "did somebody actually just walk in?" are questions a unit test can hold. |
| **What** | `client/src/lib/motion/` — `lightsOn.ts`, `arrive.ts`, `walk.ts`, `flip.ts`, `marks.ts`, and three new recipes. Web Animations over the §5.2 tokens, like everything else in the engine. |
| **Where** | `marks.ts` — the `data-motion-*` vocabulary a component uses to say *what* it is holding. Never *when* it moves. |

Between the first two sits **`components/motion/MotionDirector.tsx`**: mounted
once in the app shell, rendering nothing, one subscription and two effects.

### Why a director and not per-component motion

"Say something" belongs to the composer and "walk into a channel" belongs to the
door you clicked — both have an owner, and WP9a's rule that the gesture starts
on the frame of the input holds them together. **Lights on** and **someone
arrives** have no owner: they are things the world did, and the surfaces they
touch are in four different subtrees (the sidebar's window map, the Lobby's
cards, a channel header's strip, a timeline's event line).

A server waking up is also *one sequence with one clock*: a plate's lamp has
to know when its own first window lit, and a person's rim has to know when
their channel did. Spread across `WindowMap`, `BuildingPlate` and `LitAvatar` that
is three components sharing a timeline through props and re-deriving it on
every render — and WP9a's first lesson was that a React re-render in the middle
of a moment wipes it. Web Animations are not React's to wipe.

The arrival half deliberately subscribes to the **voice store** rather than
reading a hook. A Zustand listener runs synchronously inside the update, while
the DOM is still the one *without* the newcomer in it — the only moment a FLIP
capture of the faces they are about to displace can be taken, and the only
moment the face of somebody leaving still exists to be copied.

## 2. Moment 1 — lights on

`MotionLightsOn.html`, implemented against the real presence edge.

Plates settle from 14px below, 120ms apart, as the street renders → each lit
window blooms `--stagger-light` after its neighbour, behind its own plate → a
lamp fades in once the first window in its plate is lit → a person's rim
catches 120ms after the channel they are in.

Three triggers, and nothing else (`lightsOnTracker`):

- **`first`** — presence resolved for the first time since the app opened. Not
  "the component mounted": mounting with presence already in hand is the return
  of a route, not the lights coming on.
- **`reconnect`** — the gateway came back after being away.
- **`return`** — the window came back after being hidden longer than five
  minutes. A glance at another app is not a return.

Two subtleties the tests exist to pin:

- A reconnect and a return are **promises that a fresh picture is coming**, not
  the picture. The gateway reconnects a beat before it re-delivers presence, and
  firing on the promise would light the server up over the stale data still on
  screen. The transition is armed and fires on the next observation that has
  presence in hand.
- A server that empties is not a server that was never lit: presence going
  away does not un-happen the first one.

**The gather.** The edge arms the moment; the director waits 250ms before
sweeping. READY sets the local account's own light before it has said a word
about anybody else, and the server's channels, members and voice states
follow over the next couple of hundred milliseconds. Sweeping on the first of
those wakes a server that has not finished arriving — the plates settle over
a street with no windows lit in it, and every window that lights a beat later
looks like somebody walking in. Nothing moves during the gather, so it is not
part of §5.3's 1.6s.

**The compression.** `lightsOnStep()` solves the budget backwards: the last
thing to move is a rim, at (street settle) + (its window's delay) + 120ms +
220ms. A 120-window street is compressed to fit rather than capped, because an
arrival that never plays is worse than one that plays fast.

## 3. Moment 2 — walk into a channel / back to the pill

`MotionWalkIn.html`. `transitionWith` finally has call sites — five of them,
all the same journey: the Lobby card, the sidebar channel row, the inline "lit up"
event in a timeline, the on-air pill (unfolding back into the Stage) and the
single-channel lobby's Join. A channel travels under one name on every surface that
draws it, `room-<channelId>`, so every door in and every door out is the same
move played in a different direction.

**One behaviour change, and it is the point of the package: Join in the Lobby
now takes you into the channel.** It used to join the call and leave you standing
in the street, which is the one thing "walk into a channel" cannot mean.

Three things `transitionWith` had to grow, each because the product has more
than one of everything:

- **`origin`** — a channel's name is on three surfaces at once, and only the click
  knows which one you meant. Without it the first element in the document wins
  and the card you clicked appears to fly out of the sidebar.
- **`destinationRoot`** — the same problem at the other end. A channel lands in
  `main`.
- **`kind`** — stamped on `<html>` as `data-motion-transition` for the length
  of the journey. It is how the two engines dress the same choreography: the
  Web Animations path recedes the live DOM, and `primitives.css` gives
  `::view-transition-old(root)` the identical recede under
  `:root[data-motion-transition='walk-in']`.

**Navigation is never delayed.** `navigate()` runs inside the transition's
update callback with nothing awaited in front of it.

### What the destination costs

Every channel, thread and settings surface is behind a lazy route chunk, so the
destination is not in the document on the frame the route changed. Three things
follow, all found by recording the moment (§6):

- the chrome rise **waits for its subject** (`risingChrome`), bounded at 600ms,
  and gives up rather than firing late into a surface that never had any;
- the journey **waits for the place it is going to** (`waitForDestination`),
  bounded at 700ms — inside a View Transition the browser is still holding the
  old frame while it waits, which is the whole point;
- the Web Animations path holds a copy of the thing you clicked on screen until
  the channel is there to take over from it (`holdOrigin`), because the fallback
  has no snapshot of its own.

## 4. Moment 3 — someone arrives / leaves

`MotionArrives.html`. Their window blooms → their rim catches 120ms later,
wherever a `LitAvatar` is drawn for them → they spring into the here-now strip
or avatar stack → every count that changed re-rolls (`RollingNumber`, already
on them from WP9a) → the inline channel event fades in last.

Leaving is the mirror: the rim dims over 400ms, the face slides out 120ms
behind it, and the window cools **only if the channel actually went dark** — a
channel with three people still in it is still lit, and dimming it would say
something untrue (§0).

**The study animates a slot's width; this does not.** §5.3 puts no layout
property in a keyframe, so the newcomer springs in on transform and opacity and
everything the insertion displaced — the faces after them, the sentence beside
them — is carried by `captureFlip`, also transform only. §5.1 says nothing else
on screen moves, and a row of avatars jumping 18px sideways is very much
something moving.

**A leaving face is a ghost.** The store update that tells us somebody left has
already taken their face out of the tree by the time React has rendered, and an
animation on a disconnected element is not played at all. `ghostOut` is WP9a's
"the words are a ghost, not the textarea" generalised: a copy the engine owns
outright, cut from the live element while it is still there, parked in a
`pointer-events: none` layer and removed when its animation ends.

**A burst is one choreography.** Anybody arriving within 300ms of the first
joins the sequence already running, staggered behind whoever is in it
(`startIndex`), rather than starting a second one over the top. `arrivalStep()`
compresses that stagger the same way the lights-on one is compressed.

**Your own join never plays.** `diffOccupancy` drops `selfUserId`: your arrival
is Moment 2, and it has already animated.

### Text channels are deliberately out of scope

Occupancy is read from voice membership, which is exact — the gateway sends
every `VOICE_STATE_UPDATE`. WP1's "reading" is derived from typing and recent
authorship, and a light that flickers on every keystroke is not somebody
walking in.

### What must not animate

§5.3: "never animate on first paint what the user did not cause or presence did
not cause". A gateway snapshot that **replaces** a guild's membership is the
picture arriving, not people walking in, so the voice store now carries
`voiceSnapshotSeq` — bumped by `loadVoiceStates` — and the director
re-baselines whenever it moves, and whenever the account underneath changes. A
diff of memberships has no other way to tell a snapshot from an event.

## 5. The marks

`client/src/lib/motion/marks.ts`. A mark is an identity, never a style, and it
carries no state a component has to keep in sync — the engine reads the resting
glow off the element itself (`scaleShadow`), so it can never invent a glow
`tokens.css` did not put there.

| Mark | On |
|---|---|
| `data-motion-window="<channelId>"` | a `WindowMap` cell, and a row's 8px window dot |
| `data-motion-lit` | present **only while the light is on** |
| `data-motion-plate` / `-lamp` | a `BuildingPlate` and its one radial |
| `data-motion-person="<userId>"` | a `LitAvatar` root — the thing that moves |
| `data-motion-rim` | the element inside it that carries the glow |
| `data-motion-room="<channelId>"` | a face whose channel the surface knows |
| `data-motion-strip` | an `AvatarStack` — where a face springs into |
| `data-motion-event="<channelId>"` | the inline "lit up" row in a timeline |
| `data-motion-recede` | a region that steps back while you walk through it |
| `data-motion-shared` / `-chrome` | WP9a's, now with call sites |

## 6. What the frame strips showed

`output/design-reference/motion/frames-wp9b/` (gitignored). Every one of the
four below was invisible in code review and none of them could have failed a
budget — dropping an element is free.

1. **The card flew into the sidebar.** The "after" pass took the first element
   in the document carrying the channel's name, and the sidebar comes first. →
   `destinationRoot`.
2. **And then it travelled nowhere.** The surface you leave is still in the
   document for a tick after the route changes, so the destination pass found
   the card sitting where it was and measured a delta of zero. A journey's
   destination is never its origin. → `collect(..., exclude)`.
3. **The Lobby never receded.** The route change unmounts it on the same tick,
   so §5.1's "the rest of the Lobby recedes" was an animation on elements that
   were already gone; the screen simply went empty for a beat. It recedes as a
   ghost now, with the branch that is travelling hidden inside the copy.
4. **The travelling tile was missing for ~200ms.** Same cause, other half. →
   `holdOrigin`.

Two more came out of measuring rather than watching: `springEasing` samples the
spring into a `linear()` string every time it is asked, and a burst of arrivals
asks a dozen times on one frame, so it is memoised on the tokens it reads; and
ghosts declare `will-change` / `contain`, so receding a copy of a whole surface
is the compositor's bill rather than the main thread's.

### The strips

- `lights-on-0000ms.png` … `-0900ms.png` — the server waking after a gateway
  reconnect. `_sidebar-lights.png` crops the same frames to the sidebar's
  server plate, which is where it is legible: 0ms the plate is still on its
  way in, 60ms it has landed and the first window is on, 120ms the window is
  blooming past its resting glow and a second has joined it, 240ms both are at
  rest and the caption has caught up.
- `walk-in-0000ms.png` … `-0600ms.png` — the Lobby card becoming the channel. 0ms
  the Lobby is whole, 60–120ms it steps back 4% and fades with the card you
  clicked still crisp on top of it, 180ms the channel arrives underneath, 240ms
  onward its chrome rises.
- `arrives-0000ms.png` … `-0640ms.png` — Tomas walking into Shop floor while
  you stand in the Lobby: the window blooms, the counts re-roll from 3 to 4,
  and he springs into the Around-now stack.
- `leaves-0000ms.png` … `-0520ms.png` — the mirror.
- `_strip-*.png` — the same frames stacked into one sheet each. Montages for
  reading a moment in one go, not captures.

Each strip's clock is zeroed on the frame the **engine** started moving, not on
the action: two of these moments begin with a round trip to the gateway, and a
strip labelled from the click would be mostly waiting.

The walk-in strip is captured on the Web Animations path. The View Transitions
path composites its snapshots off the main thread, and this harness is a
software-rendered headless Chromium: the screencast of it is a black rectangle
where the transition should be. That is the same compositor bill WP9a recorded
(§4 there); the gate asserts the choreography on both paths separately.

## 7. The gate

Six new cases on WP9a's sampler, all mocked. They are driven through **real
gateway traffic**, not by poking a store: the whole point of the director is
that the edge is detected from what the server says, so a gate that skipped the
server would be measuring a fiction.

`e2e/realtime-stub.mjs` grew a back door for it:

- `POST /__standing` sets the world every stream opens into. It is merged into
  READY, which is exactly where the real server puts it — the servers you are
  in, their channels, who is in those channels and whose lights are on.
- `POST /__emit` writes a frame (or a batch, in order) to every open stream.
- `POST /__drop` cuts every stream, so the client reconnects. That is §5.1's
  second lights-on trigger and the only one a test can drive deterministically:
  the app is already on screen and already lit when the sequence runs.

Measured on this box (Chromium, headless, software rendering, Vite dev server):

| moment | worst animating frame | p95 | longest animation | sequence |
|---|---|---|---|---|
| lights on (reconnect) | 16.7ms | 16.7ms | 380ms `settle` | 460ms |
| walk in (Web Animations) | 16.8ms | 16.7ms | 380ms `recede` | 490ms |
| walk in (View Transitions) | 50.0ms | 33.4ms | 380ms (UA group anim) | 490ms |
| someone arrives | 16.8ms | 16.7ms | 380ms `flip` | 500ms |
| four arrive in one beat | 16.8ms | 16.8ms | 380ms `flip` | 590ms |
| someone leaves | 16.8ms | 16.7ms | 400ms `dim` | 400ms |

And the assertions that are not about frames:

- **lights on does not fire again** for a route change or a re-render: the test
  navigates away and back and watches for `settle`/`bloom` across the whole
  window the gather could fire in.
- **both engines run the same choreography.** `document.startViewTransition` is
  shadowed with an own property to reach the fallback (deleting it removes
  nothing — it lives on `Document.prototype`), and wrapped to count calls to
  prove the browser path really was the browser path. Both assert the route
  changed and the chrome rose.
- **a burst is one sequence**, staggered, inside the budget.
- **reduced motion** now covers all three moments plus the send:
  `document.getAnimations()` is empty after each.

Building the gate found four real bugs, all fixed in `8470b13`:

1. **`transition.ready` rejects in ordinary use** and nothing caught it. The
   browser skips a transition whenever a second starts on top of it or the
   document is torn down, and the rejection escaped as an unhandled promise —
   which the app turned into an error toast on top of the channel you had just
   walked into. A skipped transition means the update happened and the travel
   did not, which is the right degradation, so the chrome rises without it.
2. **The chrome rose over an empty document** (see §3).
3. **The first real arrival was swallowed.** The app shell is itself a lazy
   route, so READY usually lands before the director subscribes, and treating
   "the first update I saw" as the baseline ate the arrival after it. It
   baselines on the state at the moment it starts watching now.
4. **A leaving person's rim never dimmed** (see §4).

## 8. The gate, run

```
cd client
npm run typecheck            clean
npm run test:unit            2 336 tests, 249 files, green
npm run test:tokens          494 files, no literal colour
npm run build                clean
npx playwright test          84 passed (mocked smoke + encrypted storage)
npm run test:motion          11 passed
npx eslint src e2e           0 errors (pre-existing warnings only)
```

The real-server suites were not run — they need a release build.

## 9. Deviations from §5, and why

Three, all recorded here because §5 is the contract.

1. **§5.3 "a frame over 32 ms fails the motion gate."** The walk-in's Web
   Animations path is allowed **exactly one** dropped frame, by name: the frame
   on which the channel's own surface mounts. Measured again with the engine's
   ghosts removed entirely, the same frame is still 33ms in the same place, so
   it belongs to the route's render and not to the engine — and it does not
   appear on every run (the table above is a run where it did not). A second
   fails. The View Transitions path is still not gated on frames at all, for
   the reason WP9a recorded.
2. **§5.1 "they spring into the here-now strip."** The study animates the
   slot's `width`; this animates transform and opacity and FLIPs whatever the
   insertion displaced. §5.3's budget forbids a layout property in a keyframe,
   and §5.1's own "lists that change order animate layout (FLIP) on the same
   curve" is the sanctioned way to carry the rest.
3. **Moment 3 covers voice channels only.** Voice membership is exact; WP1's
   "reading" is derived from typing and recent authorship, and a light that
   flickers on every keystroke is not somebody walking in.

## 10. Known, not fixed here

- **The lights-on sweep is thin on a surface with no window map.** The Lobby
  has channel cards rather than windows, so on that route the moment is the
  sidebar's server plate settling, its windows blooming and the Around-now
  rims catching. That is correct — §3 puts the window map in the sidebar and on
  Home — but Home is where the moment is most worth looking at, and no frame
  strip of it was taken.
- **A second server connecting mid-session** re-baselines the arrival director,
  so nobody in its channels "arrives". A person who then walks in does. This is the
  right trade, but it means a background server's first arrivals are silent.
- **`framer-motion`** still drives `Modal`, `Tooltip`, toasts,
  `SlashCommandPopup` and the on-air dock's own enter/exit. WP9c should retire
  it; nothing new is built on it.
- **The walk-out into the on-air pill has no frame strip.** It is gated (the
  shared name is on the pill and the Stage's dominant region) but it was not
  recorded, because the mocked harness cannot complete a voice join.

## 11. Left for WP9c / WP9d

Unchanged from WP9a §9, minus WP9b:

**WP9c — systematic micro-motion.** `press` is still on the send control only;
hover's 1px lift; the dialog/toast/menu enter-exits; tab and toggle indicators
on the spring-settle curve; phone sheet physics; `RollingNumber` on every
remaining count.

**WP9d — further moments.** The audio-reactive speaking ring (`animate.ts` has
no level input yet), theme change as the lights changing, reaction pop, typing
pulse, contextual plates, the phone pull-to-refresh lamp.
