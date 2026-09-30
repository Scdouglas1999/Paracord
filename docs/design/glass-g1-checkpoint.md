# WP-G1 checkpoint: retire the looks

Contract: `docs/glass-spec.md` §1, §4, §9. Plan: `docs/design/glass-plan.md` §2 (looks), §4 row G1,
§8 (owner decisions: looks retired; High contrast, Reduced transparency, Reduced motion and Custom
CSS stay as settings; one danger color). Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

## What changed

Glass is the only look. There are two theme ids: `glass` (default) and `glass-contrast` (High
contrast). Night as a separate theme, Daylight, AMOLED, Dusk sky, Paper & ink, Slate and Aubergine
are gone, and so are the accent presets, the base hue and tint controls, and the rows/bubbles switch.

### Files in scope

| File | Change |
|---|---|
| `client/src/lib/themes.ts` | `THEME_IDS = ['glass', 'glass-contrast']`, `DEFAULT_THEME = 'glass'`, `HIGH_CONTRAST_THEME`. New `migrateThemeId()` (retired id to a current one, `null` for a non-theme) and `asThemeId()` built on it. New `TransparencyPreference` (`system`, `standard`, `reduced`). `LIGHT_THEMES`, `LOOK_THEMES`, `MessageStyle`, `messageStyleFor` deleted. |
| `client/src/hooks/useTheme.ts` | Writes `data-theme` and `data-reduced-transparency` (always `'true'`/`'false'`; `system` follows `(prefers-reduced-transparency: reduce)` and keeps following it). `ACCENT_PRESETS`, `BASE_HUE_PRESETS`, the accent maths, `--ui-hue`/`--ui-chroma`, `data-message-style` and the inline `color-scheme` write are gone: the hook writes no color. Server hydration goes through `migrateThemeId`. |
| `client/src/stores/uiStore.ts` | `accentPreset`, `baseHue`, `baseTint` and their setters removed. `transparency` + `setTransparency` added (per device, persisted). `persist` is now `version: 1` with `migrate` and `merge` (below). |
| `client/src/styles/tokens.css` | Look blocks deleted (Daylight, AMOLED, Dusk, Slate, Aubergine, Paper and its spine, and every `paper`/`light` override of sports, status and word-tile tokens). `--ui-hue`, `--ui-chroma`, `--ui-hue-street`, `--sky`, `--street-scrim`, `--plate-fill`, `--grain`, `--bubble-mix` and `--bubble-own-mix` removed (nothing else reads them). New High contrast block `[data-theme='glass-contrast']`. One danger ink (below). The Glass block from G0 is unchanged except that its selectors also list the two theme attributes. |
| `client/src/styles/looks.css` | Deleted (the bubble layout and Dusk/Paper structure). |
| `client/src/components/customization/ThemeSelector.tsx` | Rewritten: High contrast switch, Transparency (3 choices), Motion (3 choices). Uses the shared `ToggleRow` and `ChoiceCards`. No theme cards, accent swatches or base color. |
| `client/src/components/user/UserSettings.tsx` | Appearance header copy and one comment. Density, language and Custom CSS are untouched. |
| `client/scripts/contrast-audit.mjs` | Rewritten for the two themes (below). |
| `crates/paracord-api/src/routes/users.rs` | `DEFAULT_THEME = "glass"`; doc comment on how old ids are handled; a unit test. |
| Tests | `themes.test.ts`, `uiStore.test.ts`, `useTheme.test.ts`, `ThemeSelector.test.tsx` rewritten; `crates/paracord-api/tests/contract_wire_shapes.rs` gets one new test. |

### Files outside the list that I had to touch

- `client/src/styles/globals.css`: removed `@import './looks.css'` (deleting the file breaks the
  CSS build otherwise). The WP-G7 agent put `glass-layout.css` in the same slot in the meantime, so
  the current diff shows both; there is no conflict.
- `client/src/pages/DesignTokensPage.tsx` (dev page): its "change the lights" toggle compared the
  store theme with `'light'`/`'dark'` and its Themes section listed the eight old ids, so
  `npm run typecheck` failed without it. Now it toggles `glass` and `glass-contrast`, and the Themes
  section shows those two side by side. About 12 lines. `e2e/motion-gate.spec.ts` drives that
  toggle and only needs `data-theme` to change; I did not run the motion gate.
