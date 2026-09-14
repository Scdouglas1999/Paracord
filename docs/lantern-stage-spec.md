# Paracord Design Language v2 — "Lantern Stage"

> **This file is the contract for the v2 UI overhaul.** It supersedes the visual
> law in `docs/design-spec.md` ("Emerald Commons") and amends the IA law in
> `docs/layout-spec.md` where the two disagree. When a component and this file
> disagree, the component is wrong. Tokens live in `client/src/styles/tokens.css`
> and are re-applied at runtime by `client/src/hooks/useTheme.ts`; consume tokens,
> never hard-code hex. Approved direction: design canvas
> https://claude.ai/code/artifact/4ecb33e2-d0a9-4392-9f49-2f57bda39280 (page
> "Lantern Stage — the direction"; the five artboards there are the reference
> renders for every recipe below).

## 0. The idea, in one paragraph

Paracord is **lit windows at night, and light means people.** Every server you
belong to is a facade of windows; every channel in it is one window. A window is
lit when someone is in the channel — **white light** for a voice channel with
people talking, **amber light** for a text channel with people reading — and
dark when it is empty. People who have the app open have their **lights on**:
their avatar carries a rim of warm light; away or offline avatars are matte. The
centre of the app is **the channel**: when you are in a call you are on the
**Stage** (screen share, cameras, speakers), and text chat is a ribbon beside it;
when you are not, you are in the **Lobby**, looking at the server from the
street. There is no docked member list anywhere — the people who are here *now*
are a lit strip in the header. Everything that is not light is dark, matte and
quiet.

**Vocabulary (§6.9 enforces it).** The community that holds channels is a
**server**. The thing inside it is a **channel** — a **text channel** or a
**voice channel**; you *join voice* or *join the call*, you never "enter a
room". The host somebody runs, connects to and claims is an **instance**:
"Connect to an instance", "Instance address", "Trust new Paracord instance?".
`guild`, `guild_id` and the routes keep their wire names. The words
"building", "room" and "space" are retired from every user-facing surface, and
`client/src/lib/vocabulary.test.ts` fails the build if one comes back.

Two consequences that keep this from becoming decoration:

1. **Every glow has a source.** A lit window, a speaking tile, a live thumbnail,
   a lit avatar. Nothing else glows. No gradient washes across surfaces, no
   ambient halos, no glass.
2. **Light is state, never style.** If a thing is glowing, a person is there
   right now. The moment they leave, it dims (§5 motion). Designers and agents
   must not use the light tokens for emphasis, branding, or "make it pop".

Dark ("Night") is the default. Themes are configurable (§1.7); the light rule is
preserved in every theme by remapping, not removed.

---

## 1. Color

### 1.0 The base hue — one number the whole neutral ramp turns on

Every ground, well, hairline, wash, scrim and grey ink is written
`oklch(L C var(--ui-hue))`. **L and C are the ramp** — fixed per token, per
theme — and **only H moves**, under the reader's control in Settings ›
Appearance (`--ui-hue` in degrees, `--ui-chroma` 0–1 for how much of it).

This is what makes the base colour safe to hand to a person. Relative luminance
is carried almost entirely by L at these chromas, so holding L and C and varying
H leaves every contrast pair where the ramp put it: the interface cannot be made
illegible by a colour choice, at any setting. `npm run test:contrast` proves it
rather than asserting it — the whole circle every 30°, at full tint and none,
across all four themes, plus an sRGB gamut check on every token.

What does **not** follow the hue, and why:

- the two lights (§1.2) and every glow, ring and lamp recipe made from them.
  Light is state; §6.3 will not let a preference recolour it.
- the semantic accents (§1.3) and the identity palette. They carry meaning, and
  a meaning that drifts is not one.
- a plate's warm 1px top highlight — it is the lamp above the plate, so it stays
  the colour of the light rather than the colour of the wall.

Where an accent sits *on* the ground — a selection wash, a hover wash — it **is**
written in the base hue. That is what keeps the chrome of one piece.

Default: `--ui-hue: 65`, `--ui-chroma: 1` ("Hearth", a warm charcoal). Stored
per device like the theme, applied live by `useTheme`; no relaunch.

### 1.1 Surfaces (Night — the default)

Values below are Night's L and C; the hue is `--ui-hue` (§1.0). The hex in
brackets is the default setting, for reference only — never hard-code it.

