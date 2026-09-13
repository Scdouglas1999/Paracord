# WP7 — Settings, dialogs, onboarding, setup

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) (§1–§4, §6, §9)
and the §10 work-package table. Depends on
[WP0](./wp0-checkpoint.md). Branch: `design/lantern-stage`.

This package restyles every surface a person reaches *around* the rooms —
settings, dialogs, the first screens of the app — onto the plate/well/raised
system. **No behaviour, route, store, API call or test intent changed.**

---

## 1. The shape of it

Three rules carry almost all of the work:

1. **Settings is one plate over the street** — a left index of sections in
   sentence case, the selected section's content beside it, one primary action
   per screen. That is now a primitive (`SettingsShell`), so user settings,
   space settings, the admin panel and the developer page are literally the
   same surface with different content.
2. **A dialog is a plate that floats** — `--bg-floating` + the plate shadow +
   the plate radius (`.pc-dialog`), no border, no blur. Every dialog in the app
   goes through one `Modal`, so restyling the shell restyled all of them.
3. **A field is a well** — recessed, inset shadow, no border, the §9 focus ring
   layered over that shadow. This landed in the `Input`/`Textarea`/`Select`
   primitives *and* in the two global classes (`.input-field`, `.select-field`)
   that the auth pages and half the settings forms still use, so it propagated
   without touching those call sites.

---

## 2. Primitives added to `client/src/components/ui/`

| Primitive | Why it exists | Props |
|---|---|---|
| `Switch` | Two hand-rolled switches existed (`guild/SettingsPrimitives`, inside `UserSettings`), both painting `bg-white` — a literal colour in a system that forbids them. | `checked`, `onChange`, `label` \| `labelledBy`, `size` (`sm`\|`md`), `disabled` |
| `ToggleRow` | The labelled-boolean row that both of those switches sat in. Names its switch from the row's own text, so the name a screen reader hears is the sentence a sighted reader reads. | `label`, `description`, `checked`, `onChange`, `disabled`, `ariaLabel`, `children` |
| `Tabs` | Five hand-rolled tab strips / segmented controls, each with its own selected-state recipe. | `items`, `value`, `onChange`, `label`, `variant` (`segmented`\|`underline`), `size`, `fill` |
| `SettingsShell` | The settings frame itself: index + content + close + Esc hint + the phone index/detail split. Presentation only and fully controlled, so each caller keeps its own section state, permission gates, Escape handling and history behaviour. | `label`, `title`, `groups`, `active`, `onSelect`, `onClose`, `closeLabel`, `indexFooter`, `isMobile`, `showIndex`, `onShowIndex`, `onKeyDown`, `contentClassName` |
| `SettingsSectionHeader` | The head of a section: Gabarito heading, one specific line, at most one primary action. | `title`, `description`, `action` |

**Design decisions worth recording**

- `Switch`'s off state is a **well**, not a grey pill: recessed like every other
  input. On is the **emerald**, never a light token — a light would assert that
  somebody is in a room (§0, §6.3). A test asserts exactly this.
- `Tabs` selects with a **raised** surface inside a well, the same way a
  selected row is raised anywhere else. Never an accent bar, never a tint.
  Arrow keys / Home / End move between tabs and only the selected tab is in the
  tab order (WAI-ARIA tabs pattern).
- No `Sheet` was added. Nothing in WP7's scope is a drawer today; the phone
  settings index/detail split is a two-screen flow, not a sheet, and the first
  real consumer of a bottom sheet is WP3's chat sheet. Adding an unused
  abstraction here would have been worse than not having one.

All five are exported from the `ui` barrel, which now also re-exports the
already-existing `Modal` family, `Input`/`Textarea`/`Select` and
`ErrorBanner`/`EmptyState`/`LoadingSpinner` so a consumer has one import site.
Every one of them is rendered on `/design-tokens` (§4 below), and the WP0
"no primitive hard-codes a colour" test now sweeps `Switch`, `ToggleRow` and
both `Tabs` variants too.

### Three new recipes and one new token

- `.pc-dialog` (all three live in `client/src/styles/primitives.css`) — the floating-plate recipe
  for a dialog, with the phone radius/shadow step and the
  `prefers-reduced-transparency` opaque fallback.