- `client/e2e/smoke.spec.ts`: it loops `THEME_IDS` (adapts by itself), asserted `'dark'` as the
  default, and typed `serverTheme` as `ThemeId`. Now `'glass'`, `serverTheme: string`, and it also
  asserts a server value of `paper` opens `glass` and `high-contrast` opens `glass-contrast`.

## Migration

Nothing throws and nothing is refused. There are three places an old value can arrive.

1. **This device, `localStorage['ui-storage']`.** The store had no `version`, so persisted blobs are
   `version: 0`. It is now `version: 1`. `migrate` runs for any older version, and `merge` runs on
   every load (which also covers a blob with no version number, which zustand does not migrate).
   Both call one function:
   - `theme`: `high-contrast` becomes `glass-contrast`; every other retired id (`dark`, `light`,
     `amoled`, `dusk`, `paper`, `slate`, `voices`) becomes `glass`; a value that is not a string or
     not a known id becomes `glass`.
   - `accentPreset`, `baseHue`, `baseTint` are dropped, so zustand's shallow merge does not carry
     them into the live store.
   - `transparency`, if present, is narrowed to one of the three values (else `system`).
   - Everything else (`motion`, `customCss`, sidebar width and collapse, low bandwidth) is kept as it
     was. A field that is not there keeps its default.
   The next write to storage is at version 1 without the retired fields.
2. **The server's `user_settings.theme`.** It is an opaque string; the API checks only its length
   (`MAX_SETTINGS_THEME_LEN = 32`). It is not validated against a list, so stored `slate`, `paper`,
   `dark`, `high-contrast`, ... still round-trip, and PATCHing anything else never touches the theme.
   There is no 400 for an existing user: the only refusal is a value over 32 characters, and both new
   ids fit. `contract_wire_shapes::user_settings_theme_default_is_glass_and_old_ids_still_round_trip`
   proves it for all ten ids (set, unrelated PATCH keeps it, GET returns it) and pins the default.
   The client maps the string on read: `useTheme` (first sign-in hydration) and `UserSettings` both use
   `migrateThemeId`/`asThemeId`. A value that is not a theme at all (`chartreuse-mist`) still leaves the
   local choice alone, as before.
3. **`DEFAULT_THEME`.** The server now says `glass` for an account with no settings row, the client says
   `glass`, and `client/src/lib/themes.ts` and `users.rs` name each other in comments.

Not done, on purpose: no SQL migration rewrites the old strings (the earlier
`20260923000301_default_theme_slate.sql` did that once; a rewrite is not needed because the client maps
on read and the server does not care), and the client does not PATCH the migrated theme back by itself.
An account converges the next time it saves any appearance setting, because `UserSettings` sends its
migrated `theme`. If you want the rows normalized, a one-line migration in both engines is the way; it
is outside this package's file list.

Checked live (Playwright, mocked scene, not just unit tests): a `ui-storage` blob at version 0 with
`theme` of `slate`, `paper`, `dark`, `voices` or `high-contrast` plus `accentPreset: 'rose'`,
`baseHue: 200`, `baseTint: 0.4`, together with a server that returns the same id, opens with
`data-theme="glass"` (or `glass-contrast`), no page error, and a rewritten blob at `version: 1`
without the three retired fields.

## Settings › Appearance

`Contrast` (High contrast switch), `Transparency` (Match my system, Standard, Reduced), `Motion`
(Match my system, Full motion, Reduced motion), then the existing Display (density, language) and
Custom CSS sections and the existing Save button. Copy is plain American English, with no "room" or
"building" (`vocabulary.test.ts` rejects them in page copy).

- **High contrast** sets the theme `glass-contrast` and turns it back to `glass`. It goes through
  `changeLights` like the theme cards did, and it is saved to the account immediately (the existing
  `handleThemeChange` path), as before.
- **Reduced transparency** is per device. I made it three choices, not a switch, because a switch
  cannot say "follow the device", and `primitives.css` already follows
  `prefers-reduced-transparency` for floating surfaces; a plain switch would let the two disagree. The
  result is on the root as `data-reduced-transparency="true"|"false"`, and `glass.css` turns it into
  opaque `--solid` panes (verified: pane background goes from alpha .94 to opaque). If you would rather
  have a switch, it is a small change to `ThemeSelector.tsx` and `useTheme.ts`.
- **Reduced motion** is the existing three-way control, unchanged in behavior; the copy no longer talks
  about "lights bloom" and "channels move".

## High contrast, re-derived for Glass