| Token | Value | Use |
|---|---|---|
| `--bg-base` | `oklch(16.5% .007 H)` (`#100E0B`) | App base behind everything; the "street". |
| `--bg-plate` | `oklch(21.3% .009 H)` (`#1C1815`) | Plates: the Stage, the Lobby, a text channel, the chat ribbon, cards that hold content. |
| `--bg-raised` | `oklch(25.2% .012 H)` (`#26211C`) | Raised inside a plate: chips, composer, hover cards, popovers. |
| `--bg-well` | `oklch(17.1% .0065 H)` (`#120F0D`) | Recessed inside a plate: search, tiles' background, "here now" strip, event cards. |
| `--bg-floating` | `oklch(21.3% .009 H / .97)` | Menus, tooltips over content. |
| `--bg-mod-subtle` | `oklch(84% .07 H / .05)` | Hover wash on rows — warm, not grey. |
| `--bg-mod-strong` | `oklch(84% .07 H / .12)` | Pressed wash. |
| `--bg-selected` | `oklch(84% .07 H / .10)` | The row you are on. |
| `--row-selected` | `var(--bg-selected)` | The same, but a server's group overrides it with `color-mix(in srgb, var(--identity) 16%, transparent)` so the selected row wears that server's colour. |

Depth is delivered by a **1px warm top highlight** (`0 1px 0 rgba(243,234,216,.07) inset`)
plus a deep shadow (`0 20px 44px rgba(0,0,0,.5)`) on plates, and an **inset
shadow** (`0 1px 2px rgba(0,0,0,.6) inset`) on wells. Never a border-only depth.

### 1.2 Light — three lights, three meanings

| Token | Value | Meaning | Where |
|---|---|---|---|
| `--light-white` | `#F3EAD8` | **Talking / live.** People in a voice channel. | Lit window, live channel thumbnail, speaking tile ring, lit avatar rim, "LIVE" dot, the primary Join button in a lit context. |
| `--light-amber` | `#E2C98F` | **Reading.** People present in a text channel. | Amber window, text-channel dot, "reading" counts. |
| `--accent-primary` | `#2BD39A` | **Action you can take.** | Primary buttons outside a lit context, links, @mentions, focus ring, live data lines. |

Light effects are fixed recipes, not free values:

- Lit window: `background: var(--light-white); box-shadow: 0 0 6px rgba(243,234,216,.55)`; amber uses `rgba(226,201,143,.5)`.
- Lit avatar (`.lit`): `box-shadow: 0 0 0 1.5px rgba(243,234,216,.55), 0 0 12px rgba(243,234,216,.22)`.
- Speaking tile: `0 0 0 1.5px rgba(243,234,216,.7), 0 0 18px rgba(243,234,216,.25)`.
- Lit plate (a card whose channel is live): `0 0 0 1px rgba(243,234,216,.16), 0 0 34px rgba(243,234,216,.10)` on top of the plate shadow.
- The one permitted radial: a **lamp** inside a lit server/channel card —
  `radial-gradient(closest-side, rgba(243,234,216,.16), transparent)` sized to the
  card's top-left, one per lit card, never on a surface without a lit channel.
- Away/offline (`.dim`): `filter: saturate(.35) brightness(.72)`; no rim.

Text/icon on white light: `--text-on-light = #0A0C10`. On emerald: `--text-on-accent = #06241A`.

### 1.2a Identity — whose it is, never what state it is in

Eight fixed hues (`--color-avatar-1…8`) say **who somebody is** and **which
server this is**. Identity never carries state, never glows, and never moves:
not with the theme, and not with the base hue. A person's colour is who they
are, not where the app is and not what ground the reader picked.

| Where | Which token |
|---|---|
| Avatar fallback, server mark on a section label, Home card, Lobby header | `--color-avatar-N` (the fill) |
| An author's name in the timeline, unless a role has coloured it | `--identity-ink-N` |

The split exists because a fill and a piece of text are not the same problem:
apricot inside a 28px circle is fine on paper, and apricot written as a name on
paper measures about 2:1. On a dark ground the ink **is** the fill; Daylight
carries its own deepened set (same hue, L 48%, the most chroma that stays in
sRGB), which clears 4.9:1 on the darkest paper ground at every base hue.
A role colour outranks identity — a role is something the server said about
somebody, and it should win.

### 1.3 Semantic (unchanged in meaning; re-tuned to the warm neutral)

`--accent-danger #F07C7C` (leave/hang up, destructive), `--accent-warning #E8B23A`,
`--accent-info #8FA9D9`, `--accent-success` **is the emerald** only in
confirmation toasts; never reuse light tokens for semantics.

### 1.4 Text ramp

| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#F1EEE7` | Names, headings, selected labels. |
| `--text-body` | `#D4D1CA` | Message bodies, prose. |
| `--text-secondary` | `#B3B0A8` | Nav rows, secondary labels. |
| `--text-muted` | `#8B8D8E` | Captions, previews. |
| `--text-faint` | `#838587` | Meta (timestamps, counts, section labels). |

> **Corrected in WP0.** This step read `#6C6E70` (the value in the reference
> renders), which measures **3.51:1** on `--bg-plate` and so cannot satisfy §9's
> non-negotiable "meta ≥ 4.5:1". `#838587` is the smallest lift that clears
> 4.5:1 on all four Night grounds. See `docs/design/wp0-checkpoint.md`.

