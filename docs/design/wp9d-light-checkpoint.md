# WP9d-light — Further moments (surface half)

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §5, and §10
row **WP9d**. Branch `design/wp9c`, on top of WP9a–c
([`wp9c-checkpoint.md`](wp9c-checkpoint.md)). This package is the surface half
of the WP9d row only: items 3, 4, 5 and 6 of the brief. The audio-reactive
speaking ring, the theme-change crossfade and the connection-state moment
(items 1, 2, 7) belong to another package.

Eight commits, `a99e519..HEAD`, the last of them this file.

| | |
|---|---|
| `a99e519` | every `flipList` animation carries the `data-motion-recipe` id the gate reads |
| `5022354` | **3** a reaction pops like something somebody put there |
| `d8b9c5e` | **4** the room's window breathes while somebody writes |
| `bc0e822` | **5** contextual plates slide in from their edge |
| `0bc4fc0` | **6** the phone's pull reveals the room's lamp |
| `8785752` | the gate watches the WP9d moments play |
| `3156974` | the popup's exit keeps its subject without a render-phase ref |
| this file | the checkpoint |

WP9a–c built the engine and hung motion on every surface that was still silent.
WP9d's row is the moments where the *light* answers: a reaction is a little
thing somebody placed, typing is the room's window breathing, a contextual
plate is a door opening against its own edge, and on the phone the room's lamp
is something you can reach for.

## 0. The gate can name what it watches — `flipList.ts`

Every `animate()` call in `flipList.ts` — moved rows, arrived rows, the
departing ghost, `flipBetween`, the indicator — now sets
`animation.id = 'data-motion-recipe:<name>'`, the convention `flip.ts` and
`animate.ts#run()` already used. Before this the gate logged WP9c's own
reorders and arrivals as `anonymous`, which made the new moments
indistinguishable from noise. No behaviour changed; only the names did.

## 3. A reaction pops — `MessageList.tsx`, `flipList.ts`

`ReactionRow` rides `useFlipList({ enter: 'pop' })`, which keeps the honest
rule WP9c chose: a chip that arrives while you are looking pops; a message
scrolling into view already carrying reactions does not.

The chip is marked `data-flip-own` when the current user placed it and carries
`data-flip-glyph` on the emoji. The hook reads the marks: your own reaction
springs in from scale 0.6, somebody else's from 0.8 — the small difference
that says who moved. The glyph gets its own animation on the same clock,
over-rotating 8° and settling back, so the mark reads placed rather than
stamped. Removing a reaction fades and shrinks the chip out over
`--duration-fast` as a `data-motion-recipe:exit` ghost. The first chip into an
empty row is the row's first commit and mounts silently by design; the count
still re-rolls through `RollingNumber`.

## 4. The room's window breathes while somebody writes — `TopBar.tsx`, `primitives.css`, `tokens.css`

`typingByChannel` already knew who was writing; the header just never looked.
While someone *else* types in the current text room, the amber window gets
`is-writing` and breathes at half amplitude — a new token,
`--glow-window-amber-breathe`, defined for all three themes beside the full
`--glow-window-amber`. It runs on `--duration-breathe` (1600ms), the window
stays lit for the whole typing stretch, refreshes don't restart the cycle
because the class never leaves, and the typing store's own expiry ends it.
A voice room's window stays white and never takes the class. Under reduced
motion the rule that lights the window still applies and the animation is the
one thing removed: lit, still, correct.

## 5. Contextual plates slide in from their edge — `AppShell.tsx`, `ContextPanel.tsx`, `UserProfile.tsx`, `MessageList.tsx`, `FriendsPage.tsx`

WP9c gave overlays one enter and one exit. Contextual plates are different: a
door doesn't rise from the floor, it swings on the edge it is hinged to. Four
new shared classes — `pc-drawer-in-left`, `pc-drawer-in-right`,
`pc-drawer-out-left`, `pc-drawer-out-right` — slide the surface a short
distance from its own edge on the spring in, back out on `--ease-in` over
`--duration-fast`, with the backdrop fading against them.

`AppShell`'s desktop context rail rides `usePresence` now instead of a bare
conditional mount, so it gets the same 120ms leave the phone drawer always
had — and the same scenery contract: `aria-hidden` and inert while it leaves.
`ContextPanel` remembers which pane was showing through the exit
(`shown`), so a closing members list doesn't swap to the default pane for its
last frames.

`UserProfilePopup` split into a presence wrapper and the card. Callers render
it unconditionally and pass `null` to close — the contract `Modal` and the
shell overlays already had — and the wrapper holds the last subject through
the leave so the card never exits empty. It remembers its subject in render-
phase state, the same hatch `usePresence` uses, because an effect would arrive
after the frame that needed it. Which edge it slides from comes from where it
was placed: right half of the viewport slides in from the right.

The phone context overlay, search plate, pinned-messages plate and the rest of
the `usePresence` family keep their existing enter/exit — this item changed
the *direction* contract, not the plumbing.

## 6. The phone's pull reveals the room's lamp — `MessageList.tsx`

Only on `(hover: none), (pointer: coarse)`. A `touchstart` at scroll top arms
a passive gesture: the pull moves a small lamp (`data-motion-lamp`,
`aria-hidden`) down out of the timeline's top edge by direct style writes —
no React state per touch-move — and the lamp's brightness follows the
distance. 8px of dead zone absorbs jitter; 72px of pull fires
`fetchMessages(channelId)`, the lamp `flicker()`s once (the engine's own
recipe, so the gate can name it), then dims back out on a Web Animations exit.
Letting go early just dims it; nothing refetches. Passive listeners, no
preventDefault, no spinner — the scroller's native behaviour is untouched and
the gesture is abandoned the moment the scroller starts moving on its own.
Reduced motion skips the animated dim and resets immediately.