- `.pc-select` + `--select-chevron` — a `<select>` on the well recipe with the
  native arrow suppressed. The chevron is a data URI, which cannot read a custom
  property, so the literal lives in `tokens.css` (Night and Daylight each define
  their own muted ink) rather than in a component. This removed the last literal
  hex from `components/ui/`.
- `.pc-checkbox` — eleven checkboxes across the scope were each doing their own
  thing (one had no styling at all and rendered as the raw grey platform box).
  The native control is kept, so it keeps the platform's semantics and its
  forced-colors behaviour, and is tinted through `accent-color` with the §9 ring.

### One token change with a consequence worth naming

Night's literals are now declared for `:root` **and** for `[data-theme='dark']`,
`[data-theme='amoled']` and `[data-theme='high-contrast']` (the dark themes then
override their own subset, as before). Only Daylight previously declared a
complete set, so a *nested* `[data-theme]` subtree inherited whatever the
surrounding theme had left in the tokens it did not restate — which made the
theme picker's Night/AMOLED/High-contrast previews paint with Daylight ink while
the app was in Daylight. `:root` is deliberately last in that selector list so
the contrast audit's block parser still finds it.

---

## 3. Surfaces restyled

### Settings
- **User settings** (`components/user/UserSettings.tsx`) — the hand-rolled
  shell, mobile nav, close affordance and breadcrumb are gone, replaced by
  `SettingsShell`; the nav groups, every section id, the admin gate, the
  Escape/keybind-capture handling and the phone history behaviour are unchanged.
  The file's private `ToggleSwitch`, `ToggleRow` and `Segmented` now delegate to
  the shared `Switch`, `ToggleRow` and `Tabs`. Sections swept for raw type
  steps, border-as-depth (every `rounded-md border … bg-bg-tertiary` readout is
  now a well), over-rounding and the one uppercase badge.
- **Space settings** (`components/guild/**`) — the same `SettingsShell`;
  `SettingsPrimitives`' duplicate `Switch`/`ToggleRow` (which painted
  `bg-white`) now re-export the shared ones; every hand-rolled tab strip is
  `Tabs`; section headers, group labels and gate notices are on the
  heading/section/well recipes.
- **Admin** (`pages/AdminPage` + `pages/admin/**`) — was two bordered panels
  side by side, i.e. a plate beside a plate, with a hand-rolled nav carrying an
  accent bar. It is now one `SettingsShell` with a three-group sentence-case
  index; every tab id, the `isAdmin` gate and the route are unchanged, and
  Escape now does what the shell's Esc hint promises. Six identical stat cards
  became one hairline-parted spec sheet (§6.8 forbids identical-card tiling);
  each security finding carries its severity as a **word** beside the colour.
  Wide tables keep their own `overflow-x-auto` so the page never scrolls
  sideways on a phone.
- **Developer** (`pages/DeveloperPage` + `pages/developer/**` +
  `components/developer/**`) — was an unbounded scroll of bordered app cards;
  now a `SettingsShell` whose index is *New application* plus one row per app.
  `BotAppCard` stopped being a box inside the plate; `BotAdvancedTabs` is
  `Tabs variant="underline"`; the 19 intent tiles and 30 permission tiles became
  `ToggleRow` grids parted by hairlines. `CreateBotForm` lost its card for the
  same reason.

### Dialogs and modals
- `Modal` — the panel is `.pc-dialog`; the backdrop lost its blur; header/body/
  footer spacing moved onto the 4px grid; the close control onto the control
  tokens. Every dialog in the app inherits this.
- `ConfirmDialog` — `ghost` + `primary`/`danger` buttons; the danger glyph sits
  in a danger well.
- `ScreenSharePickerModal` — source cards are raised cards whose hover is depth
  (they were a tint + a 2px accent ring); each thumbnail is a well; the app
  glyph is a name tag; the filter strip is the tab recipe.
- `MessageEditHistoryDialog` — `.pc-dialog`, versions in the mono meta face,
  bodies wrap at `leading-relaxed`.
- `DmPickerModal` — the Direct/Group tabs and the selected-recipient row now use
  the well/raised recipe instead of an accent tint.
- `VoiceConnectionCheck` — the verdict banner and each step's readout are wells
  (danger uses the danger well); the step code is mono meta. **The `z-[160]`
  stacking over the settings overlay is untouched and its test still passes.**
