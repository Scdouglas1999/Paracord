# WP-G21 checkpoint: long tail restyle

Contract: `docs/glass-spec.md` §1, §2, §5, §9. Plan: `docs/design/glass-plan.md` §4 (WP-G21), §8 (owner
decisions: one danger color, Glass is the only look). Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

Everything that another package does not rebuild now looks and behaves Glass: the shared UI primitives,
modals and confirm dialogs, Settings and Server settings, the command palette and channel switcher, the
emoji, GIF and sticker pickers, context menus, popovers, tooltips, toasts, the profile card and the
auth pages. The primitives carry most of it; the surfaces were then swept for what they hand-rolled.

## The rules applied

| Rule (spec) | What it became |
|---|---|
| §1.1 content solid, controls glass | Panes, dialogs, wells, cards, chips and toasts are solid tonal surfaces with no outline. Menus, popovers, pickers, the palette and buttons are glass. |
| §1.4 one filled button | `Button variant="primary"` is cream Join (`--join`, hover `--join-hover`, press `--join-press`), used only for THE action of a dialog or section. Inline and per-row actions were moved to `glass`. |
| §2.3 type | Window titles 20/600 (`glass-title-channel`), section titles 17/600, body 15, secondary 13, buttons 15/600 (13 at `sm`), group labels are the kicker (12/700 uppercase, narrow, `.1em`), numbers, times and dates are the instrument cut (`glass-instrument`). |
| §2.4 shape | Dialogs 24 (confirm, short forms) or 28 (windows), toast 22, popovers and cards 16 to 20, fields 12, rows in menus 10, chips 8. Buttons and icon buttons are capsules and circles; a text button is 12. |
| §5 popovers | `.pc-floating`: `--popover` (`rgba(6,6,7,.97)`) with `blur(30px) saturate(1.2)`, a hairline, `--sh-raised`. Opaque `--solid` with no blur under Reduced transparency and High contrast. Tooltips are the same fill without blur (`.pc-tip`). |
| §9 hover and press | Hover one step lighter, press one step darker, 120ms ease-out, nothing scales. Focus is the existing §9 ring (`--focus-ring`). |
| §1.3 / plan §8.5 color | One danger ink. Yellow warnings, green success and the toast colors are gone from chrome: they are ink now. |

## Files changed

Foundation
- `client/src/styles/primitives.css`: header and elevation rewritten (`.pc-plate`, `.pc-well`, `.pc-floating`, new `.pc-tip`, `.pc-dialog` with `--pc-dialog-r`, new `.pc-dialog.pc-sheet`); `.pc-pressable` and `.pc-pressable-row` lose the 0.98 scale and press with `--wash-press`; `.pc-pressable-accent` (the brighter flash) deleted; reduced-transparency and High contrast rules keyed on the real attributes (`data-reduced-transparency`, `glass-contrast`), which fixes the stale `[data-theme='high-contrast']` selector from the G1 list; `.pc-mono` documented as identifiers only.
- `client/src/styles/components.css`: `.btn-primary` (cream capsule, 120ms, no scale, no `::after` flash), `.input-field` (radius 12, 15px, placeholder token), `.icon-btn` (circle, wash steps), `.context-menu-item`, `.hover-action-btn` (no scale).
- `client/src/components/ui/`: `Button` (variants `primary`, `glass`, `ghost`, `danger`, plus the legacy aliases; sizes 32, 36, 44), `IconButton` (circles), `Chip`, `Tabs` (glass segmented control, "on" fill pill), `ChoiceCards` (tonal cards, selected = `--sel` + check + "Selected"), `Switch` (glass off, cream on, no amber glow), `Input`, `TextField`, `SearchWell`, `Modal` (radius by size, glass close circle), `ConfirmDialog`, `ContextMenu`, `Popover` and `MenuItem`, `Tooltip` (no arrow), `Toast` (see below), `Feedback` (`ErrorBanner`, `EmptyState`, `LoadingSpinner`), `Kbd`, `NavRow`, `SectionLabel` (kicker), `Divider`, `SettingsShell`, `ImageLightbox`, `EmojiPicker`, `index.ts` (header).
- Tests: `ui/primitives.test.tsx` (rewritten assertions, plus "nothing scales in any variant or size", circle icon buttons, kicker, glass switch, no amber knob), `ui/ContextMenu.test.tsx` (the regression test below).

