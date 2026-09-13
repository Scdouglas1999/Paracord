# WP0 — Tokens, type, themes, primitives

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §1–§5, §9.
Branch: `design/lantern-stage`. This package gates every other one.

Everything here is checkable in one place: run the client and open
**`/design-tokens`** (dev builds only). It renders every token with its resolved
value, the full type scale, every primitive in every variant and state, and the
four themes side by side.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/styles/tokens.css` | **The single source of truth.** `@theme` maps the Tailwind colour namespace; `:root` holds the literal Night values; `[data-theme='…']` blocks remap them. |
| `client/src/styles/primitives.css` | The `pc-*` recipe classes — plate, well, raised, floating, lit, speaking, dim, dnd, window, lamp, focus, live dot. Tokens only, no literals. |
| `client/src/components/ui/` | The React primitives + `index.ts` barrel. |
| `client/src/lib/presence.ts` | Presence → light (`presenceLight`). The only place that mapping is written down. |
| `client/src/lib/colors.ts` | `getIdentityColor` — the five-hue identity palette, as token references. |
| `client/src/hooks/useTheme.ts` | Sets `data-theme` and writes **only** the accent preset inline. |
| `client/src/pages/DesignTokensPage.tsx` | `/design-tokens`, behind `import.meta.env.DEV`. |
| `client/e2e/design-review.spec.ts` | The screenshot gate (opt-in), for this and every later package. |

### The theming mechanism (read this before editing tokens)

A custom property is substituted **where it is declared**, and descendants
inherit the resolved value. So the Tailwind namespace is declared as an
indirection —

```css
@theme        { --color-bg-plate: var(--bg-plate); }   /* the utility reads this */
:root         { --bg-plate: #14171c; }                 /* Night */
[data-theme='light'] { --bg-plate: #fbf9f4; }          /* Daylight */
[data-theme]  { --color-bg-plate: var(--bg-plate); }   /* re-substitute per subtree */
```

The last line is load-bearing: without it a nested `<div data-theme="light">`
keeps painting Night surfaces, because `--color-bg-plate` was already resolved
at `:root`. It is what lets `/design-tokens` show four themes at once and what
makes any in-app theme preview show the real thing.

**Put literal values in `:root` and the theme blocks. Never in `@theme`.**

---

## 2. Tokens

### Added

- **Surfaces** — `--bg-base` `--bg-plate` `--bg-raised` `--bg-well`
  `--bg-floating` `--bg-mod-subtle` `--bg-mod-strong` `--window-dark`.
- **Light** — `--light-white` (talking/live), `--light-amber` (reading).
- **Text** — `--text-body-ink` (see the naming note below), `--text-faint`,
  `--text-on-light`.
- **Semantic** — `--danger-well` (a danger control is a well carrying danger
  ink, never a red fill).
- **Depth recipes** — `--shadow-plate` `--shadow-plate-phone` `--shadow-well`
  `--shadow-raised` `--shadow-lifted` `--shadow-composer` `--shadow-chip`
  `--shadow-tile` `--shadow-floating`.
- **Light recipes** — `--glow-window-white(-lg)` `--glow-window-amber(-lg)`
  `--glow-live-dot` `--glow-light-fill` `--glow-control-on` `--ring-lit`
  `--ring-speaking` `--ring-speaking-peak` `--ring-lit-plate` `--lamp-radial`
  `--dim-filter` `--tag-fill`.
- **Radii** — `--radius-plate` `--radius-card` `--radius-well`
  `--radius-control` `--radius-chip` `--radius-stage-control` `--radius-window`
  (+ `-phone` variants).
- **Sizes** — `--h-nav-row` `--h-list-row` `--h-control(-sm|-phone)`
  `--h-composer(-ribbon|-phone)` `--h-stage-control(-phone)` `--h-chip(-sm)`
  `--h-search-well` `--w-buildings-column` `--w-chat-ribbon` `--gutter`.
- **Type steps** — `--text-name`, `--text-ribbon` (plus the re-tuned
  display/title/heading/body/label/meta/section).
- **Motion** — `--duration-warm-up` `--duration-dim` `--duration-breathe`
  `--ease-in`.
- **Identity** — `--color-avatar-1…5`, fixed across themes.

### Removed (and every consumer with them)

| Removed | Replaced by |
|---|---|
| `--glass-rail-*`, `--glass-panel-*`, `--glass-modal-*` | the plate / well / floating recipes; the `.glass-*` **class names** survive as thin wrappers with no glass in them (renaming their call sites is WP8) |
| `--noise-texture` | nothing — the street is flat and matte |
| `--ambient-glow-primary/success/danger` | nothing — no glow without a source (§6.1) |
| `--panel-divider-glint` | `--border-subtle` |
| `--color-status-online/idle/dnd/offline/streaming` and `--status-*` | `presenceLight()` + the `pc-lit` / `pc-dim` / `pc-dnd` rim (§1.5) |
| `--app-bg-layer-one/two` | nothing |
| The Discord-blurple `GUILD_COLORS` palette | `getIdentityColor` over `--color-avatar-1…5` |

Also gone from the bundle: **Fraunces** and **Inter** (`@fontsource-variable/*`
uninstalled, every reference updated).

### Mapped (deprecated, kept so the un-restyled app still renders)

`--bg-primary → --bg-plate` · `--bg-secondary → --bg-raised` ·
`--bg-tertiary → --bg-base` · `--bg-accent → --bg-raised` ·
`--bg-canvas/--bg-dock → --bg-base` · `--bg-panel/--bg-chat → --bg-plate` ·
`--app-bg-base → --bg-base` · `--accent-secondary → --accent-primary` (the teal
is gone; there is one action colour) · `--accent-danger-fill → --danger-well` ·
`--shadow-sm → --shadow-chip` · `--shadow-md → --shadow-lifted` ·
`--shadow-lg/xl → --shadow-plate` · `--radius-xs/sm/md/lg` onto the v2 steps ·
`--text-subhead → --text-heading` · `--ease-spring → --ease-out` (light never
bounces).

### One naming collision, documented

Tailwind's **body type step** owns the name `--text-body` (a font-size), so the
body *ink* cannot share it. It is `--color-text-body` (utility: `text-text-body`)
and `--text-body-ink` for raw styles. Every other ramp step keeps its spec name.

---

## 3. Type

`@fontsource/gabarito` (500/600/700) + `@fontsource-variable/onest` installed;
JetBrains Mono kept. `--font-display` / `--font-primary` / `--font-code` wired,
`pc-display` and `pc-mono` carry the faces. Tabular numerals are on globally.

Steps (§2) generate `text-display|title|heading|name|body|ribbon|label|meta|section`.

---

## 4. Primitive API

All in `client/src/components/ui/`, exported from `index.ts`. No business logic,
no product copy, no literal colour (a test asserts the last one).

| Primitive | Props |
|---|---|
| `Plate` | `as`, `lit`, `bare` |
| `Lamp` | `width`, `height` — the one permitted radial, for a lit card |
| `Well` | `as`, `bare` |
| `Raised` | `as`, `lifted`, `bare` |
| `Button` | `variant`: `primary \| light \| ghost \| danger` (+ legacy `default/destructive/secondary/outline/link`); `size`: `sm`(28) `md`(32) `lg`(44) `icon` `icon-lg`; `loading` |
| `IconButton` | `label` (**required**), `size`: `sm \| md \| lg \| stage`(46), `tone`: `ghost \| raised \| light \| danger`, `active` |
| `Chip` | `size`: `sm \| md`, `tone`: `neutral \| accent \| talking \| reading \| danger`, `as` |
| `NavRow` | `icon`, `trailing`, `active`, `display`, `href` |
| `SectionLabel` | `meta` — sentence case, never uppercase |
| `Kbd` | — |
| `TextField` | `label` (**required**), `hideLabel`, `hint`, `error`, `icon`, `trailing` |
| `SearchWell` | `label`, `icon`, `shortcut` |
| `Divider` | `orientation`, `strong`, `label` |
| `Popover` | `anchor`, `open`, `onClose`, `side`, `align`, `label`, `role` |
| `MenuItem` / `MenuLabel` | `icon`, `trailing`, `danger` |
| `Tooltip` | existing component, restyled onto the floating recipe |

`light` is the only variant that spends a light token, and it asserts that
somebody is in the room. It is never emphasis.

---

## 5. Two real bugs found and fixed on the way

1. **`cn()` was silently dropping every custom type step.** tailwind-merge cannot
   tell `text-meta` (a font-size) from `text-text-muted` (a colour), so it
   treated them as one group: `cn('text-meta text-text-muted')` returned just
   `text-text-muted`. Every composed component in the app was losing its type
   step. Fixed by declaring the step scale in `client/src/lib/utils.ts`.
2. **An unlayered element reset outranked every Tailwind utility.**
   `button, input, select, textarea { font: inherit; color: inherit }` sat
   outside `@layer base`, and unlayered author styles beat layered ones
   regardless of specificity — so `text-label` and `text-text-on-accent` never
   applied to a button, and the primary button's ink was inherited from `<body>`.
   Moved into `@layer base`.
   *(Related: `html, body, #root { font-size: var(--text-body) }` would have
   rescaled the rem basis to 15px, shrinking every rem-valued token by 6.25%.
   The font-size now lives on `body` only; `html` stays at 16px.)*

## 6. Two factual corrections to the spec

Both are places where a literal value in §1 could not satisfy §9, which is
marked non-negotiable. `docs/lantern-stage-spec.md` is annotated at each.

| Token | Was | Now | Why |
|---|---|---|---|
| `--text-faint` (Night) | `#6C6E70` | `#838587` | 3.51:1 on `--bg-plate`; §9 requires meta ≥ 4.5:1. Smallest lift that clears 4.5:1 on all four Night grounds. |
| `--light-amber` (Daylight) | `#A8763C` | `#855E30` | 3.17:1 on `--bg-well`; amber is a label ("5 reading") as well as a fill. |

Daylight's `--accent-primary` is `#166E50` (and `useTheme` scales accent presets
by 0.52 on paper) so the emerald clears 4.5:1 as text on every Daylight ground.
Daylight's `--bg-raised` (`#F3EFE5`) is an interpolation: §1.7 gives base, plate
and well but not the raised step.

---

## 7. Verification

Run from `client/`. All green on the final tree:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **239 files, 2033 tests passed** (includes 39 new primitive tests) |
| `npm run build` | pass; `/design-tokens` absent from `dist/`, no Fraunces/Inter in the bundle |
| `npx playwright test` (mocked smoke) | **84 passed** |
| `npm run test:a11y:static` | pass |
| `npm run test:contrast` | **49 checks × 4 themes passed** |

The contrast script was rewritten against the new tokens and **tightened**, not
weakened: it now checks every ramp step, every semantic and both lights against
all four grounds (`--bg-base/plate/raised/well`), plus ink-on-fill, in all four
themes, at §9's floors (body ≥ 7:1, meta ≥ 4.5:1, white-light ink ≥ 12:1).

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 npx playwright test        # → output/design-reference/wp0/ (gitignored)
PARACORD_E2E_DESIGN_WP=wp1 PARACORD_E2E_DESIGN=1 npx playwright test   # later packages
```

`client/e2e/design-review.spec.ts` is mocked exactly like the smoke and is gated
out of the default run. It captures Home, a channel, a DM, Settings and
`/design-tokens` at **1440×900 and 390×844**, plus the theme-comparison and
primitive frames. All twelve were inspected; nothing clipped, no missing gutters,
no unreadable pairing.

---

## 8. Left for later packages

- **WP1** — the light components (`WindowMap`, `BuildingPlate`, `LitAvatar`,
  `HereNowStrip`, `RoomThumbnail`, `StageTile`, `OnAirPill`). The recipes they
  need (`pc-window`, `pc-lamp`, `pc-lit`, `pc-speaking`, `pc-live-dot`,
  `pc-tag`, the warm-up/dim/breathe durations) are already in place, and
  `presenceLight()` is the selector they should build on.
- **WP2–WP7** — the deprecated aliases exist only to keep those surfaces
  rendering. New code uses the v2 names.
- **WP8 sweep**
  - Rename the `.glass-rail/.glass-panel/.glass-modal` classes (no glass left in
    them) and their ~6 call sites.
  - `data-testid="presence-dot"` in `ConversationRow` now labels an `sr-only`
    status span; rename it with its test.
  - ~40 avatar fallbacks still paint `bg-accent-primary`. The two most visible
    (the DM header and the account panel) now use `getIdentityColor`; the rest
    should follow — the emerald means "an action you can take", and a person is
    not an action.
  - ~30 badge-sized `uppercase` labels remain (Active, Available now, encryption
    tags). The 171 `text-section uppercase` *section* labels are already gone.
  - Point `docs/design-spec.md` at this file.
- **Screenshot fidelity** — a guild channel's timeline still renders skeletons
  in `design-review.spec.ts` (the DM timeline renders fully). It is mock
  fidelity in the spec, not a product bug; WP5 will want to finish it.
