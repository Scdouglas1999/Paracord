# WP8 — The sweep

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §10, row **WP8**.
Branch: `design/lantern-stage`. This package closes the overhaul: it collects
every "left for later" note WP0–WP7 wrote down, removes what the overhaul
replaced, re-homes the one feature a deleted component took with it, and runs
the whole gate.

Sixteen commits, `2078c03..21e587d` plus this one. 194 files changed,
2 218 insertions, 4 383 deletions — the sweep deletes roughly twice what it adds.

---

## 1. The checklist

Every item below was read out of a WP0–WP7 checkpoint, out of the WP8 brief, or
out of the orchestrator's review of the landed frames. §2 onwards is the detail.

### A. Deferred by the checkpoints

| # | From | Item | Disposition |
|---|---|---|---|
| A1 | WP5 §6 | `e2e/smoke.spec.ts:698` matches the buildings listbox option with `/QA Guild lobby/i`, which cannot match the long fixture name | **Done** — the fixture name is a shared constant and the locators match the whole accessible name through an escaping helper (`71dfdf1`) |
| A2 | WP5 §6 | `e2e/production-messaging.spec.ts` + `e2e/real-server.smoke.spec.ts` still select the old `Message #channel` placeholder | **Done** — "Say something in \<room\>" (`71dfdf1`); the two `getByRole('textbox', { name: /Message/ })` locators in the same suites found in the gate are now `/Say something/` (`6b8c205`) |
| A3 | WP5 §5.1, §6 | `ContextPanel`'s `members` mode and the mobile swipe that opens it | **Done** — mode, swipe and `MemberList.tsx` deleted; group-DM recipients re-homed as the `recipients` mode (`326d192`) |
| A4 | WP5 §6 | `.chat-header-action` / `.chat-header-active` dead in `components.css` | **Done** — deleted with 83 other dead class rules (`e7564d0`) |
| A5 | WP7 §8 | `.settings-nav-item` dead | **Done** (`e7564d0`) |
| A6 | WP0 §8, WP7 §8 | `.glass-rail` / `.glass-panel` / `.glass-modal` / `.glass-sidebar` | **Done** — all four deleted; `.glass-modal`'s one call site is `pc-dialog`, the same recipe under its real name (`e7564d0`) |
| A7 | WP3 §6, §7 | three broken `text-text-text-body` utilities in `DesignTokensPage.tsx` | **Done** (`e7564d0`) |
| A8 | WP4 §1, §7 | retire `components/rooms/RoomCard.tsx` + `OccupantStack.tsx` | **Done** — deleted with their tests; no importer remained (`e7564d0`) |
| A9 | WP3 §7 | `components/layout/VoiceParticipants.tsx` | **Done** — deleted with its test (`e7564d0`) |
| A10 | WP7 §8 | `LitAvatar` where settings/admin show an avatar with presence | **Done** — the user profile and the settings account header (`74775f2`) |
| A11 | WP7 §8 | the Title-Case copy pass, with the assertions that pin those strings | **Done** — 388 strings in 98 files, `src/` and `e2e/` together (`729c34f`) |
| A12 | WP3 §6 | the two static-a11y findings (`HomeAddBuilding`, `TimelineParts`) | **Not present** — `npm run test:a11y:static` passes on the whole tree; WP5/WP6 fixed them in flight |
| A13 | WP7 §8 | dead `panelClassName` overrides from `CommandPalette` / `DiscoveryPage` | **Done** (`e7564d0`) |
| A14 | WP2 §8 | stale prose naming deleted components | **Done** — `PinnedRail`, `SpacesList`, `GuildHomeHeader`, `LiveRoomsGrid`, `serverResolve`, `ConversationRow`, `MiniVoiceBar` (`74775f2`) |
| A15 | WP2 §8 | `CallDock`'s collapsed variant paints `bg-accent-tint` + `ring-bg-secondary` | **Done** — being in a room is white light, not the action colour: a raised pill with a lit dot (`3a982f5`) |
| A16 | WP0 §8 | `data-testid="presence-dot"` in `ConversationRow` | **Moot** — `ConversationRow` is deleted (`e7564d0`); no `presence-dot` remains anywhere |
| A17 | WP0 §8 | ~40 avatar fallbacks painting `bg-accent-primary` | **Already done** by WP2–WP7 — every avatar fallback now takes `getIdentityColor`; the remaining `bg-accent-primary` fills are buttons, progress bars and toggles, which is what the action colour is for |
| A18 | WP0 §8, WP7 §8 | badge-sized `uppercase` labels | **Done** — the last two were the event card's weekday and the code block's language tag (`74775f2`). No `uppercase` class or `text-transform` survives in the product |
| A19 | WP7 §8 | generic empty states in `FriendsPage` / `DiscoveryPage` | **Done for Friends** — the fallback state named its real tab (Requests) and gained its action (`74775f2`). `DiscoveryPage`'s was already specific and already carried a Clear-filters action |
| A20 | WP7 §8 | `CreateBotForm`'s `sr-only`-labelled `Input`s | **Done** — two `TextField`s with visible labels (`74775f2`) |
| A21 | WP0 §8 | point `docs/design-spec.md` at the Lantern Stage spec | **Done** — two paragraphs, file kept because other docs link to it (`00105cd`) |
| A22 | WP8 brief | `docs/layout-spec.md` §7 "Rooms recipes" names the replaced components | **Done** — rewritten as the IA-level map (`00105cd`) |