Surfaces
- `components/layout/CommandPalette.tsx` (glass sheet, kickers, `Kbd`, `--sel` row), `ChannelSwitcher.tsx` (selected row without the accent bar).
- `components/message/GifPicker.tsx`, `StickerPicker.tsx` (same recipe as the emoji picker).
- `components/user/UserProfile.tsx` (the card's actions are `Button`s: Message is the one cream, the rest glass, Block and Report the danger well; two dialogs on `Modal` recipes; trust in ink), `UserSettings.tsx` (status notes and warnings in ink or the danger well, kickers, file input), `BannerEditor.tsx`, `PresenceActivity.tsx`.
- `components/guild/`: `SettingsPrimitives.tsx` (kicker group labels, secondary field labels), `EventList.tsx` (action row moved under the content: the wider Glass buttons squeezed the title to a few pixels), `AutomodSection`, `BotStoreCard`, `BotStoreSection`, `ChannelPermissionsEditor`, `CreateGuildModal`, `EconomySettingsSection`, `FileStorageSection`, `GuildEconomyPanel`, `GuildSettingsSections`, `GuildWelcomeScreen`, `OnboardingSettingsSection`, `SoundboardSection`, `StickersSection` (instrument cut on figures, warning colors to ink, per-row cream buttons to glass).
- `pages/authScaffold.tsx` (the card is a `glass-pane` with the faint corner glow, the canvas carries `--glow`, required marks in ink), `LoginPage`, `RegisterPage`, `AccountSetupPage`, `AccountUnlockPage`, `InstanceSetupPage`, `InvitePage`, `ServerConnectPage` (13px secondary text, links underline on hover instead of a color change, submit buttons 44px).
- `client/e2e/glass-longtail.spec.ts` and `client/e2e/glass-longtail.config.ts` (new): the shots below, on the G2 harness, with its own ports (4373 and 4375) so a run never lands on another checkout's dev server.

Not touched: `SettingsPage.tsx`, `GuildSettingsPage.tsx`, `GuildSettings.tsx` (already token-driven; nothing in them needed a change), `ChannelManager.tsx` (WP-G6).

No file outside the scope was edited.

## The ContextMenu fix (from the coordinator)

`ui/ContextMenu.tsx`: the placement layout effect now depends on `[anchor.x, anchor.y, anchorRef, mounted]`.
A menu that closed and reopened at the same anchor is a new node (the leave unmounts it) and was never
measured again, so it kept the offset of its last opening.

- `ContextMenu.test.tsx` "places a menu again when it reopens at the same anchor": closes, waits for the node
  to leave (a leaving menu is `aria-hidden`, so it queries the DOM, not the role), moves the anchor, reopens,
  and expects the menu under the new anchor. Verified to **fail without the fix** (`8px` against `500px`)
  and pass with it.
- `glass-longtail.spec.ts` "the message tools menu stays on screen on a phone, opened again and resized":
  the same behavior in a real layout at 390 wide (three openings, then a 420px tall window). It passes with and
  without the fix on today's composer (the G11 composer anchors by click point, which does not move), so the
  unit test is the discriminating one.
- `npx playwright test e2e/smoke.spec.ts --project=chromium` **cannot be judged in this tree**: it fails at
  line 526, `getByRole('button', { name: /Switch channel, current:/ })`, because the new conversation header
  (WP-G11) no longer mounts `ChannelSwitcher`. That is before the composer-menu assertions at lines 682-694.
  It is not from this package (the same spec was run on my own ports; `e2e/g11tmp/smoke.spec.ts`, another
  agent's copy, fails the same way). Whoever owns the header owns that line.

## Verification

Run from `client/` in the shared tree while other packages (G9, G10, G11, G13) were editing.

| Command | Result |
|---|---|
| `npm run typecheck` | pass (it went red twice during the session on other agents' in-progress files, `MessageList.tsx` and `glass/cards/CardGlyphs.tsx`; none in my files) |
| `npx vitest run src/components/ui src/components/user src/components/guild src/components/layout src/components/message/GifPicker src/components/message/StickerPicker src/components/home src/pages` | pass, 81 files, 638 tests |
| `npm run test:unit` (full) | run once mid-session: 361 of 363 files passed; the 3 failures were `AppShell.test.tsx` (2, G9's places overlay; passing again in the last scoped run) and `home/home.test.tsx` (1, mine: it asserts `bg-light-white` on `Button variant="light"`). Fixed by keeping the `light` variant on its own token classes (same cream). Not re-run in full since |
| `npm run test:tokens` | pass (741 files, no literal colors) |
| `npm run test:motion-lint` | pass |
| `npm run test:contrast` | pass (40,242 comparisons; no new tokens) |
| `npm run test:a11y:static` | pass (after rewording a comment in `Button.tsx` that the native-`confirm()` scan tripped on) |
| `npm run lint` | 0 errors in everything I touched (111 warnings across the touched directories, all pre-existing React-compiler and refresh warnings). Repo-wide: 2 errors, both in `e2e/g11tmp/glass-review.spec.ts`, another agent's scratch copy |
| `e2e/auth-fit.spec.ts` (through my config) | pass, 5 of 5: the 13px text and 44px buttons keep every entry screen inside 1280x740 and 940x500 |
| `glass-longtail.spec.ts` | pass, 19 of 19 (all shots below, plus the assertions in the next section) |

`PARACORD_E2E_GLASS_WP=g21 npx playwright test -c e2e/glass-longtail.config.ts` re-shoots everything.

### Measured in the browser: hover, press, no scale

The "primitives gallery" test mounts every `Button` variant and size and every `IconButton` tone into the running
page, hovers each, presses each with the mouse held down, and asserts `transform` stays `none`. Read back:

| Control | Hover | Press |
|---|---|---|
| primary | `rgb(255,255,255)` | `rgb(232,227,216)` (Join press, `#e8e3d8`) |
| glass | `rgba(255,255,255,.16)` | `rgba(255,255,255,.07)` |
| ghost | `rgba(255,255,255,.04)` (fill +4% white) | `rgba(0,0,0,.18)` |
| danger | the deeper danger well | that well with a `.18` dark wash |

Also asserted: under Reduced transparency a menu has `backdrop-filter: none` and an opaque fill.

## Screenshots (`output/design-reference/glass-build/g21/`)

Every one was opened with the Read tool. 1440x900 (`-desktop`) and 390x844 (`-phone`) unless noted.

- Settings: `settings-account`, `settings-appearance` (both sizes), `settings-notifications`, `settings-voice`, `settings-keybinds` (desktop); `all-user-<section>-desktop` for all 8 sections.
- Server settings: `server-settings-overview` (both), `server-settings-roles|emojis|invites|bans|addons` (desktop); `all-guild-<section>-desktop` for all 22 sections.
- Confirm dialog: `confirm-danger`, `confirm-default`.
- Command palette: `palette`, `palette-query`.
- Pickers: `emoji-picker`, `gif-picker`, `sticker-picker`.
- Menus: `context-menu-tools` (both), `context-menu-message`, `menu-server` (desktop), `channel-switcher` (desktop, mounted from the dev server because the new header does not render it), `tooltip-desktop`.
- Toasts: `toasts` (a success with an action, an error, an info).
- Profile card: `profile-card`.
- Dialogs: `dialog-create-server`, `dialog-invite` (desktop).
- Login and other entry screens: `auth-login`, `auth-register`, `auth-connect`.
- Accessibility themes: `hc-palette`, `hc-tools-menu`, `hc-settings`, `reduced-tools-menu` (desktop).
- Primitives: `primitives-desktop` (every variant, size, disabled state, tabs, fields, switch, feedback) and `button-primary-pressed`.

### Against the reference

The reference renders show panes, the pill, buttons, chips, a toast and type; they do not show a dialog, a
menu, Settings or an auth page, so those were held to the tokens and type roles the renders establish.

- Buttons match `04-side-by-side` and the pill: cream Join with dark ink, glass control at 12% white with the top highlight, text buttons with no fill, capsule shape. Hover and press match spec §9 to the value (table above).
- Toast: the reference's clip toast is `rgba(22,23,25,.97)` at radius 22 with a soft shadow. Radius, shadow and "no outline" match. **The fill differs**: a general toast sits on the conversation pane, where a near-black card has too little separation, so it uses `--raise` (a tonal card one step above bubbles). Over the stage it will read as the same near-black family; the clip toast is WP-G16's own.
- Type: Instrument Sans throughout; kickers match "COMING UP" (12/700, narrow, `.1em`, uppercase); dates, counts and times use the instrument cut.
- A correction to the G1 note about "tight word gaps": it is a headless-Chromium artifact (whole-pixel glyph advances close a 13px word space from 3.4px to 3px). The shots use `--font-render-hinting=none`, and body copy reads normally. It is not a token problem.

## Decisions worth a look

- **Warnings are ink, not yellow; success is ink, not green; info is not blue.** There is no Glass color for them, and the owner's rule is one danger color. The kind is carried by the icon and the words ("Not verified" beside a shield-alert icon), never by hue alone. The toast countdown line is gone (it was a colored underline); the store's timer still dismisses.
- **Dialogs are `--solid` (opaque), not `--pane` (.94).** A dialog carries text of its own over a dimmed app; the ghosting `.94` allows was already a documented problem (`.pc-coach`). Sheets that float over text (palette, switcher) are the glass kind instead.
- **Wells stay dark and recessed for fields.** `--well` is part of the Glass token set, contrasts with every surface it sits on (a lighter field would vanish inside a `--bub` card), and the focus ring layers over it. Only the radius moved, 16 to 12.
- **Button heights are 32 / 36 / 44** (were 28 / 32 / 44) so an inline button matches the pill's 36px and reads beside a 44px field. Icon-only controls are circles.
- **Numbers keep a face by meaning.** Counts, sizes, dates, durations and times are `glass-instrument`; codes, keys, URLs, IDs and patterns stay `.pc-mono` because a person reads them character by character. Inputs that held a number lost the mono face.
- The Modal, Popover and menu entrances still scale 0.96 or 0.98 to 1 while fading in. That is an arrival, not a press, and stays inside the motion lint; nothing scales on press anywhere in scope.

## Left Lantern-styled, and why

- `text-label` (14/500) is still the step for row titles in Settings. It is a token in `tokens.css` (not in scope); the Glass roles are 15 and 13.
- Hairline dividers inside settings lists (`divide-y`, the header and footer rules in a dialog). They are structural, `--border-subtle` at 7%, and turning every list into tonal rows is a redesign of each section, not a restyle. The dialog and window surfaces themselves have no border.
- `LitAvatar` (the lit avatar with its ring) inside the profile card and Settings header: `components/light/**` is retired by WP-G22.
- `.chat-header-*` rules at the end of `components.css` (the old conversation header, mention badge, capture status, still with warning tint): the header is WP-G11's and the rules go with the old one in G22. I did not restyle them.
- `focus.css` and `--focus-ring` (both outside scope): the ring paints its 2px gap in `--bg-base` (near black) instead of leaving it transparent as §9's `outline-offset` does. It reads correctly on the dark panes but is a black gap on a lighter surface. A one-line change in `tokens.css` (`--focus-ring`) or `focus.css` if wanted.
- Native controls: color picker, range sliders and the file input keep the browser's own control; only the file button is restyled.

## For other packages

- `client/src/styles/layout.css:9-23` still has `color-scheme` rules for `light`, `amoled` and `high-contrast` (dead); `layout.css` is not in this scope. `client/index.html:2` still carries `data-theme="slate"` (G1 list, unchanged).
- `.pc-pressable-accent` no longer exists. `components/rooms/lobby/widgets/DailyWordWidget.tsx:89` still names it; that is a no-op now.
- `Button variant="light"` is kept on `bg-light-white` / `text-text-on-light` (same cream as `primary`) because `home/home.test.tsx` asserts those classes; G19 can move Home to `primary` and drop the alias.
- The `ChannelSwitcher` is only mounted by the old `TopBar`. It is restyled, but WP-G18's channel menu replaces it; G22 can delete both.
- `client/e2e/smoke.spec.ts:526` (see above) needs the new header's name.
- The design page `/design-tokens` still shows the old copy ("off is a well, on is the emerald", "Lantern Stage") in its primitives section; it is `pages/DesignTokensPage.tsx`, outside this scope.