Same layout and names as Glass; only values change (`tokens.css`, `[data-theme='glass-contrast']`):
opaque panes and stage column; black street and wells; the room's tint is not mixed into the surfaces
(so the floor never depends on what is live); two ink steps (`#ffffff`, then `#e6e9e9` for both
secondary and tertiary); a lifted selection step; a visible 1px edge on every surface through the shadow
and glass-edge tokens (so anything that reads them gets it without a rule); a 3px pure white focus ring;
lit rings and glows at 1.5x. Amber still means live and Join is still the one filled button. There is no
reference render for this, so the values are mine and worth a look from the owner.

The block also applies inside a `.glass-room` subtree (`[data-theme='glass-contrast'] .glass-room`),
because that class re-declares the inputs HC overrides. Without it, HC on the root left a `.glass-room`
pane translucent (I saw it on `/design-tokens`). The Glass and HC blocks now list both theme attributes,
so a nested theme preview is complete whatever theme the page is in.

## One danger ink

`--accent-danger` (`#f07c7c`) is declared exactly once, in the shared block. `--danger-well`,
`--danger-well-hover` and `--danger-tint` are `color-mix()` of it (12%, 18% and 14% at rest;
High contrast raises only the tint to 22%), and `--text-on-danger` is an alias. High contrast no longer
has its own `#ff8f8f`. The audit fails if a second `--accent-danger` appears or if any of the three is
written as its own color. Presence colors are untouched. Two visible consequences: the danger well is a
little less saturated than the old `#2a1517` (now about `rgb(46,33,33)` on Glass), and High contrast's
danger text is `#f07c7c` instead of `#ff8f8f`. Warning and info accents are unchanged (plan §7 decision
5 is about danger only), and High contrast keeps its brighter warning and info.

## Contrast audit

`node scripts/contrast-audit.mjs` (`npm run test:contrast`) now resolves the real tokens for both
themes over 114 room tints (the two reference tints, dim warm, bright cool, white and black extremes,
and a hue x saturation x brightness grid) and requires:

- the Glass ink set on every Glass surface (7:1 for `--ink-1`, 4.5:1 for the rest; panes over the
  brightest backdrop the room can draw);
- the Lantern-named tokens the untouched screens still read (`--text-*` on `--bg-*`, semantic accents,
  identity inks, sports and pitch inks, danger ink on both danger wells), at every tint;
- for High contrast: opaque `--pane` and `--deep`, 12:1 for `--ink-1`, 7:1 for the other two inks,
  and 3:1 for `--glass-hair`, `--border-subtle` and `--border-strong`;
- one danger ink (above);
- the two reference tints in spec §2.1 still reproduced by the default theme (worst delta-E 1.50).

The hue x tint sweep, the Lantern per-theme sweeps, Paper's spine checks, the bubble checks and the
painted-backdrop handling are gone with the things they measured. Result: 40,242 comparisons pass;
tightest margin is `--ink-1` on `--sel` in High contrast at 12.14 against a floor of 12. I checked
that the audit can fail: making `--pane` translucent in HC and adding a second `--accent-danger` each
fail it, and my first HC selection color did too (11.98 against 12), so it was lowered.

## Verification

