# WP-G18 checkpoint: sheets and menus

Contract: `docs/glass-spec.md` §1 (content is solid, controls are glass), §2, §3.2 ("search, people and your
avatar sit at the pane's right edge"), §5 (popovers over text are near-solid, `.97`), §9. Plan:
`docs/design/glass-plan.md` §1.1, §1.3, the WP-G18 row in §4, §8. Checkpoints read: G7 (the Sheets slot), G11
(the header and `sheetBridge`), G21 (the primitives). Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

The Sheets slot is real. The G7 stub, which drew the Lantern `ContextPanel` as a third floating pane, is deleted
with its adapter block. Search, people, the channel's pages (catch-up summary, pins, threads, follows, media,
leaderboard, notifications), reminders, inbox and shortcuts are sheets that slide over the conversation pane. Your
face opens an account menu. A thread is a pushed conversation.

## What a sheet is

A sheet is a **solid pane that covers the conversation pane**, not a third pane. It is a portal into
`main#main-content`, absolutely filling it, so its geometry is the pane's in every layout (measured, below). The
pane's radius is inherited (`border-radius: inherit`), the fill is `--solid` (opaque, tinted by the room), and it
carries the same faint far-corner `--glow` as a pane. The header (76px, like the conversation's) replaces the
conversation's header for as long as the sheet is open:

| Part | Where |
|---|---|
| Title (20/600) and a line under it (13, ink-2) | the column's left edge (x 526 at 1440) |
| Close button (40px, quiet) | the pane's right edge, 16px in, where the search button was (center x 1388) |
| Back button (a pushed page only) | hangs 8px into the margin so the title still starts on the column edge |
| Body | the 720px column (`--glass-column-inset`), a scroller for lists, or a flex column for a conversation |
| Phone | full screen over the bottom bar (`position: fixed`, z 55, below modals at 60), 56px header, safe-area padding |

Content in a sheet is solid and has no outline: rows are transparent with a wash on hover and `--sel` for the
current one, cards are `--bub` at radius 20, lead tiles are `--bub` at 12. Only what you press is glass: the search
field, the tab strips, the buttons. Menus are the near-solid popover (`.pc-floating`, G21's), not restyled here.
Presence is ink (a dot, a ring, a dot with a bar, a faint ring), amber appears only for someone in a live voice
channel, and the one danger ink is used for errors only.

Motion: the sheet slides in 28px and fades in `--duration-slow` on `--ease-out`, leaves in `--duration-exit-slow`
on `--ease-in` (transform and opacity only; reduced motion lands it in place through the global switch).

Keyboard: Escape closes, focus moves into the sheet (to the field for search, else the first control), Tab stays
inside (the shared `useFocusTrap`), and focus returns to what opened it (below).

### Measured (Chromium, DOM rects, `e2e/glass-sheets.spec.ts` asserts each)

| Window | Pane | Sheet |
|---|---|---|
| 1440x900 | 348,16 1076x868 | the same rect |
| 1024x768 | the fluid pane | the same rect |
| 820x768 (compact) | 16,16 788x736 | the same rect |
| 1440x900, watching (side by side) | 1004,16 420x868 | the same rect: the sheet fits the 420px chat pane |

## The state model

`glassStore.sheet` says which sheet is open (`search`, `people`, `channel`, `account`; `server` is unused, below).
Two sheets have pages, and `glassStore.ts` is not mine, so the page lives in `sheets/sheetStore.ts`
(`useSheetPages`): `channelPage` (`summary | pins | threads | follows | media | leaderboard | notifications`),
`threadId` (a thread pushed over the Threads page) and `accountPage` (`reminders`). Pages reset whenever the sheet
changes, so a sheet always opens at its first page.

Helpers (exported from `components/glass/sheets`): `toggleSheet(sheet)`, `toggleChannelSheet(page)`,
`openChannelSheet(page)`, `openReminders()`, `closeSheets()`. Asking for the page that is showing closes it (the
header's buttons are toggles).

**Older callers.** The command palette, Mod+F, the server home's Media and Leaderboard buttons and the DM page still
set `uiStore.contextPanelMode`. The slot turns that request into a sheet and clears it, so none of them broke, and
none of them had to be edited (they are other packages' files). `useKeyboardNavigation`'s Escape handler already
defers to `[role="dialog"][aria-modal="true"]`, which every sheet is.

**A sheet closes when the conversation under it changes** (picking a channel in places), because a sheet left over
the pane would hide the very thing that was picked. Pages adapt while it stays. A sheet with nothing to be about (a
route with no server or channel) closes. On a phone, opening a sheet folds the navigation drawer away.

## What opens what

| Door | Call | Opens |
|---|---|---|
| Header search | `toggleSheet('search')` | the search sheet (scope chip, filter chips, recent searches, the filter guide, results by channel) |
| Header members | `toggleSheet('people')` | a server's members (here now first, presence, activity or custom status, "In Lounge" in amber, a profile on press); a group message's recipients (add, remove, leave); the two of a 1:1 |
| Header face | `toggleSheet('account')` | the account menu, a popover (below) |
| Channel menu > Pinned messages, Threads, Media, Server leaderboard | `toggleContextPanel(...)` in `sheetBridge` | the channel sheet on that page |
| Channel menu > Catch up summary, Manage follows | (`useChannelMenu`, see the handover) | today the restyled dialogs as overlay sheets; after the patch, the summary and follows pages |
| Channel menu > Inbox, Keyboard shortcuts | (`useChannelMenu`) | overlay sheets (`TopBarOverlay` renders a sheet now) |
| Account menu > Reminders | `openReminders()` | the reminders sheet |
| Tabs inside the channel sheet | `useSheetPages.setChannelPage` | Catch up, Pins, Threads, Follows (announcement channels), Media, Leaderboard, Notifications |

Pages by place: a text channel has all but Follows; an announcement channel adds Follows; a direct message has
Catch up, Pins and Media; a server page with no channel (opened from the server home) has Media and Leaderboard.

**Threads.** The Threads page lists the room's threads (newest first, archived last, the thread you are standing in
marked). Picking one **pushes** it: the sheet's title becomes the thread's, a back button appears, the page tabs go
away, and the body is the thread as a conversation (the same `MessageList` and `MessageInput`, in the same column,
with the same 52px capsule 20px above the bottom edge). Back pops to the list. Picking the thread you are already
in closes the sheet instead of drawing a second copy of it. Deleting a pushed thread returns to the list
(`ThreadPanel` got `onDeleted`).

**The account menu** (a popover under your face, `.pc-floating`, arrow keys walk the rows): who you are and what
you are set to; Status as four radios (Online, Away, Do not disturb, Invisible) with the one in force checked;
Custom status (Enter or the check); Reminders; Settings; Copy username; Admin dashboard (admins only); Developer
portal; Sign out. Escape puts it away and focus returns to your face.

## Files

New (`client/src/components/glass/sheets/`): `Sheets.tsx` (the slot), `SheetFrame.tsx`, `SheetParts.tsx`,
`sheetStore.ts`, `whenLabel.ts`, `PersonRow.tsx`, `PeopleSheet.tsx`, `ChannelSheet.tsx`, `ThreadsPage.tsx`,
`SummaryPage.tsx`, `FollowsPage.tsx`, `NotificationsPage.tsx`, `RemindersSheet.tsx`, `AccountMenu.tsx`; tests for
each (`sheetStore`, `SheetFrame`, `Sheets`, `PeopleSheet`, `ChannelSheet` (which covers the threads, summary and
follows pages), `NotificationsPage`, `RemindersSheet`, `AccountMenu`); `index.ts` is the real export now. New too:
`layout/overlays/PinnedMessagesOverlay.test.tsx`. Added to existing suites: `SearchOverlay` (focus in the field,
Escape, Tab kept inside, the filter guide), `GroupDmMembersPanel` (presence words, "(you)", Leave group),
`ThreadPanel` (`onDeleted`).

New: `client/src/styles/glass-sheets.css` (imported in `styles/globals.css`, unlayered, after the conversation css);
`client/e2e/glass-sheets.spec.ts`, `glass-sheets.config.ts` (ports 4383 and 4385) and `glass-sheets-dev.mjs`.

Restyled in place, logic unchanged: `layout/overlays/SearchOverlay.tsx` (now renders its own `SheetFrame`),
`PinnedMessagesOverlay.tsx` (the page: cards, unpin on hover and focus), `InboxOverlay.tsx`, `RemindersPane.tsx`,
`HelpOverlay.tsx`; `TopBarOverlay.tsx` (renders a sheet, so the header's summary, follows, inbox and shortcuts
dialogs are sheets); `message/ThreadPanel.tsx` (the pushed thread's body); `media/MediaGalleryPanel.tsx`;
`layout/GroupDmMembersPanel.tsx`; `guild/GuildEconomyPanel.tsx` (classes only). These are the pages' bodies now:
the frame supplies the title and the close button. Each keeps its old props (some now unused) so the orphaned
`ContextPanel.tsx` still compiles.

Deleted: `components/glass/shell/stubs/SheetsStub.tsx`; the `.glass-stub-sheet` block and the `.glass-frame__sheet`
rule in `styles/glass-layout.css`.

Edited outside my scope, each the test-side half of replacing the stub or of the restyle (as G21 did), and small:

- `pages/AppShell.test.tsx`: it mocked `ContextPanel` for the stub; it mocks the sheets slot now, and two tests
  about the stub's ContextPanel became one about the slot's mount (after the pane, with the route's ids).
- `components/glass/conversation/ConversationPane.test.tsx`: four tests asserted the bridge driving `uiStore`
  (search, pins, the group's recipients, and that the face opened settings); they assert the store-only behavior now.
- `components/layout/TopBar.inbox.test.tsx`: the inbox row no longer says `#random` (the sheet drops the `#`), and
  the query is scoped to the inbox dialog.

## The `sheetBridge.ts` removal (exactly)

`components/glass/conversation/sheetBridge.ts` was the header's door to two things at once: `glassStore` (the
contract) and the Lantern panel through `uiStore`. Removed:

- the `useUIStore` import and every read and write of it: `contextPanelMode`, `setContextPanelMode`,
  `toggleContextPanelMode` and `userSettingsOpen` / `setUserSettingsOpen(true)`;
- `panelModeFor()` (the map from a sheet to a ContextPanel mode) and the `isGroupDm` branch it served;
- the account behavior "the face opens user settings" (settings is a row of the account menu now).

Kept, so `ConversationHeader.tsx`, `HeaderAvatar.tsx` and `useChannelMenu.tsx` compile and behave unchanged:
`HeaderSheet`, `HeaderSheetContext` (its `isGroupDm` is accepted and ignored: the people sheet chooses what to show
from the conversation it is over), `useHeaderSheetOpen`, `toggleHeaderSheet` and `toggleContextPanel`. All three
now only talk to the store:

```ts
export function useHeaderSheetOpen(sheet: HeaderSheet, _context: HeaderSheetContext = {}): boolean {
  return useGlassStore((s) => s.sheet === sheet);
}
export function toggleHeaderSheet(sheet: HeaderSheet, _context: HeaderSheetContext = {}): void {
  toggleSheet(sheet);
}
// 'economy' is the leaderboard's older name; the type also takes the new page names.
export function toggleContextPanel(mode: Exclude<ContextPanelMode, null> | ChannelSheetPage): void { /* toggleChannelSheet(page) */ }
```

## Handover: what the orchestrator should apply to G11's files

The channel menu's rows for **Catch up summary** and **Manage follows** still open the dialogs that live inside
`useChannelMenu.tsx` (as overlay sheets now, so they look right, but their contents are Lantern: a monospace
`<pre>`, cream Follow buttons). There is **no Notifications row**, so that page is reachable only from the tabs
inside another channel page. And the face's `aria-haspopup` says `dialog` for what is now a menu. I was told to edit
only `sheetBridge.ts` in that folder, so I did not touch these; the fix is ready and verified.

**`output/design-reference/glass-build/g18/g18-channel-menu-handover.patch`** (`git apply` it from the worktree
root; `git apply --check` passes on the current tree). It:

- `useChannelMenu.tsx`: the summary row calls `panel('summary')`, the follows row `panel('follows')`, and a new
  **Notifications** row (server channels) calls `panel('notifications')`; the leaderboard row uses `'leaderboard'`.
  The two dialogs, their state (`showSummary`, `showFollowManager`, the summary and follows fetching, the two
  focus traps and refs) and the `TopBarOverlay` import go (about 200 lines out). `prepareSurface` closes sheets
  through `closeSheets()` instead of clearing `uiStore.contextPanelMode`. Inbox and shortcuts stay as they are.
- `ConversationPane.test.tsx`: the menu has eight rows, and `Notifications` is one.
- `HeaderAvatar.tsx`: `aria-haspopup="menu"`.

I checked it on a scratch copy of `client/` (node_modules linked, the real tree untouched): `tsc` is clean and
`src/components/glass/conversation` passes, 30 tests. I did not screenshot the patched menu: the pages it opens are
the ones `e2e/glass-sheets.spec.ts` reaches through the tabs and through `toggleContextPanel`, and the dialog names
the spec waits on ("Catch up summary") are the same before and after.

## Commands

Run in `~/Documents/Paracord-glass/client`, on a shared box while other packages edited.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 387 files, 3,869 tests |
| `npx vitest run src/components/glass/sheets` | pass: 8 files, 110 tests, all new |
| suites I updated: `SearchOverlay`, `GroupDmMembersPanel`, `ThreadPanel`, `ConversationPane`, `AppShell`, `TopBar.inbox` | pass |
| `npm run test:tokens` | pass |
| `npm run test:motion-lint` | pass |
| `npm run test:contrast` | pass (40,242 comparisons; no new tokens) |
| `npm run test:a11y:static` | pass |
| `npm run lint` | 0 errors. 254 warnings repo-wide; none in `components/glass/sheets` or my e2e files. In files I edited, the only warnings are the `react-hooks/set-state-in-effect` and `refs` ones the moved code already had (`SearchOverlay` 6, `GroupDmMembersPanel`, `RemindersPane`, `MediaGalleryPanel`, `ThreadPanel` 1 each) |
| `PARACORD_E2E_GLASS_WP=g18 npx playwright test -c e2e/glass-sheets.config.ts` | pass, 14/14 (below) |
| `glass-review.spec.ts` through my config (G2's harness) | pass, 15/15 |
| the patch on a scratch copy | `tsc` clean, `glass/conversation` 30/30 |

**Dev server.** Vite died mid-run several times here (`ERR_CONNECTION_REFUSED` after a few tests) while other
checkouts were running, so `glass-sheets.config.ts` starts Vite through its API (`e2e/glass-sheets-dev.mjs`, a
process that is not named "vite"), and `PARACORD_E2E_SH_REUSE=1` reuses servers you start yourself. Runs are
reliable when the servers are started by hand and reused (start `node e2e/glass-sheets-dev.mjs 4383` with
`VITE_DEV_PROXY_TARGET=http://127.0.0.1:4385 VITE_DEV_HMR=false`, and `PARACORD_E2E_RT_PORT=4385 node
e2e/realtime-stub.mjs`). Do not `pkill -f vite` or `-f realtime-stub`: they match other agents' servers and your own
command line.

## Screenshots (`output/design-reference/glass-build/g18/`, 1440x900 `-desktop` and 390x844 `-phone`)

Every one was opened with the Read tool.

- Search: `search-empty`, `search-results`, `search-filters` (both sizes); `search-1440x900`, `search-1024x768`,
  `search-820x768` (desktop); `search-beside-stage` (the 420px pane).
- People: `people` (both), `people-dm`, `people-beside-stage` (desktop).
- Channel menu and pages: `channel-menu`, `pins`, `media`, `leaderboard`, `notifications`, `threads`,
  `thread-pushed` (both sizes).
- Dialogs that are sheets: `summary`, `inbox`, `shortcuts` (both sizes).
- Account: `account-menu`, `reminders` (desktop; the phone has no header face yet, G20).

`people-beside-stage` and `search-beside-stage` were shot while another package was changing the stage: the stage
pane itself is missing from the frame in the current shots (the conversation is the 420px pane, which is the
point), where an earlier take drew it. My assertion for that test is on the frame's `data-stage="side"` and the pane
width, not on what the stage draws.

There is no reference render for a sheet, so each was held against the tokens and the pane language, not a PNG:

- Geometry matches the pane exactly (table above); the title starts on the column edge (x 526), the close sits
  where the search button was, the message box inside a pushed thread is the conversation's capsule (514 to 1258).
- Type roles are the spec's: title 20/600, line 13 ink-2, kickers 12/700 narrow uppercase, names 15/600, details
  13, dates and counts in the instrument cut, the filter words in the code face because they are typed as written.
- Surfaces: the sheet is `--solid`, cards `--bub`, the selected row `--sel`; controls are glass (the search field
  is a 48px capsule at `--glass-fill-quiet` with the hairline; its focus ring is the §9 ring, 2px white .85, offset 2).
- The account and channel menus are the `.97` near-solid popover: the timeline behind the account menu does not
  read through (the spec asserts the fill in `computed style`).

## Decisions and differences worth a look

- **A sheet covers the header, including the call pill.** The pill is under the sheet while one is open. The
  alternative (a sheet below the header) keeps the pill but fights the focus trap and makes the thread's back
  button awkward. Escape is one press; say if you want the pill kept.
- **Summary and follows became pages, not dialogs.** The summary is asked for when its page opens (a model call), so
  it is not the default page: an unnamed `openSheet('channel')` opens Pins.
- **Tabs inside the channel sheet.** One frame, several pages, so notifications is reachable without a menu row
  and switching from Pins to Media does not go back through the menu.
- **`TopBarOverlay` renders a sheet.** The inbox and shortcuts are sheets too, and the legacy `TopBar` (still drawn
  by `GuildStateScreens`) gets sheets for its dialogs. Its `panelClassName`, `bodyClassName` and `icon` props are
  accepted and ignored.
- **Presence order in the people sheet.** In a live voice channel shows "In Lounge" (amber) before an activity.
  Someone with no presence is Offline; invisible people look offline, as they do to everyone else.
- **Search icons.** `in:` and the inbox's channel rows use a chat glyph, not `#` (§1.7).
- **Sign out has no confirm**, like the Log out row in Settings.

## Not done, or uncertain

- **The server sheet.** `glassStore.sheet === 'server'` renders nothing. The server menu (G9's `ServerMenu.tsx`,
  a popover) already opens Invite as a dialog and mutes inline, so nothing needed a sheet; per-server notification
  levels and "create channel" do not exist as menu items (channels are made in Server settings > Channels). The
  channel sheet's Notifications page carries the channel's level and the server's mute. Wiring `openSheet('server')`
  needs an edit in `places/`, which is not mine.
- The patch above is unapplied. Until it is, the summary and follows dialogs are correct in behavior and geometry
  but Lantern inside, and there is no Notifications row.
- **Follows** (announcement channels) is covered by unit tests only: the reference scene has no announcement
  channel, so there is no screenshot of it.
- Real server, real desktop app: not run. `:has()` is used in a few selectors (kicker spacing, row hover); WebKitGTK
  2.52 supports it, but I did not open the desktop build.
- The profile card opened from a member row closes with the sheet on Escape (the sheet's trap answers first).
- Unpin is offered to anyone who can see a pin, as before (the server refuses it).

## For the next packages

- **Orchestrator / G11:** apply the patch.
- **G22:** `layout/ContextPanel.tsx` and its test are orphaned (nothing renders them); so are `TopBar.tsx` and its
  tests once `GuildStateScreens` moves. `uiStore.contextPanelMode` is now only a request channel; callers
  (`CommandPalette`, `useKeyboardNavigation` Mod+F, `ServerHome`, `DMPage`) can call `toggleSheet('search')` and
  `openChannelSheet('media' | 'leaderboard')` directly and the field can go.
- **G19:** `ServerHome`'s Media and Leaderboard buttons work through the slot as they are.
- **G20:** the phone header has no face, so the account menu has no phone door; a sheet is already full screen.
- Any new sheet: `<SheetFrame open onClose label kind title subtitle>` and a `body` (`scroll` or `fill`); focus,
  Escape, the portal, the phone layout and the motion come with it.
