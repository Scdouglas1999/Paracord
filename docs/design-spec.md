# Paracord Design Language — "Emerald Commons"

> **This file is the contract.** Every component built or refreshed in the v1.0
> overhaul is graded against it. When a recipe here and a component disagree, the
> component is wrong. Tokens are defined in `client/src/styles/tokens.css` and
> re-applied at runtime by `client/src/hooks/useTheme.ts`; **consume tokens, never
> hard-code hex.**

Direction: **Expressive & Social, but MATURE.** Warm, alive, community-feeling —
never childish, never corporate-sterile. Personality comes from craft: warm-neutral
dark surfaces, a single calibrated emerald spent only on meaning, real elevation,
a display face on headings, and restrained motion. The polish of Discord's real
product, Figma, and Linear-with-warmth.

---

## 1. Color

### 1.1 Surfaces — warm-neutral dark, a whisper of green (dark theme, the default)

A real elevation ramp, not one flat charcoal. Lower index = deeper.

| Token | Hex | Elevation / use |
|---|---|---|
| `--bg-tertiary` | `#0D1211` | Deepest. App base, guild rail gutter, insets behind panels. |
| `--bg-primary` | `#141B17` | Main canvas — chat/message area, page body. |
| `--bg-secondary` | `#1B241F` | Raised panels — channel sidebar, member list, headers. |
| `--bg-accent` | `#222D27` | Most-elevated fill — hover cards, popover/menu bodies, modal surface. |
| `--bg-floating` | `rgba(27,36,31,.97)` | Floating surfaces (context menu, tooltip) over content. |
| `--bg-mod-subtle` | `rgba(255,255,255,.04)` | Hover wash on rows/controls. |
| `--bg-mod-strong` | `rgba(255,255,255,.10)` | Pressed / selected wash. |