### B. The brief's own scope

| # | Item | Disposition |
|---|---|---|
| B1 | Hub welcome copy / banner / featured rooms, with tests | **Done** — each fact goes where it is already true of the Lobby (`64581ef`); §3 |
| B2 | Migrate every deprecated token alias, then delete it | **Done** — §4 carries the table (`3a982f5`) |
| B3 | `--color-status-*`, glass/noise/ambient, Fraunces/Inter | **Confirmed gone** — one prose mention of `--color-status-*` survives, in `lib/presence.ts`, explaining what replaced it |
| B4 | Hard-coded hex outside `tokens.css`, and a lint so it cannot regress | **Done** — `scripts/literal-colour-audit.mjs`, `npm run test:tokens`, wired into `npm test` (`3a982f5`); §5 |
| B5 | Uppercase section labels, emoji chrome | **Done** for uppercase (A18). **Nothing to do** for emoji: a scan of every emoji block in `client/src` finds no emoji used as chrome — only the emoji picker, reactions and custom-emoji parsing, which are product features |
| B6 | Delete unused components / hooks / CSS | **Done** — 15 modules and 85 CSS rules (`e7564d0`); §6 |
| B7 | README screenshots + copy in the new vocabulary | **Done** (`40800d4`); §7 |
| B8 | The full gate, fixed at the root | **Done** — §8 |
| B9 | A complete design-review capture, every frame inspected | **Done** — §9 |

### C. The orchestrator's review of the landed frames

| # | Item | Disposition |
|---|---|---|
| C1 | `RoomThumbnail`'s lamp is a grey haze over the top-left third of every live thumbnail | **Done** — the thumbnail has its own recipe now, `--thumb-glow` over `--thumb-frame-lit`, matching the reference exactly (`1536f3a`); §2 |
| C2 | The Stage frame has no Buildings column | **Harness, not product** — `VoiceStageChannel` has always rendered inside the AppShell; the frames came from `/design-stage`, a bare preview page. It now also mounts at `/app/design-stage` and the desktop frames use it (`1536f3a`, `0cbc578`) |
| C3 | The text-room header shows only the room name | **Fixture, not product** — `TopBar` renders "\<building\> · \<topic\>" and `TextRoom.test.tsx` pins it; the WP5 fixture had neither a guild in the store nor a topic on the channel. Both are staged now (`22359ad`) |
| C4 | The WP5 fixture was empty and dark | **Done** — a building of 24 with three people in the room next door, three typing, and a timeline written by people who are in it (`22359ad`) |

---

## 2. The lit window (C1)