### 1.5 Presence

Presence is **light**, not a coloured dot. Online = lit rim; idle/away = dim; do
not disturb = dim + a small `--accent-danger` slash on the rim; offline = dim, no
rim. The old status-colour dots (`--color-status-*`) are removed from the UI.

### 1.6 Borders

Hairlines only where a plate needs an internal divider, and they take the base
hue with everything else: `--border-subtle oklch(94% .022 H / .07)`,
`--border-strong oklch(94% .022 H / .14)`.

### 1.7 Themes & accent presets

Themes remap the *tokens*, never the recipes:

- **Night** (default) — values above.
- **Daylight** — warm paper `#F4F1EA` base, plates `#FBF9F4`, wells `#EBE6DC`, ink
  text `#17170F`; the light tokens become **ink** (`--light-white → #17170F` rim,
  `--light-amber → #855E30`) with the same box-shadow recipes at half alpha, so
  "lit" still reads as presence on a light ground.
  *(Corrected in WP0: the amber read `#A8763C`, which measures 3.17:1 on
  `--bg-well`. Amber is a label as well as a fill — "5 reading" — so it has to
  clear §9's 4.5:1; `#855E30` is the smallest deepening that does.)*
- **AMOLED** — `--bg-base #000` (true black is hueless), plates and everything
  above them take the base hue; light recipes unchanged.
- **High contrast** — rims 2px, alpha ×1.5, text ramp collapsed to two steps.
  **It takes the base hue in the chrome only.** The two extremes that do its
  legibility work — the black street and wells, and the white ink — are literal
  black and white and carry no hue at all, so no colour choice can soften them;
  the surfaces between them and the hairlines follow `--ui-hue`, so the reader's
  choice is still visible and the chrome is still of one piece.

Every theme's ramp is expressed the same way (§1.0), so a theme and a base
colour compose rather than fight: picking Daylight and picking Harbour are two
independent choices and every pair of them passes §9.

Accent presets (existing `ACCENT_PRESETS`) recolour `--accent-primary` only.
Base-colour presets (`BASE_HUE_PRESETS`) move `--ui-hue` / `--ui-chroma` only.
Neither ever touches the light tokens.

---

## 2. Type

Three faces; character comes from the pairing, not decoration.

- **Display / names — `--font-display: 'Gabarito'`** (self-host via
  `@fontsource/gabarito`, weights 500/600/700). Channel and server names,
  page titles, author names, section leads, tile name tags.
- **UI / body — `--font-primary: 'Onest'`** (`@fontsource/onest`, 400/500/600).
  Everything else.
- **Meta — `--font-code: 'JetBrains Mono'`** (already in the tree). Timestamps,
  durations, counts, latency readouts, keyboard hints, filenames.

Remove Fraunces and Inter from the bundle and the tokens.

| Step | Size / weight / tracking / leading | Face | Use |
|---|---|---|---|
| Display | 28 / 700 / −0.015em / 1.05 | Gabarito | Lobby and Home titles. |
| Title | 22 / 700 / −0.01em / 1.1 | Gabarito | Stage channel name, text-channel header. |
| Heading | 18 / 700 / −0.005em / 1.2 | Gabarito | Server names, channel card titles. |
| Name | 15.5 / 600 / 0 / 1.2 | Gabarito | Author names, list item titles. |
| Body | 15 / 400 / 0 / 1.55 | Onest | Messages, prose. (Ribbon: 14 / 1.45.) |
| Label | 14 / 500 / 0 / 1.4 | Onest | Nav rows, buttons, inputs. |
| Meta | 12 / 500 / +0.01em / 1.4 | Onest or Mono | Timestamps, counts, captions. |
| Section | 12 / 600 / 0 / 1.3 | Onest | Section labels ("Kestrel Robotics · 24 in") — sentence case, **not** uppercase. |

Base body weight is 400 on this warm ramp (Onest is heavier than Inter at 400).
Tabular numerals (`tnum`) everywhere a number can change.

---

## 3. Spacing, radii, sizes

- 4px grid. Plates sit on a 12px gutter from the window edge and from each other.
- Radii: plates 14, cards/tiles 12, rows/buttons/chips 9, wells 10, windows 2,
  avatars full. Phone: plates 16, controls 16.
- Control heights: nav row 34, list row 36, button 32 (28 compact, 44 phone),
  composer 50 (42 in the ribbon, 46 phone), Stage control 46 (50 phone).
- Sidebar ("Servers column") 276px; chat ribbon 336px; phone breakpoints per
  `docs/layout-spec.md` §6 (unchanged).
- Window map: windows 10×13 (12×16 on Home), 5–6px gaps, 8 per row max; a
  server draws one window per channel, channels ordered voice first, then text by
  activity; **no more than two rows** — overflow collapses into the count.

---

## 4. Elevation

Three layers only: **street** (`--bg-base`) → **plate** → **raised / well**
inside a plate. Never nest a plate in a plate; a raised card inside a plate is
the maximum. Floating surfaces (menus) use `--bg-floating` + the plate shadow.
The glass tokens (`--glass-*`), `--noise-texture`, `--ambient-glow-*` and
`--panel-divider-glint` are deleted.

**A card inside a plate wears a card's depth, not a plate's.** This is what
"never nest a plate in a plate" means in tokens, and it is the rule the code
was breaking silently until the `.pc-*` recipes moved into `@layer components`
(D2, `cf75db8`) and let a call site's own utilities bind:

| Object | Radius (§3) | Depth |
|---|---|---|
| Plate on the street — the Lobby, a text channel, the Stage, a dialog | `--radius-plate` (14) | `--shadow-plate` (warm 1px top highlight **+** the deep drop) |
| Card inside a plate — a server card, a channel card, a DM or Friends row, a settings section, the add tile | `--radius-card` (12) | `--shadow-tile` (the warm 1px top highlight alone) |
| Well inside a plate — search, form fields, Around now, the here-now strip | `--radius-well` (10) | `--shadow-well` (inset) |

The deep drop is what says *this surface floats over the street*. A card that
takes it is claiming to be a plate, and four of them down a column read as four
planes at four distances instead of one plate with four things on it. The one
sanctioned exception is a well that **holds a picture** — `StageTile` (§8) and
the avatar/icon wells — which takes `--radius-card` so its crop matches the
radius the same image is drawn at everywhere else. A well that holds words and
faces stays at 10.

A lit card is the other exception in the other direction: it is carrying a
light source, so it may add `--ring-lit-plate` over the depth it already has
(§5.1). Light, never elevation, is what a lit thing gains.

---

## 5. Motion — the street is alive

**The law: only light and the things people do animate.** Nothing decorative
moves. The base never animates. Every motion below has a physical model, and a
reviewer rejects motion that has none.

### 5.1 Physical models

- **Light has a source and a speed.** A window, rim or tile that lights up
  *blooms* 20% past its resting glow and settles — 220 ms, `--ease-out`. It
  dims over 400 ms, `--ease-in` (light lingers a beat, then goes). Neighbouring
  lights stagger 30 ms. A lamp fades in once the first window in its plate is
  lit. Reading light *flickers* once (two 40 ms pulses) when a message lands.
  *(WP9b: "lights on" is one sequence with one clock, played by
  `components/motion/MotionDirector` over the `data-motion-*` marks components
  put in the DOM — a component says what it is holding, never when it moves.
  The three things that turn the lights on are the first presence of a run, a
  gateway reconnect and a return from more than five minutes away
  (`lib/attention/lightsOn.ts`), and each waits for presence to actually be in
  hand. The 30 ms stagger compresses so a large map still lands inside §5.3's
  1.6 s rather than being capped. See `docs/design/wp9b-checkpoint.md`.)*
- **The thing you click becomes the thing you look at.** Navigation into a channel,
  a thread, a settings section or a dialog moves one shared element from where
  it was to where it will be (View Transitions API where the webview has it,
  Web Animations transform fallback elsewhere — the same choreography on
  both). 360–420 ms on the *spring-settle* curve; supporting chrome rises 80 ms
  later, staggered. Leaving reverses it (into the on-air pill for a call).
  *(WP9b: a channel travels under one name, `room-<channelId>`, on every surface
  that draws it, so the Lobby card, the sidebar row, the inline "lit up" event,
  the Stage's dominant region and the on-air pill are all the same journey. The
  caller says which element the gesture started on and where it is going,
  because more than one surface carries the name at once. Every destination is
  behind a lazy route chunk, so the journey waits for the place it is going to
  — which is what the browser is holding the old frame for — and the Web
  Animations fallback holds a copy of what you clicked until the channel arrives.
  Joining from the Lobby now takes you INTO the channel; it used to join the call
  and leave you in the street.)*
- **Arrivals travel one path.** Someone entering a channel: their window blooms →
  their rim catches 120 ms later → they spring into the here-now strip →
  counts re-roll like a flip counter → the inline channel event fades in last.
  Leaving is the mirror. Nothing else on screen moves.
  *(WP9b: the newcomer springs in on transform and opacity, and everything the
  insertion displaced is carried by a FLIP on transform alone — §5.3 puts no
  layout property in a keyframe, so the study's animated slot width is not
  copied. A leaving face is a ghost the engine owns, because the update that
  told us has already taken the real one out of the tree. A burst inside 300 ms
  is ONE staggered sequence, not five. Your own arrival never plays: that is
  the moment below. Occupancy is read from voice membership, which is exact;
  "reading" in a text channel is derived and deliberately out of scope.)*
- **A message has mass.** Sent text lifts out of the composer along the path it
  lands in the timeline (220 ms, ease-out); the composer relaxes 0.8% and
  springs back; the send control flashes white light for one beat; the channel's
  amber window flickers. Receipts fade in only after the server answers.
  *(WP9a: "after the server answers" is structural here, not a check — this
  runtime has no optimistic row at all, and publishes a message only once the
  authoritative recovery feed has vouched for it, so the row and its receipt
  arrive together. The receipt is "Delivered" under your last message; the read
  half waits on read-state fan-out.)*
- **Speaking is a breath.** The speaking ring breathes between the two alphas
  in §1.2 at ~1.6 s and, where the engine exposes level, brightens with the
  voice (±15% intensity, 60 ms attack / 240 ms release) — never below the
  resting ring.
  *(WP9d: the level comes from the media engine that is actually running — the
  native engines' RTP audio-level header, LiveKit's own 0–1, and the local mic
  analyser for your own ring, which knows before the server does. ONE
  `requestAnimationFrame` loop writes `--voice-level` for every tile on screen
  and exits when the last voice releases; never a loop per tile and never React
  state, because a level is fifty updates a second. The ring is multiplied, not
  replaced, so "never below the resting ring" is arithmetic — which is why
  `tokens.css` now writes the three ring recipes in parts: a custom property is
  substituted where it is DECLARED, so a recipe composed on `:root` could only
  ever read the root's level. Where an engine reports speaking but no level, the
  ring simply breathes. See `docs/design/wp9d-checkpoint.md`.)*
- **The lights change.** Changing the theme crosses the whole shell over
  `--duration-dim` — View Transitions where the webview has them, a dip through
  the street's own colour everywhere else — and the light elements re-bloom once
  the new ground has settled. The gateway being away is drawn on the server
  rather than beside it: it dims 30% and holds there until it is back, and
  **never a spinner on the street**. Coming back replays "lights on" for the
  plates that actually went dark, and they do not travel — a plate rises when it
  ENTERS the street.
  *(WP9d: `lib/motion/lights.ts`, with the edge in `lib/attention/outage.ts`.
  The outage waits out a 600 ms grace, because a gateway blips several times an
  hour and a server that dims for 80 ms is a flashing blocker. The theme is
  applied INSIDE the crossfade by `useTheme`'s own effect, so the engine is told
  how to recognise that it landed rather than guessing at frames; and nothing
  else may be a transition for the length of the one that matters — a theme swap
  otherwise starts several hundred colour transitions underneath it.)*
- **Controls are tactile.** Hover: 1 px lift + faint bloom (`--bg-mod-subtle`
  wash, 120 ms). Press: 0.96 scale, 80 ms, then spring back. Toggles, tabs and
  segmented controls slide their indicator on the spring-settle curve.
- **Plates settle.** A plate entering the street rises 14 px on the spring-settle
  curve; lists that change order animate layout (FLIP) on the same curve.
- **Numbers re-roll.** Any count that changes (unread, "N reading", "24 in",
  duration ticks excepted) flips vertically, old up/out and new up/in, 180 ms.

### 5.2 Curves and tokens

Two curves only, both tokens: `--ease-out` `cubic-bezier(0.22, 1, 0.36, 1)` for
light and fades; `--ease-spring-settle` `cubic-bezier(0.34, 1.2, 0.64, 1)` for
things that move (one small overshoot, no bounce). Springs in code use
stiffness 260 / damping 22–28 / mass 1 (`--spring-*` tokens) and must resolve
to those curves. Durations: `--duration-fast` 120, `--duration-normal` 160,
`--duration-slow` 220, `--duration-warm-up` 220, `--duration-dim` 400,
`--duration-move` 380, `--duration-breathe` 1600, `--duration-roll` 180.

### 5.3 Budget and gates (non-negotiable)

- `transform` and `opacity` only, plus `box-shadow`/`background` on the small
  light elements (windows, rims, dots). No layout properties in keyframes.
- No motion longer than 500 ms except breathing and the lights-on stagger
  (whole sequence ≤ 1.6 s).
- 60 fps on an integrated GPU: every signature moment is measured in a
  Playwright trace; a frame over 32 ms fails the motion gate.
  *(WP9a, `client/e2e/motion-gate.spec.ts`: the budget is applied to the frames
  the engine owns — those served while an animation is in flight — plus a 50 ms
  ceiling over the whole moment. Two exceptions are allowed BY NAME and printed
  on every run: the send moment's one frame, which is `MessageList`'s own render
  of the arriving row and is there to the frame with motion switched off; and
  the View Transitions path, which the harness's software renderer halves the
  frame rate for. See `docs/design/wp9a-checkpoint.md` §4.)*
  *(WP9b adds one more named allowance, also printed on every run: the walk-in's
  Web Animations path may drop the frame on which the channel's own surface mounts,
  at one. Measured again with the engine's ghosts removed entirely, the same
  frame is still 33 ms in the same place. See `wp9b-checkpoint.md` §9.)*
  *(WP9d adds the third and last: the theme crossfade may drop the frame the
  theme is applied on, at one. With the engine switched off entirely the same
  click costs a 150 ms frame — the app's own restyle of every surface — and the
  crossfade exists partly to hide it, which is the same service the View
  Transitions path gets from holding a snapshot. See `wp9d-checkpoint.md` §4.)*
- `prefers-reduced-motion`: everything lands instantly, no stagger, breathing
  stops at the resting ring. One central switch, never per component.
  *(WP9a: the switch is `client/src/lib/motion/reducedMotion.ts`. It folds the
  OS media query with an explicit user setting — Settings › Appearance › Motion,
  `system` / `full` / `reduced` — and publishes the answer as `data-motion` on
  `<html>`, which is what CSS reads. There is no `prefers-reduced-motion` media
  query left in the stylesheets and no component may add one: it would be a
  second source of truth and "Full motion" could not win against it.)*
- Motion never delays input: a control responds on the same frame; animations
  are interruptible and retarget (a spring, not a fixed tween).
- Never animate on first paint what the user did not cause or presence did not
  cause; loading skeletons crossfade to content, they do not pulse forever.
  *(WP9b: the edges that decide this are pure and testable —
  `lib/attention/lightsOn.ts` for the server waking, `arrivals.ts` for a
  person crossing a channel's threshold. A gateway snapshot that REPLACES a
  guild's membership is the picture arriving, not people walking in, and
  re-baselines the arrival director rather than animating.)*

Reference studies for the four signature moments are on the design canvas
(page "Motion") and in `output/design-reference/motion/`. The engine that
implements them is `client/src/lib/motion/` (WP9a, WP9b); every recipe in it is
on `/design-tokens` › Motion with a Replay button and the tokens it spends.

## 6. Anti-slop kill-list (extends the Emerald Commons list; a reviewer rejects any instance)

1. **No glow without a source** (§0). No radial "ambience" on plates, no glowing borders on idle cards, no halo behind headings.
2. **No gradient wash across a surface or a button.** The lamp radial in a lit card is the only radial; the camera tile's subtle vignette is the only other gradient.
3. **Light tokens are never used for emphasis** — not for badges, not for "new", not for brand moments.
4. **No fake video.** Camera tiles without frames show the initials avatar on a dark tile, never a silhouette illustration.
5. **No docked member list.** Presence is the "here now" strip and lit avatars in context.
6. **No status-colour dots.** Presence is light (§1.5).
7. **No LIVE badge louder than the channel.** The LIVE dot is 6px and the label is 10.5–11px; the thumbnail carries the weight.
8. **No emoji as UI chrome; no uppercase section labels; no over-rounding** (radii in §3); **no identical-card tiling** (the Lobby mixes a lit card, a dark card and an add tile; text channels are rows, not cards).
9. **Copy is specific and in the metaphor**: "5 reading", "3 talking", "lights on", "Dark · nobody's in", "Say something to the 5 people here". Never "No data", "It's quiet here", "Online".
10. Everything from `docs/design-spec.md` §6 that is not superseded above still applies (buttons solid/tactile, empty states left-aligned with an action, density matched to surface, intentional rhythm).

---

## 7. Surfaces and their laws

### 7.1 Servers column (replaces the unified sidebar's body)

Top to bottom: search well (⌘K) · Home / Messages rows with counts · **per
server**: a section label ("Kestrel Robotics · 24 in"), the **window map
plate** (one window per channel; lamp radial only if a channel is lit; caption
"2 calls live · 3 reading"), then channels as rows — a **lit voice
channel renders as a live thumbnail row** (thumbnail 64px tall, LIVE dot,
occupant stack, name + "you're here"/"N talking"), dark voice channels as plain
rows ("Dark · nobody in"), text channels as rows with an amber/dark window dot
and "N reading" · repeat for each server · account plate pinned to the bottom
("Lights on"). Needs-you no longer lives in the sidebar (it lives on Home and as
the Home count); the cross-server merge from `layout-spec` §3 still drives
ordering (brightest server first, then most recent). The landmark is
`Servers and channels`.

### 7.2 Stage (in a call) — reference artboard 1 / phone artboard 5

Plate with: header (channel name, server · duration, **here-now strip**, Invite /
Layout / more) · **share or focused speaker as the dominant tile** (16:9,
`meet` fit, name tag bottom-left, transport readout top-right in mono) ·
speaker strip beneath (equal columns, speaking ring, mute glyph on tag) ·
control bar centred (mic **on = white light**, headphones, camera, share, leave
in danger). When nobody shares, the grid is speakers only (VideoGrid rules).
The chat ribbon (336px) shows the voice channel's text chat with lit avatars, a
"from the call" highlight on messages written by someone currently in the call,
and a composer "Say something to the call". Phone: share on top, 2×2 speakers,
controls, then a chat sheet (drag handle) — no fake status bar.

### 7.3 Lobby (a server, not in a call) — artboard 2

Header (server mark, name, "24 of 61 have their lights on · 2 calls live ·
next event") · **Around now** well (lit avatar stack + one sentence naming
who is where) · **voice channels grid** (landmark `Voice channels`): lit channels
as lit cards with the live thumbnail, duration, occupants, "Mara speaking",
**Join in white light**; dark channels as matte cards ("Dark · nobody's in",
"last lit 2 h ago", Open); an add tile ("Add a voice channel") ·
**Coming up** event card + **Recently in the shop** media strip · **text channels
as rows** (landmark `Text channels`: window dot, name, last author · time,
preview, reader stack, mention chip). Replaces `RoomsView`/`GuildHomeHeader`/`LiveRoomsGrid`/
`TextChannelList` presentation; keeps their data.

### 7.4 Text channel — artboard 3

Full-width plate: header (amber dot, name, server · topic, **here-now strip
"5 reading · 19 lights on"**, search / pins / threads / more) · timeline with
36px lit avatars, author name in Gabarito, "in Shop floor · 9:12 AM" meta when
the author is in a voice channel · channel events inline ("Shop floor lit up · Mara, Priya
and Ren are in there now · Join") · composer "Say something to the 5 people
reading". Pending/failed delivery rows keep their current region above the
composer, restyled as raised rows.

### 7.5 Home — artboard 4

Title "Tonight" (time-of-day word: Morning / Afternoon / Tonight) + one
sentence · Around now well · **Your servers** (brightest first; a lit server
renders with its live thumbnail beside the window map, then its lit text
channels) · Coming up · Add a server · right column **Needs you** (lit avatar,
one-line reason, one action) and **Pick up where you left off**.

### 7.6 Messages / DMs

A DM is a text channel between two people: same text-channel plate, the header's
here-now strip shows the peer's light ("Ren · lights on · reading this") and the
encryption state as a plain label. Group DMs render as channels too. First-DM
setup states keep their current copy, restyled.

### 7.7 Chrome you carry with you

- **On-air pill** (replaces `MiniVoiceBar`): when you are in a call and looking
  at something else, a small raised pill in the header — white dot, channel name,
  duration, mic state — tap to return to the Stage.
- **Voice connection check** (item 13) opens as a plate over the Stage; its
  steps use the same light/amber/danger vocabulary.

---

## 8. Component recipes (tokens only)

- **WindowMap** — grid of `.win` cells; `on`/`warm`/dark; ≤2 rows; caption.
- **BuildingPlate** — plate + WindowMap + caption; `lit` variant adds the lamp radial.
- **RoomThumbnail** — 8px radius well, live frame or still, LIVE dot + label, occupant stack bottom-right; heights 64 (sidebar), 168 (Lobby card), 176 (Home).
- **RoomCard** — plate; `lit` variant (light ring + lamp) with duration, occupant stack, speaking line, **Join in white light**; `dark` variant with "last lit" and Open.
- **LitAvatar** — avatar + `.lit` rim; `speaking` breathes; `dim` for away.
- **HereNowStrip** — well; avatar stack (max 5) + "N here · M lights on"; click opens the people sheet (the only place a full list lives).
- **StageTile** — 12px radius well; name tag; `speaking` ring; camera-off = initials; share = `meet`-fit content + readout.
- **ControlBar** — 46px controls, 13px radius; mic-on is white light; leave is danger; phone 50px.
- **RoomChatRibbon** — plate, 336px; compact messages (28px avatars); "from the call" raised message; composer 42px.
- **TextRoomRow** — grid `22px 1fr auto`; window dot, name + last author/time, preview, reader stack, mention chip; `active` raised.
- **NeedsYouRow** — grid `32px 1fr auto`; lit avatar, reason, single action.
- **EventCard** — well; day tile (mono weekday + Gabarito date), title, meta, one action.
- **Composer** — raised, 50px, plus / text / image / emoji / send (send = emerald, or white light inside the Stage ribbon).
- **OnAirPill**, **SearchWell**, **NavRow**, **AccountPlate** as drawn.

---

## 9. Accessibility (non-negotiable)

- Every light state has a text equivalent in the DOM ("3 talking", "5 reading",
  "lights on", "speaking") — light is never the only cue.
- Contrast: body text ≥ 7:1 on plates; meta ≥ 4.5:1; white-light Join button ink
  ≥ 12:1; emerald on plate ≥ 4.5:1 for text.
- Focus ring: 2px `--accent-primary` outside a 2px `--bg-base` gap; visible on
  every control including tiles and window cells.
- Reduced motion per §5; reduced transparency: `--bg-floating` becomes opaque.
- Hit targets ≥ 32px desktop, ≥ 44px phone.

---

## 10. Build scope — work packages for sub-agents

Build on a fresh branch (`design/lantern-stage`) from the landed improvement
program; do not mix with `codex/improvement-program`. Every package: tokens only,
screenshots at 1440×900 and 390×844 compared against the reference artboards,
existing unit/e2e suites green, changed-file lint zero errors. Verification is
visual **and** automated — no package is done without inspected screenshots.

| WP | Scope (owner) | Files | Depends on |
|---|---|---|---|
| **WP0 Tokens & type** | New token set (§1–§4), fonts (`@fontsource/gabarito`, `@fontsource/onest`), theme remaps (§1.7), delete glass/noise/ambient tokens, `useTheme` presets, `text-*` utilities; a `/design-tokens` dev page rendering every recipe. | `client/src/styles/tokens.css`, `globals.css`, `hooks/useTheme.ts`, `package.json` | — |
| **WP1 Light primitives** | `WindowMap`, `BuildingPlate`, `LitAvatar`, `HereNowStrip`, `RoomThumbnail`, `OnAirPill`, motion (§5), presence-as-light selectors (who is talking/reading where, per server, across instances — extend `lib/attention` and the voice/read-state stores; the channel-thumbnail frame source from the native stream pipeline at ≤2fps). | `components/light/*`, `lib/attention/*`, `stores/voice*`, `lib/media/*` (read-only frame tap) | WP0 |
| **WP2 Servers column** | Replace the sidebar body with §7.1; remove Needs-you from the sidebar; keep collapse/keyboard behaviour from `layout-spec` §5. | `components/layout/sidebar/*`, `Sidebar*.tsx` | WP1 |
| **WP3 Stage** | §7.2 desktop + phone: restructure `VideoGrid`/`StreamViewer`/`FocusedWebcamView`/`VoiceControlBar` into the Stage plate; chat ribbon; here-now strip; `MiniVoiceBar → OnAirPill`. Keep every media-engine contract untouched (see `native-streaming-pipeline` memory). | `components/voice/*`, `pages/GuildPage` (voice route), `components/message/*` (ribbon variant) | WP1 |
| **WP4 Lobby** | §7.3 on top of `RoomsView`/`RoomCard`/`AroundNowStrip`/`TextChannelList`; event card from scheduled events; media strip from recent attachments. | `components/rooms/*`, `pages/GuildHomePage` | WP1 |
| **WP5 Text channel & DMs** | §7.4 + §7.6: header strip, timeline restyle, channel events inline, composer copy; keep the durable-delivery/recovery regions. | `components/message/*`, `components/layout/TopBar*`, `pages/DMPage` | WP1 |
| **WP6 Home** | §7.5 on `HomePage`/`HomeNeedsYou`. | `pages/HomePage.tsx`, `components/home/*` | WP1, WP4 |
| **WP7 Settings, modals, onboarding, setup** | Restyle to the plate/well system; `/setup-server`, register/login, voice connection check, admin. No new features. | `components/settings/*`, `pages/*` | WP0 |
| **WP9a Motion engine** | Spring/choreography layer over the motion tokens (`lib/motion/`: springs, stagger, shared-element with View Transitions + WAAPI fallback, flip counter, bloom/flicker recipes, central reduced-motion), motion tokens in `tokens.css`, frame-timing gate, `/design-tokens` Motion section. | `lib/motion/**`, `styles/tokens.css`, `styles/primitives.css`, `e2e/motion-gate.spec.ts` | WP8 |
| **WP9b Signature moments** | Lights on, walk into a channel / back to the pill, someone arrives/leaves, say something — wired through the real stores and engines (§5.1). `docs/design/wp9b-checkpoint.md`. | surfaces from WP2–WP6 | WP9a |
| **WP9c Systematic micro-motion** | Hover/press, plates settle, menus/dialogs/toasts enter-exit, tab/toggle indicators, list FLIP, phone sheet physics, number re-roll everywhere. | `ui/**`, `light/**`, dialogs, sidebar, Stage sheet | WP9a |
| **WP9d Further moments** | Audio-reactive speaking ring, theme change as the lights changing, reaction pop, typing pulse, contextual plates sliding in, phone pull-to-refresh lamp. | per item | WP9a |
| **WP8 Sweep & delete** | Remove Emerald Commons leftovers: old tokens, `--color-status-*` dots, glass panels, Fraunces/Inter, any remaining member-list dock; update `docs/design-spec.md` → pointer to this file and `docs/layout-spec.md` §7 recipes; README screenshots. | repo-wide | all |

Ownership boundaries are per file globs above; WP3/WP4/WP5/WP6 can run in
parallel after WP1 lands. WP0 and WP1 are sequential and gate everything.
