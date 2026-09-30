# WP-G20 checkpoint: the phone shell

Contract: `docs/glass-spec.md` §8 (and §3, §5's two-row pill, §6, §9). Plan row: `docs/design/glass-plan.md`
(WP-G20, §5, §6 "Mobile"). Reference: `screens/07-phone.png` and `source/GlassV14Phone.dc.html`. Nothing is
committed by this package. Everything is in `~/Documents/Paracord-glass` (branch `design/glass`).

Below 768px the app is no longer two panes squeezed into one. **Places is a screen of its own and the
conversation is a screen in front of it.** There is no bottom bar, no drawer and no fake status bar; the
frame draws to the window's edges and pads itself with the device's safe areas. The stream is a card above
the conversation, the call pill is 366px wide at 390, and full screen is the phone's theater. 768 to 859px
still gets the compact frame G7 built (shot and asserted).

**One thing the orchestrator must know first.** My `git rm` of `components/layout/MobileBottomNav.tsx` and its
test was staged, and another agent's commit `67979633` ("fix(voice): watching plays the stream's own audio")
swept the two deletions in. `HEAD` therefore deletes a file that `HEAD`'s `AppShell.tsx` still imports, so
`HEAD` alone does not typecheck until this package's working tree is committed on top of it. Stage this
package's paths by name and commit them together.

## What the phone does now

| | |
|---|---|
| Open the app | On Home or the messages index: the places screen (they would only repeat it). On anything else, a deep link, a reload in a channel: that page |
| Tap a channel, a message, Friends, an add-on, an event or the live channel | The conversation slides in from the right (360ms), places steps back |
| Back | The chevron in the header (or, on a page without a header, in the row the frame adds), or a swipe right from the left edge |
| Tap a server circle | Stay on places and look at that server's channels. The circle you are already in goes back to its conversation |
| Tap the Home tray | Places in Home mode (your messages, and a Friends row). The tray again, while in Home, shows the Home page |
| Watch | The stream is a card above the conversation (16:9, radius 22), with back, clip "30s" and full screen on it |
| Full screen | The stream fills the window, the stage's own controls float as a glass capsule over it; Esc or the back button returns to the card, the next Esc stops watching |

Both screens stay mounted, so a draft, a scroll position and a stream that is playing survive a trip to the
list. The one behind is `inert`, off to the side, and (places) faded.

### What replaced each bottom-nav destination

| Was in the bar | Now |
|---|---|
| Home | The first circle of the server row on the places screen (the tray, with its unread badge) |
| Messages | The same tray: in Home mode the places list is your conversations, and arriving on the messages index shows places |
| Server | Places itself. Its circles are the server row; the conversation's back chevron is the way to it |
| Friends | A row at the top of the Home places list (white count of requests), opening the page, which has a back button |
| Settings | Your face at the top right of the places screen opens the account menu: status, reminders, **Settings**, developer portal, sign out |
| Search, people | Icons in the conversation header (unchanged, G11 and G18) |

There is no other door to settings on a phone, so the face is on the places screen and nowhere else (the
header has no face on a phone, as in `07`).

## Files

New, in `client/src/components/glass/shell/`:

| File | What it is |
|---|---|
| `PhoneFrame.tsx` | The phone's frame: the room, the scrim, two screens, the stage card, `main`, the sheets. The move and where focus goes after it |
| `PhonePlaces.tsx` | The places screen: your face, the call pill while you hold a call, the panel. One listener decides what a tap means |
| `PhoneStageChrome.tsx` | What the phone draws over the stream: back, clip "30s", full screen, the name, the count; in full screen the controls capsule and Esc |
| `phoneNav.ts` | `usePhoneNavStore` (`'places' \| 'conversation' \| null`), `usePhoneNavigation`, `isPlacesRoute`, `isConversationRoute` |
| `phoneMotion.ts` | The screen change as Web Animations (transform and opacity only), with the reduced-motion 150ms crossfade |
| `PhoneFrame.test.tsx`, `PhoneStageChrome.test.tsx`, `phoneNav.test.tsx`, `phoneMotion.test.ts`, `PlacesToggle.test.tsx` | Unit tests |

Also new: `client/src/styles/glass-phone.css`, `client/src/hooks/useSwipeGesture.test.tsx`,
`client/e2e/glass-phone.spec.ts`, `client/e2e/glass-phone.config.ts` (ports 4443/4445, dev server `glass-stage-dev.mjs`).

Changed:

- `shell/GlassFrame.tsx`: a phone returns `PhoneFrame`; the wide and compact paths are untouched.
- `shell/PlacesToggle.tsx`: on a phone it is the back button (`Back to places`); compact and wide as before.
- `shell/index.ts`: exports.
- `pages/AppShell.tsx` (phone branch): the drawer, the drawer's focus trap, the bottom bar and the on-air dock are gone;
  it keeps the old drawer flag collapsed on a phone, turns on `usePhoneNavigation`, and takes the swipe. The skip link
  brings the conversation in when places is in front. `AppShell.test.tsx`: the drawer, bottom-bar and on-air-dock tests
  are replaced by phone-frame tests.
- `hooks/useSwipeGesture.ts`: drops a drag that turns vertical, a second finger and `touchcancel`; leaves fields, opted-out
  elements and a scroller that has been scrolled sideways alone; no ref write during render. 10 tests (there were none).
- `styles/globals.css`: one import line after `glass-stage-modes.css`.
- Deleted: `components/layout/MobileBottomNav.tsx` and `.test.tsx` (see above).

## How it works

**Navigation state.** `usePhoneNavStore.screen` is `null` until the frame has chosen its first screen (in a layout
effect, before the first paint, so nothing animates into it), then `'places'` or `'conversation'`. Who changes it:

- a tap in the places screen (`PhonePlaces`, one native listener): a row with `data-place-row` in the list opens the
  conversation; a circle in the server row does not, except the current one (`aria-current`); a row that opens a popover
  (Game servers) does not; modified and middle clicks are the browser's;
- `PlacesToggle` (back) and the swipe: places;
- arriving on `/app` or `/app/dms` while somewhere else: places (so the conversation header's old "Back to messages" works);
- the old drawer request: the conversation header's drawer button and Ctrl+B still open `uiStore.sidebarCollapsed`. The drawer
  no longer exists, so `usePhoneNavigation` takes that change, shows places and puts the flag back. The flag is the old
  contract, kept so the header did not have to change.

Any other navigation leaves the screen alone. A notification or the command palette that navigates while places is in
front does not open the conversation (see "Not done").

**The move.** The conversation slides in from the right, places fades out by 70% of the move and steps back 22%;
going back is the same reversed, with places arriving late. The conversation has no surface of its own (it sits on the
room), so places must be gone before the conversation covers it, or its rows would show through. Web Animations, not a
CSS transition, because the global reduced-motion switch zeroes every CSS duration and the spec wants a 150ms crossfade
(measured in the browser: both animations 150ms, opacity only, transforms `none`). After a change, focus goes to `main` (the
conversation) or to the current row (places).

**The conversation screen** is the prototype's stack: the stream card, the pill 10px under it, the header, the messages
straight on the room with a fade under the header, the message box. There is no pane behind a conversation (the pane loses
its fill, shadow, glow and radius through `:has(.glass-conversation)`). The room gets the prototype's dark gradient as
`.glass-phone__scrim`, at about four fifths of its strength because the room canvas is already graded down (§4, brightness
.6 against the prototype's .7). A page that is not a conversation (Home, Friends, a server's overview, the voice channel page)
keeps a pane 12px in, because those pages were drawn for one.

**The stream card.** The stage slot draws the stream, its notices ("Connecting…", "Watch again"), the clip toast and the
reactions, unchanged. Its own phone overlay (a title and a stop button, G14) is hidden by `glass-phone.css` and replaced by
`PhoneStageChrome`, which is what `07` shows: back (Stop watching, you stay in the call), the "30s" clip button (the same
`useClip` and the same refusals as the stage's Clip button: it says why it cannot, it never pretends), full screen, the name
at the bottom left and the eye and "2 watching" at the bottom right. The glow is G14's sampled one, on the card.

**Full screen** is `glassStore.stage.mode === 'theater'` on a phone. The stage pane becomes `position: fixed; inset: 0` (opaque),
the stream keeps its 16:9 in the middle, the chrome moves down to the safe areas, and the stage's own `StageControls` are
mounted in a glass capsule (joined: mic, camera, share, Clip, More, Leave; not joined: Clip, More, mute, Join). Under 370px
the buttons tighten to 38px so the joined row fits at 320. The conversation under it is `inert`. Esc is taken in the capture
phase (the stage's Esc, which stops watching, finds the key taken): the first Esc returns to the card.

**The call.** The conversation screen's pill is the pane's (`CallPill layout="stacked"`, G11/G12). The places screen shows the
same pill above the panel while you hold a call (the job of the old on-air dock, which is gone), mounted only while places is
in front so a page never holds two. A page with no conversation pane (Home, Friends, overview) shows the pill in the row under
its back button. A voice channel page has its own controls and gets none.

**Reactions** rise 90px on the card (`glass-phone-reaction-rise`, the own-reaction burst 100px), 24px in and 40px up, discs 36
and 40px. The stage's 270px rise would have left through the top of a 206px card. Reduced motion is the layer's own (`data-still`).

**Safe areas.** The screens pad with `--safe-top`, `--safe-bottom`, `--safe-left`, `--safe-right` (`tokens.css`, from
`env(safe-area-inset-*)`; `index.html` already has `viewport-fit=cover`). With no inset the stream sits 12px from the top and the
message box 10px from the bottom; with the reference's 47 and 34 they sit at 59 and exactly 34. The shots set the insets in the page
(`withSafeAreas`), because `env()` cannot be set from a test.

## Against `07-phone.png` (390x844, measured in Chromium; the reference's numbers are from its source)

The harness state `phone-07-phone.png` is the reference's state: watching, reply to Jeremy staged, on a device with a notch
(`--safe-top` 47, `--safe-bottom` 34).

| | Reference | Mine |
|---|---|---|
| Stream card | 12,58 366x206, radius 22 | 12,59 366x205.9, radius 22 |
| Call pill | 12,274 366 wide, rows of 44 | 12,274.9 **366** wide (G12 had 350), 109 tall, rows of 44 |
| Header | top 392, 44 tall | top 392.9, 44 tall; "General" 17/600, "Game Night" 13, "6 NEW" kicker |
| Messages | from 442, fade 24px | from 442.9, fade 28px (G10's) |
| Message box | 12,760 366x50 | 12,760 **366x50**; reply chip "Jeremy ×", placeholder "Reply", quiet send |
| Overlays on the card | back, "30s", full screen, "Vincent's screen", "2 watching" | the same five, same places |
| 430x932, 360x780 | | card 406 and 336 wide, pill and message box the same widths; asserted |

Shots are in `output/design-reference/glass-build/g20/` (gitignored; the list is at the end). I read each one with the Read
tool, against the reference for `07`.

## Differences left

1. **Art, not layout.** The mocked scene draws initials where the reference has cartoon faces, the DEV fixture scene where it
   has the cave, and a darker room: the room canvas is G8's and the fixture's average color is dark. Nothing is tuned to the art.
2. **The header has a back chevron, search and members**; the reference has none of them (its back button is on the stream
   card and its search is not drawn). The chevron is how you leave a conversation without the gesture; search and people are
   the brief's ("search/people via header icons"). The title is at x 50, the reference's at 20.
3. **One pixel down.** The card is `safe-top + 12px`; the reference's 58 is 47 + 11.
4. **Full screen is a portrait band**: the stream keeps 16:9 in the middle of the window. A phone held sideways is 844px
   wide, which is the compact frame (G7), not this one. The Fullscreen and orientation APIs are not used.
5. **The stream card's side glow** is G14's sampled color; on the fixture scene it is fainter than the prototype's hand-set
   teal and amber.

## For the other owners (I did not edit these files)

- **`components/glass/conversation/ConversationHeader.tsx` (G11).** The header's phone nav is still the drawer button (and, on
  a message, "Back to messages"). They work: the drawer button opens the places screen through `usePhoneNavigation`, and Back to
  messages goes to `/app/dms`, which shows places. But the button's accessible name is "Expand sidebar", and its glyph is the
  sidebar panel: `glass-phone.css` draws a chevron over it with a CSS mask (`.glass-header__nav[aria-label$='sidebar']`), a stopgap.
  The real change is small: in the phone branch render `<PlacesToggle className="glass-header__btn glass-header__nav" />` for both
  channels and messages, delete `drawerButton`, `backButton`, `useNavigate` and the `sidebarCollapsed` subscription, and delete the
  "header's own drawer button" block in `glass-phone.css`. `PlacesToggle` on a phone is named "Back to places" and needs no route.
- **`styles/glass-layout.css` (G7).** The block "Phone (today's phone frame until WP-G20)" is dead: the three rules on
  `.glass-frame[data-layout='phone']`, `… .glass-pane` and `… .glass-frame__stage`. `glass-phone.css` overrides them with higher
  specificity, so nothing shows; delete them.
- **`styles/glass-conversation.css` (G11).** `.glass-conversation__phone-pill { padding: 8px 8px 0 }` is what made the pill 350;
  `glass-phone.css` sets it to `0 12px`. The original can change to match.
- **`components/glass/stage/Stage.tsx` (G14).** The phone branches of its overlay (title group, the X stop button, the
  `phone ? undefined` labels) are hidden and replaced by `PhoneStageChrome`. G22 can delete them or move the chrome into `stage/`.
- **`hooks/useGlassKeybinds.ts` (G15).** `case 'clip': if (phone) return;` left C alone "until G20". The card has a Clip button
  now, so the guard can go. (A hardware keyboard on a window under 768px is rare.)
- **G22.** `components/voice/OnAirDock.tsx`, `components/layout/sidebar/*` (`UnifiedSidebar`, `CallDock`) have no importer outside
  each other now. `tokens.css` `--h-mobile-nav` and its reads in `components/ui/Toast.tsx` are harmless (0px) and can go.

## Commands (in `client/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 422 files, 4,295 tests (the whole client, other packages' work in progress included) |
| `npx vitest run src/components/glass/shell src/pages/AppShell.test.tsx src/hooks/useSwipeGesture.test.tsx` | pass: 7 files, 86 tests (phoneNav 11, PhoneFrame 22, PhoneStageChrome 14, phoneMotion 5, PlacesToggle 4, swipe 10, AppShell 20 of which 10 are phone tests) |
| `npm run test:tokens` | pass (842 files) |
| `npm run test:motion-lint` | pass, no new allowance |
| `npm run lint` | 0 errors, 250 warnings (the tree's); `npx eslint --max-warnings 0` on every file of mine: clean |
| `npm run test:contrast` | pass (52,950 comparisons) |
| `npm run test:a11y:static` | pass (after I replaced a JSX `onClick` on the places pane with one native listener) |
| `PARACORD_E2E_GLASS_WP=g20 npx playwright test -c e2e/glass-phone.config.ts` | pass, 27 of 27 (own ports 4443/4445) |

Regression runs of other packages' mocked specs, each on its own config and ports, at the same time as this package's tree:

| Spec | Result |
|---|---|
| `glass-theater` (G15) | 9 of 9 |
| `glass-pill` (G12, includes its phone shots) | 12 of 12 |
| `glass-pages` (G19, desktop and phone) | 25 of 25 |
| `glass-longtail` (G21, desktop and phone) | 19 of 19 |
| `glass-room` (G8) | 6 of 6 |
| `glass-stage` (G14) | 7 of 8. Its phone tests needed one fix of mine (below) and now pass; "the conversation keeps working beside the stage" fails on `main`'s width (940 against 420) |
| `glass-sheets` (G18) | 13 of 14. "a sheet fits the conversation beside a stream" is off by one pixel in x |

The two failures are desktop tests at 1440 that measure a pane 500 and 900ms after opening a stage. G15's pill-to-stage move
takes 650ms and plays on transforms, so they measure mid-move. I did not check them on a clean `HEAD`, but nothing in this package
touches the desktop frame (`GlassFrame`'s wide and compact paths, and every selector in `glass-phone.css`, are phone-only), and a
throwaway run that waited 900ms before measuring got equal rects. They are for whoever owns those specs.

The fix of mine that the stage spec needed: with a call held, the places screen's pill and the conversation's pill were both
mounted, so `getByRole('region', …).first()` found the inert one. The places pill is now mounted only while places is in front (and
for the length of its leave).

## Screenshots (`output/design-reference/glass-build/g20/`, `phone-*.png`, 390x844 unless noted)

- `phone-07-phone.png` against `screens/07-phone.png`; `phone-07-conversation.png` (no stream), `phone-07-conversation-flat.png`
  (no safe areas), `phone-watching.png`.
- Places: `phone-places.png`, `phone-places-call.png` (a call held: the pill above it), `phone-home-places.png`,
  `phone-account-menu.png`.
- Pages: `phone-home-page.png`, `phone-friends.png`, `phone-friends-call.png`, `phone-dm.png`, `phone-overview.png`,
  `phone-voice-channel.png`.
- Watching: `phone-watch-connecting.png`, `phone-watch-failed.png`, `phone-live-row-watch.png` (from the live row on places),
  `phone-reaction.png`.
- Full screen: `phone-theater-joined.png`, `phone-theater-not-joined.png`.
- A sheet: `phone-sheet-search.png`, `phone-sheet-people.png`. The move: `phone-slide-30ms.png`.
- Other sizes: `phone-{conversation,watching,fullscreen,places,home-places}-{430,360}.png` (430x932, 360x780),
  `phone-{conversation,fullscreen,places}-320.png` (320x640).
- Tablet: `phone-tablet-768.png` (768x1024, the compact frame).
- `phone-rects.json`: every measured box.

## Not done, or uncertain

- **Hardware back.** Android's back and the browser's back go to the previous route. A conversation reached from places goes
  back to the previous conversation, not to the list. Making places a history entry needs care with the router's own history state;
  I did not attempt it. The header chevron and the edge swipe are the ways back.
- **The swipe is a threshold gesture** (a swipe of 60px from the edge, then the 360ms move), not a drag that follows the finger.
- **A navigation that is not a tap** (a notification, the command palette, an accepted call) while places is in front changes
  the route and leaves places showing. The alternative is to treat any route change as a pick, which would throw a server tap's
  landing channel at you. The list is the one place that knows which it was.
- **Landscape phones under 768px wide** get the card capped at half the window's height; nothing else was designed for them.
- **The on-screen keyboard** is not handled (the shell is `100dvh`, as before).
- **Not run on a device, in Tauri mobile or in WebKit.** Chromium only. The CSS uses `:has()`, `inert`, `dvh` and the individual
  `translate` property, all of which G7 through G15 already depend on.
- **`aria-label$='sidebar'`** in `glass-phone.css` is a selector on another component's text; it goes with the stopgap above.
- Processes: everything I started (the Playwright dev servers and the realtime stub on 4443/4445, and on the regression runs'
  ports) exits with its run. Nothing is left running.