`RoomThumbnail` borrowed the card lamp — `radial-gradient(closest-side)` on a
fully-rounded ellipse — and stretched it to 140% × 240% to cover the frame. At
that size it reads as grey fog over the top-left third of every live thumbnail:
the sidebar row, the Lobby card and the Home card.

That is not what the reference renders draw. `Home.html`, `Main.html` and
`Lobby.html` all paint the glow **into** the window —
`radial-gradient(70% 120% at 20% 0%, rgba(243,234,216,.16), transparent)` over a
tinted `#101a16` frame — and keep the lamp for what §1.2 says it is: one ellipse
per lit card.

So the thumbnail gets its own recipe, remapped per theme like every other light
token:

| Token | Night | Daylight | AMOLED | High contrast |
|---|---|---|---|---|
| `--thumb-frame-lit` | `#101a16` | `#e4e8e1` | `#080d0b` | `#0b1210` |
| `--thumb-glow` | `rgba(243,234,216,.16)` | `rgba(133,94,48,.14)` | inherits Night | `rgba(243,234,216,.24)` |

drawn by `.pc-thumb-glow` (inset-0, no border-radius). A dark room keeps the
plain matte well and has neither. The contrast audit gained two checks on the
new frame, since the LIVE label and the occupants' names are read against it.

---

## 3. What the building's operator wrote (B1)

`SpaceBriefing` went with the Emerald Commons, and it was the only member-facing
render of a building's hub settings — so welcome copy, a banner and featured
rooms were still configurable in space settings and displayed nowhere. §7.3 has
no slot shaped like a briefing block, so each fact goes where it is already true
of the Lobby:

- **The welcome line IS the header's sentence** when the operator wrote one. A
  building gets one line, and the person who runs it outranks the generated one.
  The generated summary moves into the accessibility tree, so §9's text
  equivalent for the light does not go with it. Collapsed to a single line — a
  pasted paragraph must not push the rooms off screen.
- **The banner IS a 64px band** across the top of the plate. Not a hero, no
  gradient, nothing written over it (§6.1, §6.2).
- **Featured rooms ARE first**, in both lists, in the operator's own order. Not a
  separate section and not a badge: a small pin and an sr-only "Featured by this
  building", spending no light token (§6.3) — being chosen by an operator is not
  somebody being present.

`client/src/components/rooms/lobby/hubWelcome.ts` holds the reading and the
ordering as pure functions. Twelve tests in `lobby.test.tsx` cover: the welcome
line replacing the generated one and the generated one surviving for a screen
reader; a whitespace-only welcome leaving the generated line alone; the greeting
winning over the blurb and being collapsed to one line; a `javascript:` URL in
`banner_hash` painting nothing; non-string pinned ids being dropped; featured
ordering (none, some, and an id for a room that is not here); and a featured row
saying so without spending a light token.

---

## 4. The alias → name migration (B2)

WP0 kept the v1 names alive so WP2–WP7 could restyle one surface at a time.
Every consumer is now on the v2 name and the aliases are gone from `tokens.css`.
Three different jobs hid under one heading.

### 4.1 Surfaces — mapped by role, not renamed

`bg-bg-tertiary` was the app's base on the shell root **and** the recessed fill
of every input. v2 has different tokens for those, so a blind rename would have
been wrong on half the ~90 call sites. Each one was mapped to what it is:

| v1 alias | Went to | Where |
|---|---|---|
| `--bg-primary` | `--bg-base` | full-screen grounds (`ErrorBoundary`, `MediaTest`) |
| `--bg-primary` | `--bg-plate` | a page that fills the shell's `<main>` (`GuildStateScreens`, `DiscoveryPage`, `FriendsPage`, `TemplateGalleryPage`, `AppShell`'s main) |
| `--bg-secondary` | `--bg-raised` | cards, embeds, headers, banners over content, ring-against-card |
| `--bg-tertiary` | `--bg-base` | the shell root, `App`'s splash |
| `--bg-tertiary` | `--bg-well` | inputs, textareas, selects, poster placeholders, quoted readouts, the letterbox behind a live surface |
| `--bg-accent` | `--bg-raised` | the update toast |
| `--accent-secondary` | `--accent-primary` | the teal is gone; there is one action colour |
| `--accent-danger-fill` | `--danger-well` | the v2 recipe was already the well |
| `--text-subhead` | `--text-heading` | 16 call sites |
| `--member-list-width` | `--w-context-panel` | the panel has not been a member list for two packages |
| `--ease-spring` | `--ease-out` | light never bounces (§5) |
| `--spacing-header-height`, `--spacing-sidebar-width`, `--spacing-channel-sidebar-width` | deleted | nothing read them |
| `--bg-canvas`, `--bg-dock`, `--bg-panel`, `--bg-chat`, `--app-bg-base` | deleted | nothing read them |