- `ContextMenu` — floating recipe, no blur, no border; a destructive item takes
  danger **ink** on a neutral wash instead of a saturated red fill (the hover
  fill used to be `--accent-primary` on *every* item).
- `UserProfile` — the streaming avatar frame was a teal→emerald gradient; it is
  now the white light, which is what "this person is live" actually means. Bot
  and Staff badges lost their uppercase.

### Auth and onboarding
- `pages/authScaffold.tsx` rewritten: `AuthCanvas` is the street, `AuthCard` is
  one plate, `AuthHeading` is Gabarito + one specific line, `FieldLabel` is
  sentence case, `SuccessNote` is a well carrying emerald ink. `AppMark` lost
  its gradient (it is a solid emerald tile).
- **`BrandAside` is deleted.** Login and register were a two-column
  `max-w-4xl` card with a marketing rail of value props beside the form. The
  spec asks for one plate centred on the street and forbids illustration filler,
  so both are now a single `max-w-md` plate.
- **`/setup-server`** (first-owner claim) is one plate: the heading, the four
  steps as wells with a quiet mono index, all eight fields on the well recipe,
  and one full-width emerald "Claim this server". The password-requirement logic
  and every one of its strings are untouched.
- **Account setup / unlock / recover**, **server connect**, the **invite
  landing** and **bot authorize** follow the same vocabulary. Server connect's
  three presence dots are gone (§1.5, §6.6) — the words "Connected",
  "Saved — not connected" and "Sign-in required" carry it alone. Bot authorize
  deliberately does *not* use `AuthCanvas`: its route lives inside `AppShell`,
  so a second `h-dvh` `role="region"` landmark there would be wrong.
- **Terms / privacy** render through `legal/LegalDocument`, now one plate on the
  street with a `max-w-prose` article, a Gabarito display title, the
  "Last updated" stamp in mono and a hairline between sections. The two page
  files are pure content and needed no change.
- **The theme picker** (`components/customization/ThemeSelector`) shows the four
  themes `useTheme` actually supports — Night, Daylight, AMOLED, High contrast —
  each as a **real** miniature: a `<div data-theme={id}>` holding a street, two
  plates, lit/reading/dark windows and an emerald action, so the token
  re-substitution paints the genuine theme including its light recipes.
  Selection is a raised surface plus `aria-pressed` **and the word "Selected"**.
  The ten `ACCENT_PRESETS` are round swatches (a sanctioned circle) painted from
  the preset value, each with its own accessible name, under copy stating that
  an accent recolours actions only and never the light.
- **Onboarding** — the wizard moved onto `AuthCanvas`/`AuthCard`, its progress
  bars gained a mono "1 of 2" so the bar is not the only cue, and its three
  feature icons stopped being three different semantic colours (§6.3: a
  semantic hue is not decoration). The layout tour's coach-mark is now
  `pc-floating` with 32px controls.

### Feedback, empty and loading states
- `ErrorBanner` — the danger **well** carrying danger ink (it was a tinted box
  with a border). The `multiline` escape hatch that stops a long explanation
  being ellipsized is intact and still the default for guidance text.
- `EmptyState` — icon in a well, Gabarito heading, one specific line, one
  action, left-aligned.
- `Skeleton` — the diagonal sheen was a gradient wash across a surface (§6.2);
  it is now a matte `--bg-mod-strong` with the same opacity-only pulse.
- `Toast` — the floating recipe; the action label lost its uppercase tracking.

### Shared CSS classes (the quiet half of the work)
`client/src/styles/components.css` and `layout.css` carry global classes that
dozens of un-restyled call sites still use. Restyling them moved whole surfaces
without touching their JSX:

| Class | Before | After |
|---|---|---|
| `.input-field`, `.select-field` | colour-mixed fill + 1px border + a 3px accent halo on focus | the well recipe + the §9 focus ring; `--select-chevron` |
| `.settings-nav-item` | 44px row, accent-tinted fill + accent border when active | the `NavRow` recipe: 34px, raised when active, no border |
| `.tab-btn` | `--bg-mod-subtle` for both hover and active — the selected tab was invisible | raised + the warm highlight when active |
| `.settings-section-title` | 1.45rem, tracked | the Gabarito Title step |
| `.context-menu` | 1px border + `backdrop-filter: blur(18px)` | the floating recipe, no glass |
| `.context-menu-item` | hover filled with `--accent-primary`; danger hover filled solid red | neutral wash, danger keeps its ink |
| `.icon-btn`, `.command-icon-btn` | 1px transparent border, 12px radius | `--radius-control`, no border, the focus ring |
| `.btn-primary/.btn-ghost/.btn-danger` | raw px sizes, no focus ring | the control-height and Label tokens, `--focus-ring` |
| `.auth-card`, `.legal-card`, `.settings-surface-card` | raw rem radii and padding | the plate radius and the 4px grid |

`AppShell`'s two settings overlays lost their `backdrop-blur-md` and their
duplicate radius/shadow (the plate inside carries both now).

---

## 4. `/design-tokens`

The primitives section gained live examples of everything new: `Switch` in all
three states, a `ToggleRow` pair inside a plate, both `Tabs` variants, the bare
`Select`/`Textarea`, a real `Modal` (the delete-a-room confirm, with the danger
button and a field), `ErrorBanner` in both single-line and multiline form, an
`EmptyState` inside a plate, and a working `SettingsShell` miniature.

---

## 5. What the screenshots changed

The visual pass is not decoration — six things only showed up in a frame:

1. **The settings index was Title Case** ("My Account", "Voice & Video",
   "Space Hub", "Audit Log"). The contract asks for a sentence-case index, so
   every label in the user- and space-settings indexes is now sentence case
   (and the two places that asserted the old strings were updated with it).
2. **Phone settings was a short floating card** with the mobile bottom nav
   peeking out below it — `max-h-[min(900px,85vh)]` on a 844px screen. On a
   phone the overlay now fills the screen but for the 12px gutter (§3);
   desktop keeps the 85vh card.
3. **The developer page had no gutter** — it was the one settings route
   `AppShell` did not give the 12px plate inset to.
4. **"Theme" was printed twice** in Appearance: the section wrapper and
   `ThemeSelector`'s own labelled section. The wrapper is gone.
5. **The account avatar was emerald** — the accent means "an action you can
   take", and a person is not an action. It takes an identity hue now, and the
   "Change avatar" control became a raised chip instead of a bordered box.
6. **The voice check's "Also check my camera" was a raw platform checkbox.**
   That is what produced `.pc-checkbox` and the sweep of the other ten.
7. **Space settings opened with a lone "Refresh" button** floating above every
   section's heading. It moved into the index footer, beside the close control,
   the way the developer page's "Reload applications" already sat.
8. **On a phone the section name was printed twice** — once in the shell's
   back/close bar and again as the content's heading. The bar now carries what
   is being configured (the person, the space) and the heading carries the
   section.
9. **Eyebrow labels were emerald** ("You're invited", "Step 1 of 2",
   "Authorize application"). The emerald means an action you can take; a
   signpost is not an action (§1.2, §6.3). They take the meta ink now.
10. **The identity-import file input** was the raw platform file control, and
    login's "·" separator was painted in a *border* token. Both fixed.

Two fixture problems in the harness itself also surfaced, and are fixed there
rather than in the product: `/login` was redirecting to `/setup-server` because
the mock always claimed the server was unclaimed, and the admin overview threw
because the catch-all `[]` response is truthy where a health report is expected.

---

## 6. Kill-list sweep (§6)

Found and removed inside WP7's scope:

- **Uppercase labels and badges** — the Esc hint, the success badge in the
  sessions list, the Bot/Staff badges, the toast action, and every
  `text-section uppercase tracking-*` in the delegated slices.
- **Glass** — `backdrop-blur` on the two settings overlays, the edit-history
  dialog and the modal backdrop; `backdrop-filter: blur(18px)` on
  `.context-menu`.
- **Gradient washes** — the `AppMark` duotone, the streaming avatar frame, the
  skeleton sheen.
- **Over-rounding** — `rounded-md`/`sm`/`xs` and literal px radii across the
  settings surfaces onto the `--radius-*` steps.
- **Border-as-depth** — the `rounded-md border border-border-subtle
  bg-bg-tertiary` readout pattern, used ~15 times in user settings alone, is now
  a well.