## Reduced motion

Still one authority — the `data-motion` attribute and its blanket rule. WP9d
added exactly one targeted rule: `.pc-window.is-writing` under
`(prefers-reduced-motion)` keeps the lit window and sets `animation: none`,
because the 0.01ms blanket *finishes* a breathe rather than stopping it.

One honest caveat the gate now encodes: the blanket leaves Chromium with
`scrollbar-color` transitions whose computed duration is 0.01ms that headless
never retires, so `document.getAnimations()` is never literally empty. The
reduced-motion assertion filters anything with an active duration under 1ms —
which is what "nothing moves" means — and still fails any real-duration
animation it finds.

## The gate

`npm run test:motion` — 18 passed, 5 skipped (the four opt-in capture tests
plus the send-moment still capture). The WP9d additions:

| moment | worst animating frame | p95 | longest animation | sequence |
|---|---|---|---|---|
| reaction pop (own — chip + glyph) | 16.7ms | 16.7ms | 220ms `pop` | 220ms |
| reaction pop (theirs) | 16.7ms | 16.7ms | 220ms `pop` | 220ms |
| reaction leave | 16.7ms | 16.7ms | 120ms `exit` | 120ms |
| typing pulse | 16.8ms | 16.8ms | 220ms warm-up | — |
| contextual plate enter | 16.8ms | 16.7ms | 380ms `pc-drawer-in-right` | 380ms |
| contextual plate exit | 16.8ms | 16.8ms | 120ms `pc-drawer-out-right` | 120ms |
| pull lamp → refresh | 16.8ms | 16.8ms | 200ms `flicker` | 200ms |
| pull lamp, released early | 16.8ms | 16.8ms | 120ms `exit` | 120ms |
| `motion-pop` demo card | 16.7ms | 16.7ms | 220ms `pop` | 220ms |
| `motion-plate` demo card | 16.7ms | 16.7ms | 380ms `pc-drawer-in-right` | 380ms |

No frame over the 32ms engine budget in any new moment; every animation
inside the 500ms / 1600ms ceilings.

Beyond the numbers the tests assert the choreography itself, because a moment
that silently didn't play passes a frame budget:

- **Keyframes, not just ids.** A helper polls `getAnimations()` for a
  `data-motion-recipe` id and reads `KeyframeEffect.getKeyframes()` — the own
  pop is checked to start at scale 0.6, theirs at 0.8, the glyph at ±8°.
- **The typing pulse is proven running, then proven stopped** — an
  infinite-iteration animation on the window while typing, gone after the
  typing state lapses, and never present on a voice room.
- **The plate's leave is sampled, not pictured** — same trick as WP9c's
  dialog: computed opacity across the exit (floor 0.04) and `aria-hidden` on
  every frame it was still leaving.
- **The pull lamp is driven by real CDP touch events** on an emulated phone —
  far enough refetches and flickers; a short pull only dims.
- **Reduced motion** drives all four moments and asserts nothing with a real
  duration is running.

## Frames

`output/design-reference/motion/frames-wp9d/` (gitignored) — 74 frames across
nine strips. Regenerate with:

```
cd client
PARACORD_E2E_MOTION=1 PARACORD_E2E_MOTION_FRAMES=1 npx playwright test --grep "WP9d"
```

`reaction-pop`, `reaction-leave`, `typing-pulse`, `plate-in`, `plate-out`,
`pull-lamp` from the live app; `motion-pop`, `motion-writing`, `motion-plate`
from the demo cards. The mid-motion stills were inspected: the amber window
lit mid-breath under a typing row; the lamp revealed at the top of a pulled
phone timeline.

## The gates, run

```
cd client
npm run typecheck            clean
npm run test:unit            2 356 tests, 250 files, green
npm run test:tokens          496 files, no literal colour (5 allowed exceptions)
npm run build                clean (existing chunk-size + circular warnings)
npx playwright test          84 passed (mocked)
npm run test:motion          18 passed, 5 skipped (opt-in captures)
npx eslint <changed>         0 errors; no warning introduced by this package
```

The real-server suites were not run — the brief excludes them.

## Skipped, and why

1. **Items 1, 2 and 7 are not here by instruction** — the audio-reactive ring,
   theme-change crossfade and connection-state moment belong to another
   agent's package. §10's memory-allocation assertion for the level loop has
   nothing to attach to until item 1 lands.
2. **The first reaction into an empty row doesn't pop.** `useFlipList` skips
   its first commit on purpose — there is no row yet, so there is nothing to
   interrupt and nothing to contrast against. Every subsequent arrival pops.
3. **The pull gesture is armed only at scroll top and never captures.** A
   pull that turns into a scroll is abandoned rather than fought — the lamp
   answers a deliberate pull, not a scroll that happened to pass through 0.
4. **`data-motion-recipe` is not on CSS animations.** The id convention covers
   the Web Animations API; CSS classes like `pc-drawer-in-right` name
   themselves in `getAnimations()` output already.

## Left after this

- The WP9d row's other half — items 1, 2, 7 — lands elsewhere and will want
  the same gate treatment when it does.
- `usePresence` holds the leave for `--duration-fast`; a plate that ever needs
  a longer exit needs that number revisited, not a second timer.