### 4.2 Tailwind's scale slots — a rename, and a fix

`rounded-sm` reads `var(--radius-sm)`, which WP0 pointed at `--radius-chip`. So
the rename is byte-identical and the class now says which step it means:

| Class | Became | Sites |
|---|---|---|
| `rounded-xs` | `rounded-window` (2px) | 31 |
| `rounded-sm` | `rounded-chip` (9px) | 147 |
| `rounded-md` | `rounded-well` (10px) | 48 |
| `rounded-lg` | `rounded-plate` (14px) | 1 |

`shadow-*` is the opposite, and this is the one place the migration changed what
the screen shows. Tailwind **inlines** its own literal black shadow for
`shadow-sm`; it never read `--shadow-sm` (which WP0 declared in `:root`, outside
the `@theme` block the utility generator looks at). So 37 call sites were
painting a v1 shadow with hard-coded rgba in it:

| Class | Became | Sites |
|---|---|---|
| `shadow-sm` | `shadow-[var(--shadow-chip)]` | 24 |
| `shadow-md` | `shadow-[var(--shadow-lifted)]` | 4 |
| `shadow-lg` / `shadow-xl` | `shadow-[var(--shadow-plate)]` | 9 |

### 4.3 What the migration surfaced

- `useTheme` wrote `--accent-secondary` on every theme change, and exported a
  `THEME_SURFACES` table of 16 literal colours that nothing read.
- the sidebar `CallDock`'s collapsed variant painted `bg-accent-tint` — the
  action colour — for a room you are **in**. Being in a room is white light.
- markdown's `@mention` was still the v1 Discord blurple, its spoiler and link
  rules carried literal fallbacks, and `==highlight==` was a raw rgba.
- the contrast audit's last two checks were on `--bg-primary` / `--bg-secondary`;
  they are now on the lit thumbnail's frame.

---

## 5. The literal-colour lint (B4)

`client/scripts/literal-colour-audit.mjs` — `npm run test:tokens`, and part of
`npm test`. It walks all 477 source files under `client/src` and fails on any
hex, `rgb()`, `hsl()` or CSS named colour used as a value. Comments are stripped
first, `text-white` / `bg-black` are recognised as theme utilities, and tests,
fixtures and generated contract types are out of scope.

Five files are allowed one each, **by name, with the reason no token can serve**:

| File | Why |
|---|---|
| `styles/tokens.css` | the palette itself |
| `hooks/useTheme.ts` | `ACCENT_PRESETS` — the hover and active steps are computed from the picked value (`shadeHex`/`scaleHex`), so the numbers cannot be custom properties |
| `lib/colors.ts` | `DEFAULT_ROLE_COLOR` / `UNSET_ROLE_COLOR` — a role colour is data sent to the server, not a surface this app paints |
| `lib/media/video/canvasRenderer.ts` | canvas 2D `fillStyle` for the letterbox behind a video frame; a canvas cannot read a custom property |
| `components/customization/CustomCSS.tsx` | the example CSS in the editor's placeholder, which has to look like CSS |

Everything else was tokenised: the theme preview and accent-chip swatch classes
(dead — `ThemeSelector` renders token-based previews now), the two
`color-mix(…, #000)` hover fills, the markdown mention/spoiler/link/highlight
rules, and the 16-row `THEME_SURFACES` table.

---

## 6. What was deleted (B6)

