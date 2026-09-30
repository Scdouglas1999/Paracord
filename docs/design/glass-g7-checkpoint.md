# WP-G7 checkpoint: the Glass frame (shell)

Contract: `docs/glass-spec.md` §1.6, §3, §6, §9. Plan: `docs/design/glass-plan.md` §1.1,
§1.2, the WP-G7 row in §4, §8. Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

The Lantern shell is gone. The app now renders two floating panes on a room backdrop:
places (316px) and the conversation, 16px from the window and from each other, radius
28, full height. Geometry follows `glassStore` (stage side by side / theater, browse,
hidden chat, the places overlay below 860px). What fills each pane is a **slot** with a
fixed props type; every slot is a stub today that renders the existing component, so
the app stays fully usable while later packages replace one slot each.

## The slot contract (what later packages must follow)

Types live in `client/src/components/glass/shell/slots.ts`. Each slot is exported from
`client/src/components/glass/<slot>/index.ts`, which today re-exports a stub from
`components/glass/shell/stubs/`. **To take a slot over, replace the re-export in your
`index.ts` with your own component of the same props type, and delete the stub file
and the adapter block in `styles/glass-layout.css` named after it.** The shell paints
every pane surface (`glass-pane`: radius, `--pane`/`--deep` fill, shadow, glow) and
sizes it; a slot fills it and never sets its own outer size, radius or position.

| Slot (export) | Owner | Props | Mounted by, where | Stub renders today |
|---|---|---|---|---|
| `RoomBackdrop` (`glass/room`) | G8 | `{ guildId: string \| null }`: the route's server, null on Home/DMs | `GlassFrame`, first child, `position: fixed`, z-index -1 inside the isolated shell | A CSS gradient of `--room-rgb` over `--street`. Must keep `data-native-underlay-clear` (Linux native video) |
| `PlacesPanel` (`glass/places`) | G9 | `{ presentation: 'pane' \| 'overlay' \| 'browse'; onClose?: () => void }` (`onClose` for overlay and browse) | `GlassFrame` inside `.glass-frame__places` (the permanent pane, and browse); `PlacesOverlay` inside `.glass-places-overlay__pane` | Lantern `UnifiedSidebar alwaysExpanded` (servers, rooms, call dock, account plate) |
| `ConversationPane` (`glass/conversation`) | G11 (G10 restyles the timeline in place) | `{ subject: ConversationSubject; notices?; timeline; composer?; dock? }` (see below) | `GuildPage` (forum), `TextChannelView` (text, threads), `DMPage` (DM conversation), inside the shell's `<main>` pane | Regions with final geometry; header = Lantern `TopBar` built from `subject`, fitted by adapters |
| `CallPill` (`glass/pill`) | G12 | `{ guildId: string \| null; layout: 'row' \| 'stacked' }` | The conversation header (the stub mounts it after the title, where §3.2 puts it) | `null`. Call controls stay in the places panel's call dock (desktop), the on-air dock (phone) and the voice page |
| `Stage` (`glass/stage`) | G14, G15 | `{ target: StageTarget; mode: 'side' \| 'theater' }` | `GlassFrame` inside `section.glass-frame__stage` (aria-label "Stage", `--deep`) while `glassStore.stage.mode !== 'none'` | Lantern `StreamViewer` for `target.streamerId`, "Stop watching" = `closeStage`. Only shows a picture while joined to that call (watching without joining is G6) |
| `Sheets` (`glass/sheets`) | G18 | `{ guildId; channelId; layout: GlassLayout }` | `GlassFrame`, last flex child after the conversation (wide, compact); over the window (phone). Renders nothing when closed | Lantern `ContextPanel` (search, pins, threads, media, economy, group-DM people), driven by `uiStore.contextPanelMode`: a third floating pane on desktop, today's overlay on phone. It also owns the mode's route validity and the command palette's `openSearch` hand-off |

`ConversationSubject` (the header renders from data, so G11 changes the header without
touching the pages, which are outside its scope):