Depth is delivered by **shadow + a 1px inset top highlight** (§4), not by borders alone.
Never stack radial ambient glows or grain over surfaces (see kill-list #1/#2).

### 1.2 Accent — emerald primary, teal secondary

The accent is a **solid, calibrated meaning-color**. Spend it only on: primary
actions, active navigation, @mentions, online presence, links, and focus rings.
Never a gradient wash across surfaces or buttons.

| Token | Hex | Use |
|---|---|---|
| `--accent-primary` | `#24D196` | Primary buttons, active nav icon, mention accent, focus, links. |
| `--accent-primary-hover` | `#33DBA2` | Primary hover. |
| `--accent-primary-active` | `#1FBE88` | Primary pressed. |
| `--accent-secondary` (teal) | `#1CC3C0` | Secondary/brand tint: active-nav left bar, presence ring, app mark. Rationed — two brand moments, never a fill wash. |
| `--accent-tint` | `rgba(36,209,150,.12)` | Subtle emerald background: active nav item, selected chip. |
| `--accent-tint-strong` | `rgba(36,209,150,.18)` | Stronger emerald wash (hovered-active). |
| `--teal-tint` | `rgba(28,195,192,.12)` | Teal background wash (rare — brand callouts). |

Text/icons on an emerald fill use `--text-on-accent` = **`#04140D`** (near-black ink,
~9.4:1 AAA on emerald). The freshest button is also the most accessible.

### 1.3 Semantic — a full set, distinct from the accent

Do **not** reuse emerald for success. Each state is its own hue.

| Token | Hex | Use |
|---|---|---|
| `--accent-success` | `#4BC46B` | Success text, icons, confirmations. |
| `--accent-warning` | `#E8B23A` | Warnings, caution. |
| `--accent-danger` | `#E5484D` | Danger text/icon/border on dark; destructive labels. |
| `--accent-danger-fill` | `#C93A44` | Danger **button background** (paired with white text, AA). |
| `--accent-info` | `#4F97F0` | Informational callouts. |
| `--text-on-danger` | `#FFFFFF` | Foreground on `--accent-danger-fill`. |
| `--success-tint` / `--warning-tint` / `--danger-tint` / `--info-tint` | `rgba(…,.14)` | Callout/badge backgrounds for each state. |

### 1.4 Text ramp

| Token | Hex | Use |
|---|---|---|
| `--text-primary` | `#EAF2ED` | Headings, author names, message body. |
| `--text-secondary` | `#A7B8AF` | Supporting copy, secondary labels. |
| `--text-muted` | `#7A8B82` | Timestamps, meta, placeholders, empty-state icon. |
| `--text-link` | `#24D196` | Links / mentions (deepened automatically on the light theme for AA). |
| `--text-on-accent` | `#04140D` | On emerald / light accent fills. |

Interactive icon states: `--interactive-normal` `#A7B8AF` → `--interactive-hover`
`#EAF2ED` → `--interactive-active` `#FFFFFF`; `--interactive-muted` `#55645C` for
disabled. `--channel-icon` `#7A8B82`.

### 1.5 Presence

`--status-online` `#24D196` (emerald) · `--status-idle` `#E8B23A` ·
`--status-dnd` `#E5484D` · `--status-offline` `#5C6B63` · `--status-streaming` `#9B7BFF`.
Presence ring uses the teal→emerald duotone (`--accent-secondary` → `--accent-primary`).

### 1.6 Borders

`--border-subtle` `rgba(160,185,170,.12)` (warm-green hairline, default divider) ·
`--border-strong` `rgba(160,185,170,.22)` (emphasis / focused container edge).
Borders are hairlines; they never substitute for the elevation ramp.

### 1.7 Themes & accent presets

Four themes ship: **dark** (default), **light** (warm paper, green undertone),
**amoled** (true black), **high-contrast** (WCAG-forward). Every semantic token is
redefined per theme in `tokens.css` and in `useTheme.ts` — keep the two in lockstep.

The accent is user-swappable via `ACCENT_PRESETS` (default **emerald**). The chosen
preset drives `--accent-primary`/`-hover`/`-active`, `--text-link`, and
`--accent-primary-rgb` at runtime. `--accent-secondary` (teal) is brand-fixed.

---

## 2. Type

Two faces, no more. Character comes from optical treatment, not a font zoo.

- **Display face — `--font-display`: `'Fraunces Variable'`** (self-hosted via
  `@fontsource-variable/fraunces`, CSP-safe). Use **only** on Display / Title /
  Heading steps. Warm and characterful without going childish.
- **Body/UI — `--font-primary`: `'Inter Variable'`.** Everything else.
- **Code/timestamps — `--font-code`: `'JetBrains Mono'`.** Inline code, code blocks,
  timestamps.

Global font features: `'tnum'` (tabular figures — aligned timestamps/counts),
`'cv03'`, `'cv04'` (Inter open-4 / single-story-a). Base body weight is **440**
(`--font-weight-body`) for dark-mode legibility, not 400.

### Type scale (tokens generate `text-{step}` utilities carrying weight/tracking/leading)

| Step | Token | Size | Weight | Tracking | Leading | Face | Use |
|---|---|---|---|---|---|---|---|
| Display | `--text-display` | 32px | 800 | −0.03em | 1.1 | Fraunces | Page/onboarding hero titles. |
| Title | `--text-title` | 24px | 700 | −0.02em | 1.15 | Fraunces | Modal titles, section leads. |
| Heading | `--text-heading` | 20px | 700 | −0.015em | 1.2 | Fraunces | Panel/settings headings. |
| Subhead | `--text-subhead` | 18px | 600 | −0.01em | 1.3 | Inter | Sub-section headers, empty-state titles. |
| Body | `--text-body` | 15px | 440 | 0 | 1.5 | Inter | Chat, DMs, prose. |
| Label | `--text-label` | 14px | 500 | 0 | 1.4 | Inter | Buttons, form labels, nav items. |
| Meta | `--text-meta` | 12px | 500 | +0.01em | 1.4 | Inter/Mono | Timestamps, counts, captions. |
| Section | `--text-section` | 12px | 600 | +0.06em | 1.3 | Inter | UPPERCASE category/section labels. |

Never ship a screen where everything is the same size and weight (kill-list #8).
Reserve weight 800 for Display only.

---

## 3. Spacing, Radii

**Spacing** — 4px grid, `--space-1`…`--space-12` (0.25rem × n). Match density to the
surface: chat is comfortable-but-dense; settings may breathe. Use intentional rhythm,
not identical padding everywhere (kill-list #12). Density modes scale via
`--density-space-*` (`data-density` = compact / default / comfortable).

**Radii** — a deliberate scale; pill only where it means something.

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4px | Chips, tags, badges, inline code, count pills. |
| `--radius-sm` | 8px | **All controls** — buttons, inputs, selects, nav items, menu rows. |
| `--radius-md` | 12px | Cards, panels, popovers. |
| `--radius-lg` | 16px | Modals, command palette. |
| `--radius-full` | pill | **Only** avatars, presence dots, toggle knobs, filter pills. |

Buttons are a crisp 8px — never over-rounded (kill-list #6).

---

## 4. Elevation & shadow

Every raised surface pairs a near-black shadow with a **1px inset top highlight**
(lit-from-above depth, not a border outline, not a glow).

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.04)` | Buttons, resting raised chips. |
| `--shadow-md` | `0 4px 14px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.05)` | Cards, popovers, message hover toolbar. |
| `--shadow-lg` | `0 18px 44px rgba(0,0,0,.50), inset 0 1px 0 rgba(255,255,255,.06)` | Context menus, dropdowns. |
| `--shadow-xl` | `0 28px 64px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.06)` | Modals, palette. |

**Focus ring** (keyboard focus, always visible): `--focus-ring` =
`0 0 0 2px var(--bg-primary), 0 0 0 4px rgba(36,209,150,.55)` — a surface gap then an
emerald halo. Inputs use `--focus-ring-input` = `0 0 0 3px rgba(36,209,150,.25)` plus an
emerald border. No soft uniform drop-glow under buttons (kill-list #9).

---

## 5. Motion

Tokens: `--duration-fast` 140ms · `--duration-normal` 180ms · `--duration-slow` 240ms.
Easing: `--ease-out` `cubic-bezier(.22,1,.36,1)` (default), `--ease-in-out`,
`--ease-spring` `cubic-bezier(.2,.9,.3,1.3)`.

- Hover / press: **140ms** ease-out. **Press = `scale(.97)`**, never a `translateY(-1px)` lift.
- Panel / menu enter: **180ms** ease-out (opacity + 4–8px rise).
- Modal enter: **240ms** ease-out (opacity + `scale(.96→1)` + `translateY(8→0)`).
- Spring (`--ease-spring`): **only** on discrete send / react / toggle (scale `1→1.08→1`).
  Never on hover, never on everything.
- `prefers-reduced-motion`: drop transforms, keep opacity fades.

---

## 6. Anti-AI-slop kill-list (enforceable — a reviewer rejects any instance)

1. **No full-bleed gradient hero banners.** Headers are solid raised surfaces with a
   `--border-subtle` divider — no diagonal gradient wash.
2. **Accent is never a gradient fill across surfaces/buttons.** Emerald is one solid
   calibrated color, only for meaning (actions, active, mentions, online, links, focus).
   The teal→emerald duotone is rationed to presence ring + app mark.
3. **No emoji as UI chrome.** Section headers, empty states, and buttons use lucide
   line icons (already in the tree), consistently sized (16–20px).
4. **No "icon-in-a-circle + one gray line" empty states.** Empty states are
   left-aligned: a small line-icon in a tinted well, a real title, 1–2 lines of
   specific warm copy, and a primary action (§7).
5. **Not everything is a card.** Group with `--border-subtle` dividers and varied
   density; never tile identical hairline boxes with identical padding/radius. Never
   nest a card inside a card.
6. **No over-rounded corners.** Use the 4/8/12/16 scale; pill only for avatars/dots/
   toggles/filter-pills. Buttons are 8px.
7. **No flat depthless charcoal.** Use the warm-green elevation ramp + inset top
   highlight for real depth, not one gray with borders.
8. **No flat type hierarchy.** Use the display/title/heading/subhead/body/label/meta/
   section steps with intentional weight and tracking.
9. **No pill-gradient buttons with soft uniform drop-shadow.** Buttons are solid,
   tactile, with real hover/active/`focus-visible` states and a layered focus ring.
10. **No marketing-page sparseness in the chat app.** Match density to the surface —
    chat comfortable-but-dense, settings can breathe.
11. **No placeholder microcopy** ("It's quiet.", "No data found."). Write specific,
    warm, human copy.
12. **No perfect-symmetry, identical-spacing rhythm.** Use the 4px scale with intent.

---

## 7. Component recipes

All values reference tokens. Sizes in px are the target render size.

### Button — primary
36px tall · pad `0 14px` · `--radius-sm` (8px) · bg `--accent-primary` · text
`--text-on-accent`, `--text-label` (14px) / 600 · `--shadow-sm`. Hover: bg
`--accent-primary-hover`. Active: bg `--accent-primary-active`, `scale(.97)`.
`focus-visible`: `--focus-ring`. No gradient, no border, no glow.

### Button — ghost / secondary
Transparent · text `--text-secondary` · `--radius-sm`. Hover: bg `--bg-mod-subtle`,
text `--text-primary`. Optional 1px `--border-subtle` for a secondary outline variant.

### Button — danger
Fill `--accent-danger-fill` (`#C93A44`) · text `--text-on-danger` (white) ·
`--radius-sm` · same metrics as primary. Hover: darken ~10%. Active: `scale(.97)`.

### Icon button
36px square (44px min touch target on coarse pointers) · `--radius-sm` · icon 18–20px
`--interactive-normal`. Hover: `--interactive-hover` on `--bg-mod-subtle`.

### Card / panel
bg `--bg-secondary` · 1px `--border-subtle` · `--radius-md` (12px) · pad `--space-5`
(20px) · `--shadow-sm`. Group sub-sections with 1px `--border-subtle` dividers —
never nested cards, never identical tiling.

### Modal / dialog
bg `--bg-accent` · `--radius-lg` (16px) · 1px `--border-strong` · `--shadow-xl` ·
backdrop `--overlay-backdrop`. Enter 240ms: `scale(.96→1)` + `translateY(8→0)` + fade.
Title = Title step (Fraunces 24/700); body = Body step; footer actions right-aligned.

### Popover / dropdown menu
bg `--bg-floating` · `--radius-md` · 1px `--border-subtle` · `--shadow-lg` · pad
`--space-1` block. Item: `--radius-sm`, pad `6px 10px`, text `--text-secondary`; hover
bg `--accent-tint` + text `--text-primary` (or full `--accent-primary` bg only for the
primary/confirm item). Danger item: text `--accent-danger`; hover bg `--accent-danger`
+ `--text-on-danger`.

### Nav item (channel / settings / DM)
34px · `--radius-sm` · pad `0 8px` · text `--text-secondary` (15px) · icon 18px
`--channel-icon`. Hover: bg `--bg-mod-subtle`, text `--text-primary`.
**Active:** bg `--accent-tint`, text `--text-primary`, **3px left bar `--accent-secondary`
(teal)**, icon `--accent-primary`. Never a full emerald fill. Unread: 8px `--accent-primary` dot.

### Message row
pad `2px 16px 2px 72px` (grouped) · hover bg `--bg-mod-subtle`. Author `--text-primary`
15/600; timestamp `--text-meta` mono `--text-muted`; body Body step `--text-primary`.
**@mention line:** bg `--accent-tint` + 2px left border `--accent-primary`; inline
mention chip: `--accent-tint`, `--radius-xs`, text `--accent-primary`. Hover toolbar:
top-right, bg `--bg-accent`, `--radius-sm`, `--shadow-md`; reveal on hover **and**
`focus-within`.

### List item (member / friend / generic row)
Flex row, gap `--space-2`/`--space-3` · pad `4px 8px` · `--radius-sm` · text
`--interactive-normal`. Hover: bg `--bg-mod-subtle`, text `--interactive-hover`.
Separate groups with dividers, not boxes.

### Input / select / textarea
40px · bg **inset/darker than surround** (`--bg-tertiary` or a mix toward it) · 1px
`--border-subtle` · `--radius-sm` · text Body step · placeholder `--text-muted`.
Focus: border `--accent-primary` + `--focus-ring-input`. No outer glow. Select uses a
tokenized chevron, appearance-none.

### Empty state
Left-aligned (never centered icon-in-circle). One 20px lucide **line** icon
`--text-muted` in a `--radius-sm` `--accent-tint` well → title Subhead (18/700), e.g.
_"#general is ready when you are"_ → 1–2 lines `--text-secondary` (14px) specific copy
→ one primary emerald button (_"Send the first message"_). Warm, human, actionable.

### Toast
bg `--bg-accent` · 1px `--border-subtle` · `--radius-md` · `--shadow-lg` · pad
`--space-3 --space-4`. Leading state icon in its semantic color (`--accent-success` /
`--accent-danger` / `--accent-info`), title `--text-label`, body `--text-meta`
`--text-secondary`. Enter: slide + fade `--duration-normal`.

### Badge / pill
`--radius-xs` (count/tag) or `--radius-full` (filter pill) · `--text-meta` 600 tnum ·
neutral bg `--bg-mod-strong` text `--text-secondary`; semantic variants use the
matching `*-tint` bg + solid semantic text (e.g. `--danger-tint` + `--accent-danger`).
Mention/unread count badge: `--accent-primary` bg + `--text-on-accent`.

### Avatar
`--radius-full` · sized 20/24/32/40px. Presence dot bottom-right, `--radius-full`, ring
in `--bg-secondary` (the surface behind), fill from `--status-*`. Live/streaming ring
uses the teal→emerald duotone.

### Guild icon (rail)
48px, idle `--radius-full`, hover/active morph to `--radius-md` (squircle) over 180ms
`--ease-out`. Active gets the teal pill indicator on the left edge.

---

## 8. Accessibility (non-negotiable)

- WCAG **AA** on all text (AAA where noted — dark ink on emerald is ~9.4:1).
- Every interactive element has a visible `focus-visible` ring (`--focus-ring`).
- Every hover-revealed action is also reachable on keyboard focus (`focus-within`).
- Consistent lucide iconography, consistent control sizing, 44px min touch targets on
  coarse pointers.
- Respect `prefers-reduced-motion` (opacity only, no transforms).

---

## 9. Token quick reference

Surfaces `--bg-{primary,secondary,tertiary,accent,floating}` · `--bg-mod-{subtle,strong}`
· Text `--text-{primary,secondary,muted,link,on-accent,on-danger}` · Interactive
`--interactive-{normal,hover,active,muted}` · `--channel-icon` · Accent
`--accent-{primary,primary-hover,primary-active,secondary}` · `--accent-{success,warning,
danger,danger-fill,info}` · Tints `--accent-tint(-strong)`, `--teal-tint`,
`--{success,warning,danger,info}-tint` · Presence `--status-{online,idle,dnd,offline,
streaming}` · Border `--border-{subtle,strong}` · Radii `--radius-{xs,sm,md,lg,full}` ·
Shadow `--shadow-{sm,md,lg,xl}` · Focus `--focus-ring(-color,-input)` · Spacing
`--space-1…12` · Type sizes `--text-{xs,sm,base,lg,xl,2xl}` + steps `--text-{display,
title,heading,subhead,body,label,meta,section}` · Weights `--font-weight-{normal,body,
medium,semibold,bold,display}` · Leading `--leading-{tight,snug,normal,relaxed,loose}` ·
Fonts `--font-{primary,display,code}` · Motion `--duration-{fast,normal,slow}`,
`--ease-{out,in-out,spring}`.