Verified against the whole import graph (`src` + `e2e`, dynamic imports and
`vi.mock` specifiers included), then against `tsc`, 2 256 unit tests and a
production build.

**Modules** — each imported only by its own test, which went with it:

```
components/rooms/RoomCard.tsx + OccupantStack.tsx   the Emerald Commons card pair
components/layout/MemberList.tsx                    the docked member list
components/layout/VoiceParticipants.tsx             a participant list in the old vocabulary
components/layout/sidebar/ConversationRow.tsx       replaced by RoomRow + BuildingSection
components/file/FileUpload.tsx                      the live path is the useFileUpload hook
lib/attention/serverResolve.ts, gateway/types.ts    dead helpers
```

**CSS** — 85 dead class rules across `components.css`, `layout.css` and
`utilities.css`: the whole `.architect-*` / `.workspace-*` / `.nav-panel-*` /
`.card-stack-*` / `.theme-preview-*` / `.theme-accent-chip-*` families, the four
`.glass-*` names, `.chat-header-action`, `.chat-header-active`,
`.settings-nav-item`, `.member-panel`, `.sidebar-item-active` and the rest. The
three files went from 1 483 lines to 594. Rules that mixed a live selector with a
dead one were edited rather than deleted, and the chat header's
`grid-column`/`grid-row` declarations went with them — the header has been a flex
row since WP5 and those properties did nothing.

The `hljs-*` rules stay: highlight.js emits those at runtime and they appear in
no source file by construction. `.scrollbar-thin` had ~20 call sites and no
definition at all; it now has a one-line one, so the class is not a lie.

**Left alone on purpose.** The unused-export sweep also found dead code in
`lib/dmE2ee*.ts`, `lib/groupDmE2ee.ts`, `lib/signalPrekeys.ts`,
`workers/dmDecrypt.worker.ts`, `lib/systemAudioCapture.ts` and
`lib/systemAudioWorklet.ts`. Those are encryption and media paths, not UI, and
several are still referenced by `vi.mock` specifiers in live message-store tests.
Deleting them belongs to whoever owns those subsystems. They are listed in §10.

---

## 7. README screenshots (B7)

The eight images were captured against Emerald Commons in July. They were
recaptured with the same tooling against the same kind of real instance: a
throwaway server, a fixture community seeded over the public REST API
(`scripts/seed-demo-community.py`), and nine people holding real sessions — four
in browsers, five inside voice rooms over the client's own realtime handshake.
Nothing is drawn or retouched.

Three things the new UI required of `scripts/capture-readme-screenshots.mjs`:

1. `rooms.jpg` → `lobby.jpg`: a building's lobby, not a channel list. Its log
   line reads the Lobby's own words ("2 rooms lit, 10 with their lights on") and
   says so out loud when nothing is lit.
2. `members.jpg` → `people.jpg`: there is no docked member list (§6.5); the
   header's here-now strip opens the one full list the product has. The locator
   is scoped to `.chat-header` — the account plate in the column also says
   "Lights on".
3. The lobby is opened **before** the rooms are left to run. A room's duration
   counts from the moment that page first saw it lit (`lib/attention/litHistory.ts`
   — the gateway sends membership, not call start times, and the client refuses
   to invent one), so a reload before the shot restarts every clock and the cards
   read "0:03". They now read real elapsed time.

The fixture building is `Lantern Works`; the README's prose is in the product's
vocabulary — buildings, rooms, lights, and the people reading rather than a
roster of everyone who ever joined.

---

## 8. The gate

Run on this branch, in this order. Everything below passed; where something
failed, the fix is named.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **245 files, 2 256 tests, all pass** |
| `npm run test:a11y:static` | pass |
| `npm run test:contrast` | **49 checks × 4 themes** pass |
| `npm run test:tokens` *(new)* | pass — 477 files, 5 allowed exceptions |
| `npm run build` | pass |
| `npm run contracts:check` | pass — 27 Rust-derived types |
| `npx playwright test` (mocked, all three projects) | **84/84** |
| `PARACORD_E2E_REAL=1 PARACORD_E2E_MEDIA_PORT=18151 npx playwright test --workers=1` | **11/11** |
| `npx playwright test -c playwright.messaging.config.ts` | **6/6** |
| `npx playwright test -c playwright.dm-attachments.config.ts` | **1/1** |
| `cargo build --release --bin paracord-server` | pass |
| `cargo check --workspace --all-targets` | pass |
| `cargo fmt --all -- --check` | **fails — pre-existing, see below** |
| `git diff 83ea4ff --stat -- crates/` | **empty.** No server code changed in the whole overhaul |