```ts
| { kind: 'channel'; guildId: string; guildName?: string; channelId: string;
    channelName: string; topic?: string | null; isForum?: boolean }
| { kind: 'dm'; channelId: string; title: string; isGroup: boolean }
```

`notices` are strips between header and timeline (thread origin, welcome and onboarding
gates, the pinned sports score, a DM call's stream). `dock` is a DM call's control bar
until the pill carries it. The regions are `.glass-conversation__header` (76px min,
`z-index: 2`), `__notices`, `__timeline` (flex 1, full pane width; rows sit in the
column), `__composer`. G11 should keep those class names or replace the region CSS in
`glass-layout.css` with its own.

Other shell exports (`components/glass/shell/index.ts`): `GlassFrame`, `PlacesOverlay`,
`PlacesToggle` (the header button that opens places below 860px; renders nothing on
wide and phone; G11's header must include it first in its row), `useGlassLayout()` →
`'wide' | 'compact' | 'phone'` (≥ 860 / 768-859 / < 768, the phone edge is the app's
existing `useMobile` breakpoint), `PLACES_OVERLAY_MAX_WIDTH = 860`.

### Column geometry (CSS, `styles/glass-layout.css`)

Variables on `.glass-shell`: `--glass-gutter` 16px, `--glass-places-w` 316px,
`--glass-column-w` 720px, `--glass-column-pad` 28px, `--glass-header-h` 76px,
`--glass-side-chat-w` 420px, `--glass-theater-chat-w` 380px, and
`--glass-column-inset: max(28px, calc((100% - 720px) / 2))`, the prototype's own formula.
The `100%` resolves where the variable is used, so use it only in padding or insets of
an element whose containing block is the full pane width (header row, timeline scroller,
composer region). No container queries: `container-type` would make the pane a containing
block for `position: fixed` descendants and break every in-pane anchored menu.

## glassStore API (`client/src/stores/glassStore.ts`)

Zustand, no persistence (a reload starts in the conversation), reset on sign-out via
`registerSessionReset('glass-layout')`.

```ts
type StageMode = 'none' | 'side' | 'theater';
type OpenStageMode = 'side' | 'theater';
interface StageTarget { guildId: string; channelId: string; streamerId: string }
state: {
  stage: { mode: StageMode; guildId; channelId; streamerId }  // ids null when mode is 'none'
  browseOpen: boolean; chatHidden: boolean; pillExpanded: boolean;
  placesOverlayOpen: boolean;
  sheet: null | 'search' | 'people' | 'account' | 'channel' | 'server';
}
openStage(target, mode?)   // fresh stage: 'side' unless mode given; switching streams keeps the mode
closeStage()               // clears browse and hidden chat; never touches voiceStore
setStageMode(mode)         // ignored with no stage; leaving theater shows the chat again
toggleBrowse() / setBrowseOpen(open)        // only while a stage is open
toggleChatHidden() / setChatHidden(hidden)  // only in theater
setPillExpanded(v); setPlacesOverlayOpen(v); openSheet(s); closeSheet(); reset()
selectStageOpen(state) → boolean
```

These are the plan's §1.2 names. The brief's shorthand maps as: `setMode` = `setStageMode`,
`toggleChat` = `toggleChatHidden`. Invariants and every guard are unit-tested
(`glassStore.test.ts`, 10 tests). The frame closes the places overlay and browse on any
route change (§3, §6.3: "picking a channel or server closes the panel"), and the overlay
when the window leaves the compact width.

Open question for G6/G14: `StageTarget` has no server/account scope. Snowflakes are per
server; with several servers connected a guild id alone may be ambiguous. The plan's
contract has none either, so I kept it; if G6's `openView` needs a scope, add
`serverId` to `StageTarget` in both places at once.

## Frame by layout and mode (measured in Chromium, DOM rects)

| State (window) | Places | Stage | Conversation |
|---|---|---|---|
| Wide, nothing on stage (1440x900) | 16,16 316x868 r28 | none | 348,16 1076x868 r28; header title group at x 526; composer capsule 526 to 1246 (720) |
| Wide (1024x768) | 16,16 316x736 | none | 348,16 660x736; column fluid |
| Compact (820x768) | overlay 16,16 316x736 on a scrim, from the header button | none | 16,16 788x736 |
| Side by side (1440x900) | hidden | 16,16 972x868 r28 `--deep` | 1004,16 420x868 |
| Side + browse | 16,16 316x868 | 348,16 1076x868 | stepped aside: x 1440, opacity 0, inert, still mounted |
| Theater | hidden (floats over the stream's left edge when browsing) | 0,0 1440x900 r0 | 1044,16 380x868 `--deep` |
| Theater + chat hidden | hidden | 0,0 1440x900 | x 1440, opacity 0, inert |
| Phone (390x844) | Lantern drawer (unchanged) | stacked above when open | 12,12 366x771 r22, bottom bar under it |

These match the prototype's numbers (`output/design-reference/glass/source/GlassV14*.dc.html`:
side stage L16 W972, browse L348 W1076, theater chat L1044 W380) and the reference renders
01 and 02 (panes, gutters, radius, the 720px column at 526 to 1246).

## Files

New:
- `client/src/stores/glassStore.ts`, `glassStore.test.ts`
- `client/src/components/glass/shell/`: `GlassFrame.tsx`, `PlacesOverlay.tsx`, `PlacesToggle.tsx`,
  `useGlassLayout.ts`, `slots.ts`, `index.ts`, `stubs/{RoomBackdropStub,PlacesPanelStub,ConversationPaneStub,CallPillStub,StageStub,SheetsStub}.tsx`
- `client/src/components/glass/{room,places,conversation,pill,stage,sheets}/index.ts` (stub re-exports; owned by the next packages)
- `client/src/styles/glass-layout.css`

Changed:
- `client/src/pages/AppShell.tsx`: rewritten around `GlassFrame`. Keeps navigation registration,
  keyboard shortcuts, the deep-link settings param, relationships priming, the settings dialogs and
  their focus traps, command palette, confirm and interaction hosts, `LayoutTour`, `MotionDirector`,
  `TogetherHost`, the skip link, and the whole phone path (drawer, swipe, bottom bar, on-air dock).
  The ContextPanel hosting moved into the sheets stub.
- `client/src/pages/GuildPage.tsx`: text channels go through `TextChannelView`, forums through
  `ConversationPane`; the page no longer builds a `TopBar` or its own gutter/plate. Voice and stage
  channels keep `VoiceStageChannel` (with the welcome/onboarding gates) inside the pane.
- `client/src/pages/guild/TextChannelView.tsx`: renders `ConversationPane` (new props `subject`, `notices`).
- `client/src/pages/DMPage.tsx` (frame only): the conversation renders `ConversationPane`; the index
  list lost its gutter/plate wrapper (the pane is its surface). No behavior change.
- `client/src/styles/globals.css`: one import line for `glass-layout.css`, unlayered after
  `layout.css` (the plan names no place; G0's precedent is this file). Its adapters must beat the
  utility layer on Lantern components.
- Tests: `pages/AppShell.test.tsx` (rewritten: 12 tests covering both panes, compact overlay and its
  button, route change and resize closing it, side by side, browse, theater and hidden chat, plus the
  kept phone, context panel and settings cases), `pages/guild/TextChannelView.test.tsx` (subject prop,
  a regions test), `pages/GuildPage.test.tsx` (the TextChannelView mock renders `notices`).

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run --exclude '**/DailyWordView.test.tsx'` | pass: 352 files, 3,314 tests. `DailyWordView.test.tsx` is excluded because it hangs on a clean `HEAD` too (noted by G0), not because of this package |
| touched tests (`AppShell`, `GuildPage`, `TextChannelView`, `DMPage`, `glassStore`, `components/glass`) | pass, 75 tests |
| `npm run test:tokens` | pass |
| `npm run test:motion-lint` | pass (panes and the overlay move with transform and opacity only) |
| `npm run lint` | 0 errors, 241 warnings (the same count as before; the five in touched files are pre-existing patterns carried over) |
| `npm run test:a11y:static` | pass |
| `npm run test:contrast` | pass |
| `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g7 npx playwright test e2e/glass-review.spec.ts` | pass, 15/15 |
| `npx playwright test` (default mocked projects) | see "E2E" below |

## Screenshots (`output/design-reference/glass-build/g7/`)

Harness states: `01-conversation-{desktop,phone}.png` … `07-phone-*.png` (1440x900, 390x844).
Extra shots from a throwaway spec (deleted after the run), with a `.json` of DOM rects beside each:
`g7-conversation-{1440x900,1024x768,820x768,390x844}.png`, `g7-quiet-1024x768.png`,
`g7-compact-overlay-820x768.png`, `g7-compact-home-820x768.png`, `g7-stage-side-1440x900.png`,
`g7-stage-browse-1440x900.png`, `g7-stage-theater-1440x900.png`, `g7-stage-theater-hidden-1440x900.png`,
`g7-sheet-pins-1440x900.png`.

Against `screens/01-conversation.png` and `02-quiet.png`: pane positions, 16px gutters, radius 28,
full height, the conversation column (composer capsule exactly 526 to 1246), messages bottom-anchored
in the column, the header row 76px, search/pins/threads/more at the pane's right edge, the room
showing warm around both panes. Differences, all inside slots:

- The header is Lantern's `TopBar`: its "window" dot sits at x 526 and the title text starts at 542,
  not 526; the here-now strip sits where the call pill goes; there is no avatar at the right edge
  (G11, G12).
- Places is the Lantern sidebar (search field, Home/Messages, building sections, account plate at the
  foot), not the server row + server title + channel rows (G9).
- Message rows are Lantern rows (names in author color, no bubbles, the mention row's highlight runs
  past the column) (G10, G13). Each row keeps its own 32px gutter, so at pane widths under 784px the
  column inset reads 32px rather than 28px.
- The composer is the Lantern composer with its toolbar, not the 52px capsule (G11).
- The room is a static two-pool gradient in the room color, not the sampled stream (G8).
- 02 shows the same warm default room: nothing writes `--room-rgb` yet (G8).
- In side by side the Lantern TopBar wraps to two rows at 420px (G11).

## Kept, moved or changed on purpose

- **Phone** (< 768px) keeps today's behavior: the drawer (`sidebarCollapsed`), swipe to open, bottom
  bar, on-air dock, the details overlay. Its pane now comes from the frame (12px gutter, 22px radius,
  the same look as before). G20 replaces it.
- **Places never collapses on the wide frame.** `sidebarCollapsed`, the TopBar's collapse button and
  Ctrl+B have no effect there (the button is hidden on wide and compact by an adapter; the phone keeps
  it). The spec has no collapsed rail; S (browse) is G15's.
- **Compact** (768 to 859px): places opens from a button in the conversation header, or from a row
  the frame adds to the top of the pane for pages without a conversation header (Home, Friends, server
  home, the voice page, settings), hidden by `:has()` when a header is present. Focus-trapped, Escape
  and the scrim close it, and so does picking any route.
- **ContextPanel** is a third floating pane after the conversation (16px gap, radius 28, full height)
  instead of a docked plate. Not the Glass design (G18 puts sheets over the column); it keeps search,
  pins, threads, media, economy and group-DM people fully usable meanwhile.
- **Lantern pages inside the pane** (Home, Friends, server home, sports, daily word, admin) still wrap
  themselves in street + gutter + plate. Inside the pane the street goes clear and plates go flat
  (`.glass-outlet { --color-bg-base: transparent; --shadow-plate: none }`), so the pane is the only
  surface. This is an adapter; G19/G21 rebuild those pages.
- **Stacking:** the shell is `isolation: isolate` and the room sits at z-index -1 inside it (the phone's
  in-flow bottom bar was painted over by the backdrop before this). The frame makes no stacking
  context, so an overlay a page renders in place stacks as before.
- **Native video underlay (Linux):** shell, frame, conversation pane, stage pane and backdrop all carry
  `data-native-underlay-clear`.

## Transitional adapters (all in `styles/glass-layout.css`, keyed to stubs)

| Block | Fits | Delete with |
|---|---|---|
| `.glass-outlet` | Lantern page wrappers inside the pane | G19/G21, finally G22 |
| `.glass-stub-places …` | `UnifiedSidebar` to 100% of the pane, no street, no padding | G9 |
| `.glass-stub-conversation …` | TopBar title at the column edge, actions 16px from the pane edge, 76px, no rule, collapse button hidden; timeline and composer insets minus their own 32px gutters; notices inset | G11 (header, composer), G10 (timeline) |
| `.glass-stub-sheet` | `ContextPanel`'s own gutter to 0 | G18 |
| `.glass-stub-stage` | `StreamViewer` fills the stage | G14 |

## Not done, or left for others

- **No layout transitions.** Panes jump between modes (only the places overlay and the stepped-aside
  conversation move, with transform and opacity). The 650ms pill-to-stage and browse moves are G15's.
  Reduced motion is the global `data-motion` switch, which zeroes durations (the spec's 150ms
  crossfade needs a named exception in utilities.css; G15).
- **Nothing opens the stage yet.** Watch lives on the pill (G12) and the live row (G9). The stage stub
  only shows a picture when you are in that call.
- **Keys S, T, H, C, Esc** are not bound (G15, `useGlassKeybinds`). The store actions they call exist.
- **`glassStore.sheet`** is declared but nothing renders it; the sheets stub still reads
  `uiStore.contextPanelMode` (G18 switches).
- **`pillExpanded`** is state only (G12).
- **`LayoutTour`** is still mounted and points at Lantern anchors that mostly still exist inside the
  stubs; G22 retires it.
- **Theater on the phone and stage on the compact frame** are laid out simply (stage stacked on top;
  compact side by side squeezes the stage beside a 420px chat). G14/G20 decide.
- The spec says the column turns fluid below a 1100px window; the prototype's `max()` formula (kept)
  turns it fluid when the pane is under 776px, i.e. below a 1140px window on the wide frame, so it
  never has less than 28px of side room.

## E2E

`npx playwright test` (default mocked projects): **90 passed, 2 failed**. Both failures are
the same test, `smoke.spec.ts` "login -> guild -> message -> voice smoke flow" (chromium
and chromium-touch), at line 685: after the role is revoked, the composer's "Message tools"
menu at 390x800 ends at y 1098 in an 800px window.

Cause: a latent bug in `client/src/components/ui/ContextMenu.tsx` (outside this package's
scope, so not edited). Its placement `useLayoutEffect` depends on `[anchor.x, anchor.y,
anchorRef]` but not on `mounted`, so when a menu is reopened at exactly the same anchor it
never measures again: it keeps the position from the previous open (a shorter menu), writes
no `max-height`, and its `ResizeObserver` is still attached to the old, unmounted node. The
new frame puts the composer's button at the same spot for both opens in that test; on the
Lantern frame the two anchors differed by chance. Verified in a throwaway worktree of `HEAD`:
the test passes on `HEAD`, fails on `HEAD` + this package, and passes on `HEAD` + this package
+ the fix:

```diff
-  }, [anchor.x, anchor.y, anchorRef]);
+  }, [anchor.x, anchor.y, anchorRef, mounted]);
```

(`client/src/components/ui/ContextMenu.tsx`, the placement effect ending near line 92.)
The owner of `components/ui` (WP-G21) or the orchestrator should apply it; it affects every
context menu reopened in place, not only this test.
