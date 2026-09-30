# WP-G0 checkpoint: Glass foundation

Contract: `docs/glass-spec.md` §1, §2, §9. Plan row: `docs/design/glass-plan.md` §4 (WP-G0).
Nothing is committed. Everything is in `~/Documents/Paracord-glass` (branch `design/glass`).

## Files changed

| File | Change |
|---|---|
| `client/src/styles/tokens.css` | New Glass block (room tint, ink, fixed colors, shape, shadows, focus, timing). Night block remapped onto Glass. `@theme` fonts, weights and radii moved to Glass. Slate look block reduced to its bubble mix. |
| `client/src/styles/glass.css` (new) | Type roles, focus, Pane, button, chip and waveform recipes. Tokens only. |
| `client/src/styles/globals.css` | One import line (`glass.css`, in `layer(components)`). |
| `client/src/main.tsx` | Font import `@fontsource-variable/instrument-sans/wdth.css`. |
| `client/src/components/glass/primitives/` (new) | `Glyph`, `Waveform`, `GlassButton` (+ `JoinButton`), `Kicker`, `InstrumentText`, `Pane`, `GlassChip`, `GlassShowcase`, `index.ts`, and two test files. |
| `client/src/pages/DesignTokensPage.tsx` | A Glass section (first on the page) that mounts `GlassShowcase`. |
| `client/scripts/contrast-audit.mjs` | `color-mix()` evaluator, Glass sweep, and a reference-tint check. |

## The room tint

One triplet, `--room-rgb`, is the only value JS will write. Every tinted surface is
`color-mix(in srgb, rgb(var(--room-rgb)) N%, <neutral>)`. Panes, deep and solid take 4%;
bub, raise and sel take 6% (the cap); glow is the room lifted 30% toward white at 7% alpha.
The derived tokens are declared for `:root, .glass-room`, so a subtree that sets its own
`--room-rgb` re-derives its own surfaces (the design page shows both tints that way).
`:root` defaults to the warm sample. `.glass-tint-warm` and `.glass-tint-cool` set the samples.

Room samples used (fitted, then rounded):

- warm (live stream): `222, 109, 35`
- cool (banner, nothing live): `80, 158, 255`

Neutrals (fitted to those two samples): pane `#151616`, solid `#141515`, deep `#0c0d0d`,
bub `#232426`, raise `#2e3032`, sel `#2c2e30`.

Resolved values against the spec table (CIE76 delta-E on the 8-bit result; the glow is
compared as it lands on its own solid, because it is 7% opaque). Browser values were read
back in Chromium and match these:

| Token | Warm got | Warm ref | dE | Cool got | Cool ref | dE |
|---|---|---|---|---|---|---|
| `--pane` (a .94) | 29,25,23 | 28,25,23 | 0.55 | 23,27,31 | 23,27,31 | 0.00 |
| `--bub` | 46,40,38 | 45,41,38 | 1.22 | 38,43,51 | 39,45,52 | 1.19 |
| `--raise` | 57,52,49 | 56,51,47 | 0.83 | 48,55,62 | 49,56,64 | 0.82 |
| `--sel` | 55,50,47 | 54,49,45 | 0.84 | 46,53,60 | 47,54,63 | 1.44 |
| `--deep` (a .96) | 20,17,14 | 20,18,16 | 0.70 | 15,19,23 | 16,18,21 | 1.16 |
| `--solid` | 28,25,22 | 28,25,23 | 0.72 | 22,26,30 | 24,28,32 | 1.01 |
| `--glow` (a .07) | 232,153,101 | 255,168,88 | 1.50 | 133,187,255 | 150,190,230 | 1.43 |

Worst delta-E is 1.50 (limit 2). This is enforced: `contrast-audit.mjs` fails if any of the
fourteen values drifts to 2 or more, or an alpha moves by more than .005. Set
`PARACORD_AUDIT_VERBOSE=1` to print the table.

Why per-token neutrals and 4 to 6% rather than one mix: the reference tints move about 1.5x
more between warm and cool on the lighter steps (bub, raise, sel) than on solid, which a
single shared percentage cannot reproduce.

## Remap of the Lantern semantic tokens

The default theme is the **Slate look**, so the Glass values had to reach it. Night's
block (which `:root` and every dark theme share) is remapped, and Slate's own palette was
removed from its block (it inherits Night now). Slate keeps only `--bubble-mix` (0.14) and
`--bubble-own-mix` (0.2): lowered from 0.22 and 0.3 because author-colored bubbles at the old
mix failed 4.5:1 for `--text-faint` on the new plate. Dusk, Aubergine, Paper, Daylight, AMOLED
and High contrast are untouched (WP-G1 retires them).