### What failed, and the root fix

**The real-server suites had not been run since WP5–WP7 landed**, so they were
still asserting the Emerald Commons Home and composer. Nine assertions moved onto
what the product now says (`6b8c205`), and none was weakened without saying why:

- the composer is located by `/Say something/`, the prefix every §7.4 placeholder
  shares, not by the deleted "Message #channel"
- Home's right column is "Needs you" and "Pick up where you left off"; there is
  no per-room "Continue in \<room\>" region
- the Needs-you section is no longer removed when empty — it says "Nothing is
  waiting on you right now", because an absent section cannot tell you it
  checked — so the emptiness assertions count rows, not sections
- a Needs-you row names **who** mentioned you rather than how many times
  (`needsYouReason`), so the two count assertions became row-shape assertions and
  the preview assertions carry the content check they always did
- a row's single action is labelled for the room it opens ("Open decisions")
- the edit-history dialog lists "Version N · \<time\>" after WP7's restyle

**`playwright.dm-attachments.config.ts` could not run at all.** It set its ports
in `webServer.env`, which reaches only the spawned harness; the test process
still read the shared defaults and connected to a port nothing was listening on.
The ports are now set in the config module, where both sides see them.

**`cargo fmt --all -- --check` reports seven files, all under
`client/src-tauri/src/{audio_capture,native_media}`, none of them touched by
WP0–WP8.** They are unformatted at this branch's base: running `rustfmt --check`
over `git show 83ea4ff:<file>` finds 9, 2 and 34 hunks in `call_owner.rs`,
`audio_capture.rs` and `commands.rs` respectively. The same check passes on
`codex/improvement-program`, which formatted them after this branch forked
(`fac30c4`). Reformatting them here would put a large unrelated diff in files
this package does not own and would collide with that commit on merge, so it is
left. It resolves itself when the branches meet.

---

## 9. The design-review set (B9)

`PARACORD_E2E_DESIGN_OUT` was added so every package's frames can be gathered
into one folder:

```bash
cd client
for wp in wp0 wp1 wp2 wp3 wp4 wp5 wp6 wp7; do
  PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=$wp PARACORD_E2E_DESIGN_OUT=final \
    npx playwright test e2e/design-review.spec.ts
done
# -> output/design-reference/final/   (gitignored)
```

**116 frames**, every one at 1440×900 and 390×844 (plus two full-page phone
copies of Home and three desktop-only token sheets), all inspected.

| Surface | Frames |
|---|---|
| Tokens & primitives | `tokens`, `tokens-themes`\*, `tokens-primitives`\* |
| Light vocabulary | `light-avatars`, `light-windows`, `light-thumbnails`, `light-herenow`, `light-people-sheet` |
| Buildings column | `column-lobby`, `column-room`, `column-call`, `column-empty`, and in situ `app-lobby`, `app-room` |
| Home | `home`, `home-lit-evening`, `home-quiet-morning` (+ full-page phone copies) |
| Lobby | `lobby`, `lobby-lit`, `lobby-dark` |
| Text room | `text-room`, `text-room-people`, `text-room-pins`, `channel` |
| DMs | `dm`, `dm-index`, `dm-needs-setup` |
| Stage | `stage-share`, `stage-speakers`, `stage-joining`, `stage-reconnecting`, `stage-lobby` |
| Settings | `settings`, nine `settings-user-*` sections, `settings-space`, `settings-admin`, `settings-developer` |
| Dialogs | `dialog-voice-check`, `dialog-invite`, `dialog-confirm` |
| Entry | `auth-login`, `auth-register`, `auth-setup-server`, `auth-connect`, `auth-account-setup`, `auth-account-unlock`, `auth-account-recover`, `auth-invite`, `auth-terms`, `auth-privacy` |

