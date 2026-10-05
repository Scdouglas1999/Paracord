# Index: what shipped

Branch `feat/index-ui`. Contract: [`docs/index-spec.md`](../index-spec.md). Plan:
[`index-plan.md`](index-plan.md). Every package left a checkpoint in
[`index-checkpoints/`](index-checkpoints/); this page says what Index is, where
it lives, what still sits under `glass` paths and why, and how it is tested.
Glass, the interface Index replaced, is recorded in
[`glass-summary.md`](glass-summary.md).

## What Index is

Two flush columns in one window: a sidebar (316px; 280px below 1024px) and main.
The dock sits at the bottom of the sidebar: People first, then your servers, then
Add a server. A place is People or a server. Each server has its own hue, and the
window takes a tint from it. The sidebar holds a header, a search field, the live
room card, channels with a preview line each, voice channels, add-ons and Coming
up. Main holds a large title that folds into the toolbar as you scroll, the
conversation, and the message box that opens when you type. A call is a view over
main that grows out of the room card and goes back into it; theater covers the
window. On a phone the sidebar is the root screen and main is pushed over it.

What Index does not have, on purpose: Home, a server rail, a floating call pill,
room light (a backdrop painted from the live stream), the compact overlay, the
browse stage mode, and stream reactions (flame and heart). The owner removed
stream reactions in `1bc00a09`; IX-19 deleted the feature end to end, including
the `POST /api/v2/voice/{id}/stream-reactions` route, its gateway event, the
contracts, the generated client types and the tests. Message emoji reactions are
a different feature and stay.

## Where it lives

| Piece | Path |
|---|---|
| Shell: frame, toolbar, tint, place slide, large-title pages, slots | `client/src/components/ix/shell/` (`IxFrame`, `Toolbar`, `TintLayers`, `phone/`) |
| Sidebar: header, search, channel rows, room rows, add-ons, Coming up | `components/ix/sidebar/` |
| Dock and the Add a server sheet | `components/ix/dock/` |
| Live room card and its actions | `components/ix/card/` |
| Call view, theater, filmstrip, controls, `CallMenus` | `components/ix/call/` |
| People place: sidebar, Friends, Inbox, New message, Discover, last-place redirect | `components/ix/people/` |
| Sheets, menus, the quick switcher host | `components/ix/menus/`, `components/ix/sheets/` |
| Pages: server pages, Settings, Admin, long tail | `components/ix/page/`, `pages/` |
| Avatars, server marks, hue | `components/ix/identity/` |
| Glyphs, motion helpers, accessibility helpers | `components/ix/glyphs/`, `components/ix/motion/`, `components/ix/a11y/` |
| Timeline and message box (restyled in place, send flight kept) | `components/message/` with `styles/ix-timeline.css`, `ix-composer.css` |
| Stylesheets | `client/src/styles/ix-*.css` (one per area), tokens in `styles/tokens.css` (the Index block) |
| Layout state (the stage mode, chat column, sheet) | `stores/glassStore.ts` (the name stayed; see below) |
| Review harness and drivers | `client/e2e/fixtures/index/` |
| Live scene on a real instance | `client/scripts/index-scene.mjs`, `scripts/index-scene/`, shared helpers in `scripts/scene-lib/` |

## What still sits under `glass` paths

IX-19 deleted what nothing imports. Some live code kept its path, because
renaming a directory only churns every importer and its history. Each of these is
used by Index:

- `components/glass/sheets/` (the sheet frame and the people, channel,
  notifications, reminders and thread sheets), `glass/cards/` (event, plan and
  media cards and the inline chips the timeline draws).
- `components/glass/places/` (`model`, `rows`, `usePlacesData`): the data behind
  the sidebar. `glass/pill/` (`model`, `pillActions`, `muteStore`): the data and
  actions behind the room card. The UI that used to draw them is gone.
- `components/glass/stage/`: the composed stream surface, stream sound, clip toast,
  surfacing messages, the stage channel panel and the stage data hooks.
- `components/glass/shell/` (`phoneNav`, `phoneMotion`, `usePhoneFrame`) and
  `glass/primitives/` (`GlassButton`, `Kicker`).
- `styles/glass.css` (type roles, focus, button), `glass-stage.css`,
  `glass-surfacing.css`, `glass-cards.css`, `glass-pages.css`, `glass-sheets.css`:
  each trimmed to the rules a live class still uses.
- Class names such as `glass-timeline`, `glass-msg` and `glass-mention` stay as
  hooks that the timeline, the send flight and the e2e specs select by.

The stage mode is `'none' | 'main' | 'theater'` (it was `'side'`). `glassStore`
lost `browseOpen`, `chatHidden`, `pillExpanded` and `placesOverlayOpen`.

## Packages