| Lantern token | Now |
|---|---|
| `--bg-base` | `--street` (3% room into `#08090a`) |
| `--bg-plate` | `--solid` |
| `--bg-raised` | `--bub` |
| `--bg-well` | `--well` |
| `--bg-floating` | `--raise` at 97% |
| `--bg-selected`, `--row-selected` | `--sel` |
| `--bg-mod-subtle` / `-strong` | white at .04 / .09 |
| `--text-primary`, `--text-body-ink` | `--ink-1` |
| `--text-secondary` | `--ink-2` |
| `--text-muted`, `--text-faint` | `--ink-3` |
| `--accent-primary` (+ hover, active) | `--join`, `--join-hover`, `--join-press` (cream) |
| `--text-on-accent`, `--text-on-light` | `--join-ink`, `--own-ink` |
| `--light-white`, `--light-amber` | `--join`, `--amber` |
| `--light-ring-rgb`, lit rings and window glows | amber (`255, 194, 126`) |
| `--focus-ring-color` | `rgba(255,255,255,.85)` |
| shadows | Glass content, raised and pane shadows |
| radii | plate 28, card 20, well 16, control 12, chip 8, stage control 22 |
| `--font-primary`, `--font-display` | Instrument Sans Variable first, Onest/Gabarito as fallback |
| display/title/heading weights | 600 (display tracking -0.025em, title 20px, heading 17px) |

Semantic accents (danger, warning, info) are unchanged: how to treat red and green in chrome is
plan §7 decision 5, which is the owner's.

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:tokens` | pass |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors, 241 warnings (all existing; none in the new files) |
| `node scripts/contrast-audit.mjs` | pass: 21,840 Lantern comparisons; 8,892 Glass comparisons over 114 room tints (warm, cool, dim warm, bright cool, white, black, and 108 hue x saturation x brightness points); reference tints reproduced at dE 1.50 |
| `npx vitest run src/components/glass` | pass, 32 tests |
| `npm run test:unit` | 351 files, 3,276 tests pass **excluding** `src/components/dailyWord/DailyWordView.test.tsx`, which hangs (one worker at 100% CPU, no output) and did so on a clean copy of `HEAD` too, so it is not from this package. `npm run test:unit` as written therefore does not finish here. One failure of mine was fixed on the way: `vocabulary.test.ts` rejects the word "room" in page copy, so the design page's blurb avoids it |

Glass ink is checked at 7:1 for `--ink-1` and 4.5:1 for `--ink-2`, `--ink-3`, `--amber`
and `--amber-ink` on pane (over the brightest backdrop the room can draw, 60% white), pane +
glow, bub, raise, sel, deep, solid, street and well; ink over the glass control fills and
the pill; chip inks; amber-ink over the live chip tint; and the fixed pairs (own bubble,
mention chip, Join at rest, hover and press).

## Screenshots (`output/design-reference/glass-build/g0/`)

- `glass-1.png`, `glass-2.png`, `glass-3.png`: the Glass section of `/design-tokens` at 1440x900
  (both tints; ink, type roles, glyphs, waveform; buttons and chips).
- `glass-room-warm.png`, `glass-room-cool.png`: each tint on its own.
- `app-login.png`: the main app's login page, old layout, now Glass-colored (pane radius,
  cream Log in, Instrument Sans). I could not get past login: there is no server here.

Compared with `screens/01-conversation.png` and `02-quiet.png`: pane and bubble tones match
(warm `#1d1917` pane, `#2e2826` bubble; cool `#171b1f`, `#262b33`); the own bubble is `#ecebe6`
with dark text; the mention chip is white; the live chip is amber; the Join button is cream and
sits in a black pill; the listening button is the amber-tinted glass; the waveform is five amber bars.
The glyph shapes are the spec's paths. Type is Instrument Sans with the narrow instrument cut on
times and the kicker. No known visual differences from the reference for these parts. The
prototype's pill has a faint amber glow beneath it (spec §5); that belongs to WP-G12, not here.

## Not done or unsure

- **Reduced transparency**: `glass.css` keys off `:root[data-reduced-transparency='true']`. Nothing
  writes that attribute yet (WP-G1 adds the setting), so it never matches today.
- **Pane glow does not breathe.** The prototype animates the far-corner glow's opacity; I left it
  static (a 7-second loop on every pane is a cost on WebKitGTK, and the spec does not ask for it).
- **`.pc-pressable` still scales on press** for the old primitives; that is WP-G21. The new Glass
  buttons never scale.
- **Legacy waveform-like and light components** (`LitAvatar`, `OnAirPill`, …) now draw amber rings
  through `--light-ring-rgb`, but their layout is unchanged.
- **The Slate look's bubble mix** was lowered to keep its author-colored bubbles legible on the new
  plate. WP-G10 replaces those bubbles.
- **`--text-link` is now ink-1** (no Glass link color is specified); links inside old screens rely on
  their underline or weight to read as links.
- **The unused Onest, Gabarito and JetBrains Mono imports remain** in `globals.css` (I may only touch
  its import line for `glass.css`); they are fallbacks now.
- The clamp box WP-G8 will enforce is not defined yet. The audit sweeps a wide box (three saturations
  and three brightnesses at every 30 degrees, plus white and black), so a tighter clamp only makes it easier.