\* desktop only — the theme and primitive sheets are wider than a phone.

Five things the review caught, all fixed in `99c9bdf` and `21e587d`:

1. **A tooltip in the frame** rather than the surface — a cursor left over a
   control after a click opens one. `shoot()` parks the pointer now.
2. **The Lobby's media strip was a bright green rectangle** — the fixture was one
   pure-green pixel, scaled to fill a tile. It is a near-black gradient now.
3. **The phone composer wrapped to two lines**, pushing it past §3's 46px. The
   placeholder clips to one line; a real draft still wraps and grows.
4. **The reconnecting notice truncated both halves** on a phone, which tells the
   reader nothing. It wraps to two lines below the small breakpoint.
5. **The reconnecting speaker strip stretched down the whole plate** — the
   preview claimed a dominant tile it had nothing to put in. A reconnect is a
   grid of speakers with a notice above it, and it is drawn that way.

Two fixture repairs the set required are in §1 C2–C4.

---

## 10. Still open

Named honestly, because a sweep that claims to have finished everything is
lying.

- **`cargo fmt --all -- --check` is red on this branch**, in seven desktop-shell
  files nothing here touched. §8 has the proof it pre-exists and where it is
  already fixed.
- **Dead code outside the UI.** `lib/dmE2ee.ts`, `lib/dmE2eeWorker.ts`,
  `workers/dmDecrypt.worker.ts`, `lib/groupDmE2ee.ts`, `lib/signalPrekeys.ts`,
  `lib/systemAudioCapture.ts` and `lib/systemAudioWorklet.ts` are unreachable
  from `main.tsx`; several are still named by `vi.mock` specifiers in live
  message-store tests, which is why `tsc` is happy about them. Encryption and
  media paths are not a design sweep's to delete.
- **`pinnedStore` is read by `useUnifiedConversations` and drawn by nobody.**
  No surface in this design offers a pin affordance — §7.1 orders buildings by
  brightness and recency instead. Either a surface gains one or the store goes;
  the note in the file now says so.
- **~60 unused type re-exports** in the `ui/`, `light/`, `lobby/` and `stage/`
  barrels, plus a handful of functions exported only for their own tests. They
  cost nothing at runtime and deleting them would churn four public-looking
  barrels for no gain; worth a pass if the barrels ever become an API.
- **A room's duration restarts on reload.** `litHistory` counts from when *this
  page* first saw a room lit, so a room you have been in for an hour reads
  "0:03" after a refresh. That is honest by construction (WP1 chose a lower
  bound over a guess) but it is still wrong-looking; the real fix is a server
  `lit_since`, which is a protocol change.
- **A mention count is invisible when the author is known.** `needsYouReason`
  says "\<author\> mentioned you", so two mentions from the same person in the
  same room read the same as one. WP6's choice, surfaced by the real-server
  suite; worth revisiting with the row's design rather than patched here.
- **`--thumb-frame-lit` for Daylight is a judgement call.** The Night value comes
  straight from the reference renders; the other three themes are derived, and
  only the Night one has been compared against an artboard.
- **The here-now strip is hidden below the `md` breakpoint.** On a phone the
  room header has no room for "5 reading · 19 lights on", so the light's words
  on that surface come from the composer's invitation instead ("Say something to
  the 3 people reading"), which is in the DOM and visible. §9 holds, but the
  count is one fold further from the eye than it is on a desktop.
- **The phone composer now clips its invitation** ("Say something to the 3 pe…").
  The full sentence is still the accessible name, and a typed draft has the whole
  field — but a shorter phone-specific form of the copy would read better than an
  ellipsis, and §7.4 does not say what the short form is.
- **`scrollbar-thin` is now defined but nearly redundant** — the global rule
  already sets `scrollbar-width: thin`. It stays as an explicit marker at the
  call site; it could equally be removed from all ~20 of them.
