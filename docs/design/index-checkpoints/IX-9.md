# IX-9 checkpoint: Sheets, menus, quick switcher

Contract: `docs/index-spec.md` §4.2, §6.1-6.6, §6.9 (and §8.2 for the files this replaces). Plan row:
`docs/design/index-plan.md` §3 (IX-9). Worktree `~/Documents/Paracord-index`, branch `feat/index-ui`.

**For IX-5, IX-6, IX-14, IX-15: read "How to open each thing".** Nothing else renders a menu; all of it is mounted once
by the sheet slot (`MenuHost`) and opened through functions exported from `components/ix/menus`.

## What was built

- **Sheet frame** (`components/glass/sheets/SheetFrame.tsx`, rewritten in place; same props): a portal into the frame's
  `#ix-sheet-host` (IX-4's geometry: inset 10, 400 wide, 480 for search, radius 24, full inset under 760px of main),
  `--ix-pop` with a hairline edge, opaque under Reduced transparency; header 58 with the title 17/700 and a line under it
  (12.5 ink-3), a back chevron for a pushed page, the close button (34x34, the toolbar's tool). In 380ms spring from
  `translateX(24px)`, out 250ms ease (`ix/sheets/useExitPresence.ts`: a copy of `usePresence` with a 250ms hold, because
  `lib/motion` is fenced). Phone and "no host on the page" fall back to a full-screen window sheet (IX-16 owns the phone
  polish). **No call pill**; `pill/sheetCover` is no longer used here.
- **SheetSlot** (`components/ix/sheets/SheetSlot.tsx`, replaces IX-4's stub): `Sheets` (search, people, channel, reminders;
  the legacy `uiStore.contextPanelMode` and `openSearch` hand-offs are kept, so Ctrl F still opens search) plus `MenuHost`.
- **People sheet**: here now first (presence dot via `Avatar`, "In Lounge" in amber with the speaker glyph), then everyone
  else under the highest hoisted role they hold, then Offline (`glass/sheets/peopleGroups.ts`, pure and tested). A row opens
  the profile card beside the sheet. Group and direct-message people are unchanged in behavior.
- **Channel sheet**: the tab strip is now a **segmented control** (`role=tablist`, one tab stop, arrow keys move and select,
  scrolls sideways with edge fades when the pages do not fit, the page is its `tabpanel`). Pages unchanged.
- **Message search sheet**: restyled in place (field in the header, chips, results). New: the quick switcher's last row
  opens it with the typed words (`openSearchWith`, `searchSeed` in `sheetStore`).
- **Reminders / pins / follows / threads / summary pages**: restyled by CSS only (`glass-sheets.css`, see below).
- **Server menu, channel menu, People menu, account menu** (`components/ix/menus/`): one popover primitive (`IxMenu.tsx`:
  240 wide, radius 14, rows 36, 14/500, glyph 16 ink-3, hairline separators, `scale(.97)` + fade 180/120ms, roving arrows,
  Home/End, type-ahead, Esc closes only itself, Tab closes, focus returns to the opener). "Notifications" is a group that
  expands in place (caret points right when closed, down when open) with the level in force checked.
- **Account menu** moved here (`ix/menus/AccountMenu.tsx`), 280 wide, **anchored to the toolbar avatar** (`[data-ix-account-anchor]`,
  right edge to right edge, 6px under it): avatar 40, name, @username; Status (Online / Idle / Do not disturb / Invisible);
  a custom-status field; Profile (User settings at the account section); Reminders; Settings (Ctrl ,); Keyboard shortcuts
  (Ctrl /); Admin dashboard (admins); Developer portal; Copy username; Sign out.
- **Quick switcher** (`components/layout/CommandPalette.tsx`, ordering in `layout/switcherModel.ts`): a 420px near-solid
  panel, radius 16, placed over the sidebar's search field (`[data-testid="ix-search-field"]`, else the sidebar's top; a
  full-screen page on a phone). Groups in the spec's order: Channels, Rooms, People, Servers, Direct messages, In other
  servers, Commands; with nothing typed only channels, rooms, servers and DMs show (people, other servers' channels and
  commands appear when the words match); the last row is always "Search messages in <server> for “…”". Dialog named
  "Quick switcher". "Go to home" is gone (Home is retired).
- **Help** is a dialog (`HelpOverlay.tsx`, shared `Modal`, 440 max, radius 20, `--ix-card`, one cream "Done"), opened from
  the account menu and Ctrl / (⌘ /) from anywhere.
- **Profile card** (`components/user/UserProfile.tsx`, layout rewritten, all logic kept): 340 wide, radius 20, near-solid;
  banner when set (96), avatar 76 with a 4px ring in the card color and its presence dot, name 20/700, @username and
  pronouns 13 ink-3, status and activity, About, roles as fill chips, mutual servers and friends as 24px marks, key
  verification kept on the card (and "Verify keys" in the menu), a private note, then **Message (cream)**, Add friend /
  Accept / Unblock (wide control), **Call**, and a "..." menu (Remove friend, Decline, Cancel request, Verify keys,
  Copy user ID, Block, Report). It is **portaled to the window**: main is a layout container (`container-type`), which
  places and clips a `position: fixed` child, so every caller that rendered `UserProfilePopup` inside main was wrong.
- **Create channel / Create room dialog** (`CreateChannelDialog.tsx`) and the invite and New message dialogs, hosted by
  `MenuHost`.

## How to open each thing (the API for the other packages)

```ts
import {
  openServerMenu, openChannelMenu, openPeopleMenu, openAccountMenu, openProfileCard, openHelp,
  openCreateChannel, openInvite, openDmPicker, closeMenu, anchorFromEvent, useServerMenuOpenFor,
  type MenuAnchor, type ServerRef,
} from 'components/ix/menus';
```

`MenuAnchor` is `{ element: HTMLElement; align?: 'start' | 'end'; gap?: number }` (under a control; `end` hangs the menu from
the control's right edge) or `{ x, y }` (at the pointer). `anchorFromEvent(event)` builds one from a click or right click
(a keyboard activation reports (0, 0) and anchors under the element).

| Caller | Call |
|---|---|
| IX-5, sidebar header "..." | `openServerMenu({ guildId, scope, name }, { element: button, align: 'end' })`; `aria-expanded` is `useServerMenuOpenFor(guildId)`. A second press should call `closeMenu()`. |
| IX-5, header right click | `openServerMenu(server, { x: e.clientX, y: e.clientY })` |
| IX-6, dock mark right click | same, at the pointer |
| IX-5, a category's "+" | `openCreateChannel({ guildId, scope, kind: 'text' \| 'room', parentId })` (IX-5 currently opens server settings) |
| IX-14, People header "..." | `openPeopleMenu({ element, align: 'end' })` |
| IX-15, large / folded title | `openChannelMenu({ subject, summary }, { element: title, align: 'start' })`; `subject` is `{ kind: 'channel', guildId, channelId, channelName } \| { kind: 'dm', channelId, title, isGroup }` (a `ConversationSubject` fits), `summary` is `useConversationActions().actions.summary` |
| anyone, a face | `openProfileCard(user, { x, y })`: the card opens to the LEFT of `x` when it fits, else to the right |
| toolbar avatar (IX-4) | `openAccountMenu()` (already called) |

**Compatibility:** `useServerMenu()` from `components/glass/places/ServerMenu` (re-exported from `ix/menus/ServerMenu`)
keeps its old shape (`openFromElement`, `openAtPoint`, `isOpenFor`, `element: null`); IX-5's `ServerSidebar` and IX-6's dock
(`useDockServerMenu`) use it as is, and `openFromElement` now hangs from the button's right edge and toggles. They can move
to `openServerMenu` when convenient; delete the shim with the Glass places panel (IX-19).

**Server menu rows** (`buildServerMenu`, a pure function of booleans, unit tested): Overview, Invite people (Create Invite
and a text channel), Events (`eventsHref` from IX-10's `components/guild/eventsRoute`), Notifications > All messages / Only
mentions / Nothing, Mark as read, Mute / Unmute server, Create channel and Create room (Manage Channels), Server settings
(`canAccessGuildSettings`), Copy link, Leave server (not for the owner, confirms). Permissions come from
`ix/menus/useGuildPermissions.ts`, which resolves by account scope (a dock right click names any server) and shows a gated
row only once roles and the member list are known; the member list is fetched once if it is not loaded.

**Channel menu rows**: Catch up summary (disabled with the reason when not allowed), Pinned messages, Threads, Media,
Follows (announcement channels), Leaderboard, Notifications, Edit channel (Manage Channels; opens server settings on
Channels with the channel), Copy link. A direct message gets Catch up summary, Pinned messages, Media, Copy link. **Inbox and
Help are no longer in it.** Page rows call `openChannelSheet(page)`.

## Decisions and deviations

1. **No event sheet.** IX-5's code says "the event sheet is IX-9's"; it is not in IX-9's row or files, so none exists (an
   event row still opens its channel). Needs an owner.
2. **Leaderboard is always listed** in a server channel's menu: the client has no flag for "the server's economy is on"
   (the leaderboard request just returns an empty ranking). Gate it when the server exposes one.
3. **"Start a group" and "New message" open the same picker** (`DmPickerModal`, IX-14's file, has its own Group toggle and no
   initial mode). IX-14 can add `initialMode` and call it from `buildPeopleMenu`.
4. **Notifications group has no inline value** ("All messages" beside the row): at 240px it truncated the label to
   "Notificati…". The check on the expanded rows says it.
5. **Presence word is "Idle"**, not "Away" (spec §6.4).
6. **Tokens**: added `--ix-pop-solid` (`#16171a`, `--ix-pop` fully opaque) to `tokens.css`'s Index block for Reduced transparency;
   sheets and menus use `--ix-pop` (spec says `rgba(20,21,24,.98)` for sheets, `rgba(24,25,28,.98)` for menus: one token, the
   difference is not visible).
7. **Scoped token remap** (`ix-sheets.css`, first rule): the Glass ramp (`--ink-*`, `--text-*`, `--bub`, `--sel`, `--solid`, ...)
   is redeclared on `.ix-sheet`, `.ix-menu`, `.ix-switcher`, `.ix-profile` and `.ix-dialog-panel`, so panels this package does
   not own (media gallery, leaderboard, thread panel, reminders pane, the inbox) take the Index inks inside a sheet with no edits.
8. **Sheets stay modal for a keyboard** (`useFocusTrap`: Tab contained, Esc closes, focus returns), although the conversation
   stays usable with a pointer (no scrim), as §6.1 says.
9. **Menus close their own Esc only**: a capture-phase listener stops the event, so a sheet or dialog under a menu stays.
10. **Palette**: member rows open the profile card at the panel's top left; room rows navigate to the room's channel route
    (joining stays in the sidebar). Other servers' text channels are found by typing.
11. **`glass-sheets.css`**: the frame, header, pill, phone and tab-strip rules are removed (moved to `ix-sheets.css` or
    gone); the content classes (`glass-sheet-row`, `-kicker`, `-card`, `-field`, `-tab`, `glass-search__*`, ...) keep their
    names (other packages' panels carry them) with Index values; `.glass-help__*` and the `overlay pre` rule are deleted.
12. Checkpoint path is the preamble's `docs/design/index-checkpoints/IX-9.md`.

## Files

New: `components/ix/menus/{IxMenu,ServerMenu,ChannelMenu,PeopleMenu,AccountMenu,CreateChannelDialog,MenuHost}.tsx`,
`{hostStore,anchor,accountMenuOpener,menuUtils,serverNotifications,useGuildPermissions}.ts`, tests `menus.test.tsx`,
`menuHost.test.tsx`, `useGuildPermissions.test.ts`; `components/ix/sheets/{SheetSlot.tsx,useExitPresence.ts}`;
`components/glass/sheets/peopleGroups{,.test}.ts`; `components/layout/switcherModel{,.test}.ts`; `e2e/index-sheets.spec.ts`.
Deleted: `ix/menus/stub.ts`, `ix/sheets/stub.tsx`, `glass/sheets/AccountMenu{,.test}.tsx`, `glass/sheets/SheetFrame.pill.test.tsx`.
Rewritten or edited in scope: `glass/sheets/{SheetFrame,Sheets,PeopleSheet,PersonRow,ChannelSheet,sheetStore,index}`,
`glass/conversation/{useChannelMenu.tsx (now an adapter over the shared model), sheetBridge.ts}`,
`glass/places/ServerMenu.tsx` (shim), `layout/CommandPalette.tsx`, `layout/overlays/{HelpOverlay,SearchOverlay,PinnedMessagesOverlay,TopBarOverlay}.tsx`,
`user/UserProfile.tsx`, `styles/{ix-sheets,glass-sheets}.css`, and their tests.

**Outside my file list (smallest changes, flagged):**
- `styles/tokens.css`: one token, `--ix-pop-solid` (above).
- `lib/vocabulary.test.ts`: the AccountMenu path (`copyOf('components/ix/menus/AccountMenu.tsx')`) because the file moved.
- `components/glass/places/PlacesPanel.test.tsx`: the "opens the server menu" case now asserts the host store (the menu is the host's).
- `components/glass/conversation/ConversationPane.test.tsx`: the channel-menu cases follow the Index rows (7 rows, "Follows",
  "Leaderboard", "Edit channel"; the Inbox cases are removed with the Inbox row).

## Verification (`cd client`)

- `npm run typecheck`: my files clean. Remaining errors are not mine: `glass/places/{sidebarRows,usePlacesData}.test.ts(x)`
  (IX-5's in-flight rewrite) and, earlier in the session, `guild/EventList.tsx` and `gameServers/GameServers.test.tsx` (IX-10).
- Unit: `npx vitest run src/components/glass src/components/layout src/components/user src/components/ix src/pages/AppShell.test.tsx src/stores`:
  all pass except `stage/stageTransition.test.tsx` (pre-existing at HEAD). New: 42 + 18 + 5 in `ix/menus`, peopleGroups 6,
  switcherModel 7, CommandPalette 15 (rewritten), UserProfile +3, ChannelSheet +1, SheetFrame +3, sheetStore +3.
  Full `npx vitest run`: 4755 passed, 22 failed at the time of the run; every failure was outside this package
  (`vocabulary` "never says room", `stageTransition`, `useGlassKeybinds`, and `AppShell.test.tsx`, which my first
  version of `SheetSlot` broke by importing `Sheets` past the barrel the test mocks and by always mounting `DmPickerModal`;
  both fixed, `AppShell.test.tsx` passes).
- **`lib/vocabulary.test.ts` "never says room" fails** on IX-5's `RoomList.tsx: Rooms` and on my "Create room", "Rooms",
  "Room" (CreateChannelDialog, ServerMenu, CommandPalette, switcherModel). The spec approves "rooms" for voice channels in
  the sidebar (§0 Words), so the test's rule is the Glass decision; it needs the orchestrator's update (`ROOM_ALLOWED`),
  not a workaround from one package.
- `npm run test:tokens` pass (924 files). `npm run test:motion-lint` pass. `npm run test:a11y:static` pass (the profile
  scrim is `onMouseDown`, the audit's backdrop rule). `npm run test:contrast` pass. `npm run lint`: 0 errors (212 warnings,
  none new from this package except the pre-existing patterns).
- e2e: `PARACORD_E2E_INDEX_SPEC=index-sheets PARACORD_E2E_INDEX_PORT=4573 PARACORD_E2E_INDEX_RT_PORT=4575 PARACORD_E2E_INDEX_WP=ix9
  npx playwright test -c e2e/index-review.config.ts`: **17/17 pass**. They assert the frame geometry (400 / 480 wide, inset 10,
  radius 24, full inset at 900x700, full screen at 390), Esc and focus return, the account menu's right edge on the avatar's,
  the server / channel / People menus' rows, the segmented control, the switcher's group order and its last row carrying
  words into the search sheet, Ctrl K / Ctrl /, the profile card, the Create channel dialog, and opaque backgrounds under
  Reduced transparency and High contrast; an uncaught page error fails a test.

## Screenshots (`output/design-reference/index-build/ix9/`, gitignored; all read)

`sheet-people` (+`@900x700`, `@1440x900`, `@390x844`, `-contrast`), `sheet-channel-{pins,notifications,leaderboard,threads}`,
`sheet-search-{empty,results}`, `sheet-reminders`, `menu-account` (+`-contrast`), `menu-server`, `menu-server-notifications`,
`menu-channel`, `menu-people`, `dialog-create-channel`, `dialog-help`, `card-profile`, `card-profile-menu`,
`switcher-{empty,typed,people}`, `switcher-phone@390x844`. The prototype has no menus, sheets or switcher, so they are held
against the spec text and the nearest reference's tokens (no `index-compare`).

## Left for others / uncertain

- IX-5: header "..." and the category "+" should call `openServerMenu` / `openCreateChannel` directly; the sidebar search
  field must keep `data-testid="ix-search-field"` (the switcher anchors to it).
- IX-14: People header "..." calls `openPeopleMenu`; the Inbox page replaces `InboxOverlay`, which still renders in a sheet
  through `TopBarOverlay` and is unreachable from the channel menu now (it was its only door).
- IX-15: title click calls `openChannelMenu`; delete `glass/conversation/useChannelMenu.tsx` and `sheetBridge.ts` with the header.
- IX-16: sheets and menus on a phone (action sheets, pushed pages); the window-host sheet and the full-screen switcher
  work but are not polished; the account menu on a phone has no toolbar avatar to anchor to (it falls back to the top right).
- IX-17: `InviteModal`, `Modal` and the Report / Verify dialogs inside the profile card are still the shared dialogs;
  `.ix-dialog-panel` restyles Help and Create channel until `ui/Modal` carries §6.12.
- The toolbar avatar does not set `aria-expanded` for the account menu (IX-4's file).
- Alt+Shift+Up/Down (unread channels, §10) does not exist in `useKeyboardNavigation`, so Help does not list it; Ctrl 1-9 is
  listed because IX-6 builds it.