- **Placeholder microcopy** — "Nothing detected yet" for the activity-privacy
  list became "Paracord hasn't seen you in another app yet", with the same
  follow-on line telling you how to make something appear.
- **Emoji chrome** — none found in scope.
- **Status dots** — none left in scope (WP0 removed the tokens).

---

## 7. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **249 files, 2164 tests passed** |
| `npm run build` | pass |
| `npx playwright test` (mocked smoke) | **84 passed** |
| `npm run test:a11y:static` | pass |
| `npm run test:contrast` | **49 checks × 4 themes passed** |

> **Reading these numbers.** WP7 landed into a worktree where WP1, WP2, WP4,
> WP5 and WP6 were being written at the same time. The results above were taken
> at the last point the tree was quiet; re-running while another package is
> mid-edit will surface *their* files (`hooks/useLights.ts`,
> `components/message/**`, `components/layout/TopBar*`, `components/home/**`,
> `components/rooms/lobby/**`). Every file in WP7's scope is clean on all seven
> commands, and every failure observed during the package was traced to a
> concurrent edit outside it.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp7 npx playwright test
# → output/design-reference/wp7/ (gitignored)
```

`client/e2e/design-review.spec.ts` gained a WP7 pass that runs only when
`PARACORD_E2E_DESIGN_WP=wp7`. It captures, at **1440×900 and 390×844**:

- every user-settings section (account, appearance, voice, notifications,
  activity, keybinds, identity, server, about),
- four space-settings sections, the admin panel and the developer page,
- three dialogs — the voice connection check *opened from inside the settings
  overlay* (the stacking case), the invite modal, and a destructive confirm,
- ten entry screens — login, register, `/setup-server`, connect, account
  setup/unlock/recover, the invite landing, terms and privacy.

**64 frames, and all of them were looked at.** Three harness details make that
possible:

- Settings sections are reached by *clicking the index*, not by reloading the
  app once per section — one boot per viewport, and it exercises the real
  interaction. The whole pass runs in about 90 seconds.
- A frame that cannot be reached is recorded and the run carries on, then the
  list is asserted empty at the end. One broken screen never costs the other
  sixty, and a silently missing frame still fails the gate.
- The mock grew what the WP7 screens actually need: a `signedOut` flag that
  makes `/auth/refresh` return 401, a `setupRequired` flag that moves with the
  frame (every entry screen redirects to `/setup-server` while it is true), an
  admin health report (the catch-all `[]` is truthy where a report is expected,
  so the overview threw), a `GuildInvite` that satisfies the response contract,
  password requirements that match what the setup page advertises, and an admin
  flag on the fixture user so the admin panel and the Server section render.

---

## 8. Left for WP8

- `ImageLightbox` still paints `text-white/85` over arbitrary imagery; it needs
  a decision about what "ink over a photo" is in this system.
- `CommandPalette` and `DiscoveryPage` still pass `panelClassName` overrides
  (`border-border-strong`, `bg-bg-secondary`) to `Modal` that the dialog recipe
  now supersedes — dead classes, harmless, worth deleting in the sweep.
- `pages/FriendsPage.tsx` has a "Nothing here yet" empty state and
  `pages/DiscoveryPage.tsx` a "Nothing here matches…" one; both are WP5/WP6
  surfaces.
- The `.glass-rail` / `.glass-panel` / `.glass-modal` class *names* survive with
  no glass in them; renaming them and their call sites is WP8's job.
- WP7 used the plain WP0 avatar everywhere it needed one; when WP1's `LitAvatar`
  lands, the settings account header and the user profile should adopt it.
- `.settings-nav-item` in `styles/components.css` is now dead — both settings
  shells use the `NavRow` primitive. It was restyled rather than deleted here
  because deleting a global class belongs to the sweep.
- `pages/developer/CreateBotForm.tsx`'s two fields are still `Input`s laid out
  in a grid rather than `TextField`s; they are labelled `sr-only`, which works
  but hides the labels a settings form would normally show.
- Title case survives in *product* strings ("Save Keybinds", "Export Identity",
  "Space Hub" as a feature name). The kill-list bans uppercase, not title case,
  and several of these strings are asserted by e2e specs; a copy pass is its
  own piece of work.