| Package | What shipped | Checkpoint |
|---|---|---|
| IX-0 Review harness | The prototype's scene as mocked data, a way to move it through its ten states, shots at 1280x800, drivers keyed to test ids | [IX-0](index-checkpoints/IX-0.md) |
| IX-1 Foundation | Tokens, the hue model, avatars and server marks, the glyph set, primitive metrics, high contrast | [IX-1](index-checkpoints/IX-1.md) |
| IX-2 Server hue and `joined_at` | `spaces.hue` (a server's hue), `voice_states.joined_at`, migrations on both engines, contracts | [IX-2](index-checkpoints/IX-2.md) |
| IX-3 Live scene driver | `index-scene.mjs`: the prototype's evening on a real instance with real calls and a real share | [IX-3](index-checkpoints/IX-3.md) |
| IX-4 Shell | `IxFrame`, toolbar, tint, place slide, large-title pages, the slots later packages fill | [IX-4](index-checkpoints/IX-4.md) |
| IX-5 Sidebar | Header, search field, channel rows with previews, voice channels, add-ons, Coming up | [IX-5](index-checkpoints/IX-5.md) |
| IX-6 Dock | People first, servers, Add a server; live dot, ping, unread dot, mention chip | [IX-6](index-checkpoints/IX-6.md) |
| IX-7 Room card | Every card state, people rows, controls, join flight, pinned card | [IX-7](index-checkpoints/IX-7.md) |
| IX-8 Conversation cards | The cards the conversation draws: event, plan, media and the mention chips | [IX-8](index-checkpoints/IX-8.md) |
| IX-9 Sheets and menus | The sheet frame, people and channel sheets, menus, the quick switcher | [IX-9](index-checkpoints/IX-9.md) |
| IX-10 Server pages | Every server page as a large-title page with the server's hue in reach; server color | [IX-10](index-checkpoints/IX-10.md) |
| IX-11 Timeline | Bubbles, grouping, system lines, the New divider, jump to latest, hover capsule | [IX-11](index-checkpoints/IX-11.md) |
| IX-12 Message box | The box that opens as you type, the send control, scheduled send; the send flight untouched | [IX-12](index-checkpoints/IX-12.md) |
| IX-13 Call view | The view that grows out of the card, tiles, stream focus, theater, controls | [IX-13](index-checkpoints/IX-13.md) |
| IX-14 People place | People sidebar, Friends, Inbox, New message, Discover, `/app` redirects | [IX-14](index-checkpoints/IX-14.md) |
| IX-15 Conversation chrome | Large title, welcome, action cards, event card, drop target, DM call notices | [IX-15](index-checkpoints/IX-15.md) |
| IX-16 Phone | Root screen and pushed main, swipe back, keyboard inset, safe areas | [IX-16](index-checkpoints/IX-16.md) |
| IX-17 Long tail | Settings, Admin, entry pages, dialogs, pickers, the media viewer | [IX-17](index-checkpoints/IX-17.md) |
| IX-18 Motion gate | Every §5 moment held to its duration and curve, transform and opacity only, quiet at rest | [IX-18](index-checkpoints/IX-18.md) |
| IX-19 Retire Glass | Deleted the Glass code, CSS, tokens and e2e specs; deleted stream reactions; ported the e2e suites | [IX-19](index-checkpoints/IX-19.md) |
| IX-20 Release check | The full CI gate, the desktop app walked and measured on WebKitGTK, and the fixes they found: the desktop's talking indicator, a rejoin that heard nobody, the waveform's cost, the member count, Back to chat, Together's line | [IX-20](index-checkpoints/IX-20.md), [release check](index-release-check.md) |
| M1 Send flight | `feat/send-flight` merged; the owner's favorite animation is protected | [M1](index-checkpoints/M1.md) |
| M2 Native video | `feat/native-video` merged before the call view was built | [M2](index-checkpoints/M2.md) |

## How it is tested

From `client/`:

```bash
npm run typecheck && npm run test:unit        # types and the vitest suite
npm run lint                                  # 0 errors
npm run test:tokens                           # no literal color outside the token files
npm run test:motion-lint                      # only transform and opacity animate
npm run test:a11y:static && npm run test:contrast
npm run test:e2e                              # mocked smoke: Chromium and Chromium touch, auth fit, encrypted storage
npm run test:e2e:index                        # every e2e/index-*.spec.ts, including the review walk
npm run test:motion                           # the motion gate
PARACORD_E2E_REAL=1 npx playwright test       # the real release server, serving the embedded UI
```

- `e2e/index-review.spec.ts` walks the prototype's ten reference states in order
  and shoots each at 1280x800. `node e2e/index-compare.mjs <WP>` lays each shot
  beside its reference in `output/design-reference/index/ref/` (local renders).
- Each `e2e/index-*.spec.ts` holds the numbers for one surface; the
  `PARACORD_E2E_INDEX_*` variables in `e2e/index-review.config.ts` pick a spec,
  ports and the output folder, so two runs never share a dev server.
- `e2e/smoke.spec.ts` is the fast mocked gate for the Index UI. The
  `real-server*.spec.ts` files drive the actual `paracord-server` binary; a
  desktop box that already runs a server on UDP 8443 needs
  `PARACORD_E2E_MEDIA_PORT` for them, and `PARACORD_E2E_SERVER_BIN` points at a
  binary built outside the repo's own `target/`. Live voice runs use Chromium's
  fake devices and never a real microphone, camera or output.
- CI: the `e2e` job runs the default config, `e2e-index` runs the Index specs and
  the motion gate, `e2e-real-server` runs the real-server suite.

## Left open

The release check is [`index-release-check.md`](index-release-check.md); IX-19's
long form is in `index-checkpoints/IX-19.md`. In short:

- In a call on the desktop, one person talking keeps WebKitWebProcess at about
  11% of a core (the real waveform and the talking ring are most of it). At
  rest the app sits at 0.3 to 1.9%.
- The join-muted preference may land after a quick unmute on a row join (seen
  once by the scene, not reproduced by hand).
- `lib/attention`'s light model still feeds the server home, Friends and the
  people sheet; the parts nothing uses were removed, the rest stays.
- Engines still parse the `ambient` view token and the server keeps its dormant
  ambient view kind. The client no longer opens one.