| Command | Result |
|---|---|
| `cd client && npm run typecheck` | pass |
| `npm run test:unit` | pass: 353 files, 3,320 tests. Earlier in the session `DailyWordView.test.tsx` hung, so I ran with `--exclude '**/DailyWordView.test.tsx'` (352 files, 3,314 tests, pass). Another agent has since changed that file in the working tree and it now passes (6 tests), so the unexcluded run finishes |
| `npm run test:tokens` | pass (714 files, no literal colors outside the allowlist) |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors, 241 warnings (the same count as G0; none in my files' new code) |
| `npm run test:contrast` | pass, numbers above |
| `npx playwright test e2e/smoke.spec.ts --project=chromium` | **fails at line 685** (composer "Message tools" menu bottom edge at 390 px). My theme loop (lines 488-520) ran before it and passed. That assertion is about the message-tools menu in the phone viewport, which other agents' WP-G7 shell work is changing; I did not confirm it also fails on a clean HEAD |
| Temporary Playwright specs on the G2 harness (deleted afterwards) | pass: Appearance at 1440x900 and 390x844; High contrast toggle sets `glass-contrast`, PATCHes `glass-contrast` then `glass`; Reduced makes `data-reduced-transparency="true"`; five stored-old-id starts (above) |
| Rust, shared tree | **could not build**: another agent's in-progress voice work leaves `paracord-api` at 34 compile errors (`drain_watch_dirty`, `listen_in_enabled`, ...) |
| Rust, isolated `git worktree` of `HEAD` plus only my two Rust files (built with `CARGO_TARGET_DIR` at the glass `target/`; worktree removed) | `cargo test -p paracord-api --test contract_wire_shapes`: 7 passed. `cargo test -p paracord-api --lib routes::users`: 8 passed. `cargo fmt --all -- --check`: clean. `cargo clippy -p paracord-api --all-targets -- -D warnings`: clean |

## Screenshots (`output/design-reference/glass-build/g1/`)

- `appearance-desktop.png`, `appearance-desktop-lower.png` (Display and Custom CSS), `appearance-phone.png`:
  Settings › Appearance in Glass at 1440x900 and 390x844. Read them: headings, the switch, both
  three-card groups, the Selected marks and the helper lines are all there, nothing clipped. In the
  cards "Match my system" wraps to two lines beside "Selected" at desktop width.
- `appearance-high-contrast-desktop.png`: High contrast on. Edges are visible on the dialog, rows, cards
  and the switch; panels are opaque. (This shot predates a copy tweak to the transparency helper line.)
- `appearance-reduced-transparency-desktop.png`: "Reduced" selected (same note).
- `conversation-glass-desktop.png`, `conversation-high-contrast-desktop.png`: the current shell (with
  WP-G7's frame) in both themes. High contrast shows hairlines on panes, rows, wells, chips and the
  composer.
- `design-tokens-themes.png`, `design-tokens-themes-hc-root.png`: the dev page's Themes section, and the
  same with High contrast on the root (the Glass preview stays Glass).

## Things you should know

- **Messages are rows until WP-G10.** The bubble layout lived in `looks.css` (Slate was the default
  look), and the plan replaces it, so the conversation is now the flat row layout. `MessageList` still
  writes `--who`, `data-own`, `data-grouped` and the rest; nothing reads them yet.
- **Left for whoever owns these files** (I did not touch them):
  - `client/src/components/dailyWord/model.ts:135` compares the theme with `'high-contrast'`, which no
    longer exists. Players on High contrast lose the default color-blind palette until it says
    `'glass-contrast'`. Its test `model.test.ts:100-103` needs the same one-word change. This is the one
    silent behavior regression I know of.
  - `client/src/styles/primitives.css:95`: the High contrast border on `.pc-plate`, `.pc-floating`,
    `.pc-dialog`, `.pc-coach` is keyed on `[data-theme='high-contrast']` and never matches. Glass
    primitives get their edges from tokens; the old `pc-*` plates lose the 1px border. Change the
    selector to `glass-contrast`.
  - `client/src/styles/layout.css:9-23`: `color-scheme` rules for `light`, `amoled` and `high-contrast`
    are dead (`tokens.css` sets `color-scheme: dark` on both themes).
  - `client/index.html:2` still says `data-theme="slate" data-message-style="bubbles"`. Harmless (no block
    matches `slate`, `:root` is Glass, and `useTheme` sets `glass` on mount) but stale.
  - `client/scripts/literal-color-audit.mjs:35-38` still allows literal colors in `hooks/useTheme.ts`
    for `ACCENT_PRESETS`; the file has none now, so the entry only hides a future mistake.
  - Comments only: `client/src/types/user.types.ts:27-28` (old id list), `primitives.css:1288` and
    `MessageList.tsx:2798` (mention `looks.css`), `lib/nativeGround.ts:16,140` and
    `lib/room/fixtureFrameSource.ts:59` (mention `--ui-hue`), `DesignTokensPage.tsx:112,1673` ("all four
    themes", "Night ground").
  - The G2 harness (`e2e/fixtures/glass/install.ts:306`) returns `theme: 'dark'` for the account (a good
    legacy-id exercise) but has no `PATCH /users/@me/settings` handler, so changing a setting there shows
    "Could not save theme" and rolls back. Later settings screenshots will want a handler.
- **Unsure:** whether the owner wants three choices for transparency; whether High contrast dropping the
  room tint is right (it is my call, for a guaranteed floor); the danger well being a mix rather than the
  old fixed maroon; and the 12:1 floor for High contrast, which I chose (WCAG AAA is 7:1).
- Small typographic observation, not mine to fix: in the 1x headless screenshots, 12-13px text in
  Instrument Sans shows tight word gaps ("panels anda clear outline"). It is not `tnum` (measured: the
  same width with and without it). Worth a look in the type work.
