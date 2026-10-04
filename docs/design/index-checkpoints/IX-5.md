# IX-5 checkpoint: Sidebar (header, search, channels, rooms, add-ons, Coming up)

Contract: `docs/index-spec.md` §3.1 ("Sidebar pane", "Header", "Search field", "Section label", "Channel row",
"Room row"), §4.1 to §4.7, §5.2, §5.3, §5.20. Plan row: `docs/design/index-plan.md` §3 (IX-5). Slot contract:
`docs/design/index-checkpoints/IX-4.md` ("Slots", `SidebarSlot`). Worktree `~/Documents/Paracord-index`, branch
`feat/index-ui`.

## What was built

`SidebarSlot` (`components/ix/sidebar`) replaces IX-4's stub. `{ kind: 'people' }` still renders IX-14's
`PeopleSidebar` (that dispatch line is kept); a server renders `ServerSidebar`, which reads its place from the
prop and never from the route:

```
.ix-sb  (display: contents; sections are the pane's flex children, each flex-shrink: 0)   --ix-hue = the pane's server
  SidebarHeader        data-testid=ix-sidebar-header   mark 40 + name + "N members · M here now" + "..."
  SearchField          data-testid=ix-search-field     "Search Fuel   Ctrl K" (⌘K on macOS), opens CommandPalette
  <CardSlot place position="inline"/>                  IX-7's card (rendered here, as the contract says)
  .ix-sb__rows         (position: relative: one coordinate space for the glide, the collapse and IX-7's push)
    .ix-sel.ix-hue-selected   the one selection element, moved by transform
    .ix-sb__ghosts            where a closing category's rows fade out (empty at rest)
    ChannelList        one <section> per group: "Channels" (uncategorized) then each category
      ChannelRow       data-testid=ix-channel-row data-channel-id, two lines, fixed height
    RoomList           "Rooms": data-testid=ix-room-row (buttons; click joins)
    AddonList          "Add-ons": data-testid=ix-addon-row (Sports, Daily word, Game servers)
    ComingUp           "Coming up": data-testid=ix-event-row (at most three)
```

| File | What |
|---|---|
| `SidebarSlot.tsx`, `ServerSidebar.tsx` | the dispatch and the server pane (wiring, focus, menus, loading and error states) |
| `SidebarHeader.tsx`, `SearchField.tsx`, `SidebarLabel.tsx` | header, search field, section label (a heading; the "+" sits beside it, not in its name) |
| `ChannelList.tsx`, `ChannelRow.tsx`, `RoomList.tsx`, `AddonList.tsx`, `ComingUp.tsx` | the sections |
| `useRovingList.ts` | one Tab stop over the rows; Up, Down, Home, End; Space opens a link row |
| `useSelectionGlide.ts` | §5.2: the highlight's `translateY`, 450ms spring, `ix-select:glide` |
| `usePreviewRoll.ts` | §5.3: new line from `translateY(9px)`, 520ms; time fades in 400ms; `ix-preview:line`, `ix-preview:time` |
| `useCollapse.ts` | §5.20: rows fade 150ms (a ghost), the rest FLIPs up 450ms; `ix-collapse:fade`, `ix-collapse:move`; remembered per server in `localStorage` |
| `useLongPress.ts` | the row's menu on touch (500ms; a scroll cancels it; the click after it is swallowed) |
| `useAddons.ts` | Sports / Daily word / Game servers and their live lines |
| `useSidebarMenus.tsx` | the rows' menus and the room join |
| `styles/ix-sidebar.css` | every rule (tokens only; transform, opacity and colors move) |

Data (the plan's owned files):

- `glass/places/model.ts`: new preview rules (below), `shortWhen`/`fullWhen`/`clockShort`, `headerLine`,
  `comingUpLine`, `dateTile`. `PreviewContext` gained optional `events` and `nowMs`.
- `glass/places/rows.ts`: `groupChannels`, `categoryLabel`, `buildSidebarGroups`, `buildSidebarRooms` and their
  types (`SidebarChannel`, `SidebarGroup`, `SidebarRoom`, `RoomOccupant`). The Glass `buildChannelRows` is untouched
  and still feeds the Glass panel until IX-19 deletes it.
- `glass/places/usePlacesData.ts`: `useServerSidebar(guildId, selectedChannelId)`, `roomOccupancy`,
  `withLocalDecryption`; `useChannelAttention` and `useServerPeople` factored out of `useServerPlaces` (same
  behavior). `useServerPlaces` is the Glass panel's and unchanged in what it returns.
- `hooks/useRoomMenu.tsx`: takes any `{ channelId, scope, guildId, name }` (a `RoomLight` still fits);
  `copyChannelLink` exported.

## The rules (all in unit tests)

- **Rows.** Name (no `#`), time (`9:41 PM` today, `Tue` within the week, `Sep 28` older), the last line, a white dot
  for unread (a mention counts as unread), a white count chip under the time for mentions (`99+` past the cap), the
  name in ink when unread or open and in ink-3 when muted. A muted channel says nothing (no dot, no chip); neither does
  the channel you are reading. State is in the accessible name after the name (`clips, unread, 2 mentions`,
  `muted`). An announcement channel has a megaphone (12) after its name. Rows are links (`href`, Enter,
  modified click left to the browser) with `aria-current="page"` on the open one.
- **The line.** `Author: text`; `You: ...`; media only is `Nick posted 4 photos` / `a photo` / `a clip` (only for the app's own
  clip file names, `parseClipFilename`) / `a video` / `a recording` / `a file` / `3 files`; a message that is only an
  event is `Movie night · Fri 9 PM` (needs the calendar; otherwise `Jeremy: an event`); a poll, sticker and system
  message in words. No message: the topic, else `No messages yet` (said at once from the channel record, not after the
  previews load). Previews still loading for a channel that has messages: the line is blank, never a guess (this is
  also what keeps the preview roll from playing when previews first arrive). Preview request failed: `Preview
  unavailable`. A forum shows its newest post's title from the posts the client holds, else its topic, else nothing
  (never "No messages yet": its posts may simply not be loaded). End-to-end encrypted: `Encrypted` with a 12px lock,
  or the text the client already decrypted for that message when the message store holds it (`withLocalDecryption`).
- **Groups.** Uncategorized first under "Channels", then categories by position; a group with nothing in it is not
  drawn; voice and stage channels are not channels (they are Rooms); threads never appear. A category label that is
  plainly shouting (`TEXT CHANNELS`: all capitals, every word 4+ letters, two words or one of 5+) is written as a
  sentence (`Text channels`); acronyms (`LFG`, `FPS GAMES`) and any name with a lowercase letter are left alone. A
  category label is a button (chevron on hover and focus, turns a quarter when closed); Left closes, Right opens;
  a closed group still shows unread, mentioned and the open rows. `+` at a label (Manage Channels) opens IX-9's
  `openCreateChannel({ kind: 'text', parentId })`.
- **Rooms.** Every voice and stage channel except the card's (`useInlineCardRoom(place)`, IX-7), in category order then
  position: speaker glyph (podium for a stage), name, `Empty` or `N here`; busy rows read brighter with an amber glyph
  and up to three 16px faces. Click joins (`pillActions.joinCall`, never navigates). Right-click: Listen in (not on a
  stage; disabled with the server's own sentence while it has refused), Open chat, Copy link to channel, and for
  Manage Channels Edit channel (server settings at that channel) and Delete channel (confirms, `deleteChannel`).
  People in a room are those who joined (a listener is not "here"), the streamer first, then by `joined_at`.
- **Channel right-click** (and long press): the four notification levels (that is how a channel is muted), Mark channel
  as read, Copy link to channel, and the same two management rows.
- **Add-ons.** Only while the server has them on. Live lines: Sports `Cubs 3–2 Brewers · 7th` (the hottest live game; `N
  live now` for several or when scores are hidden; `Scores` otherwise), Daily word `4 solved today` (else `Today's
  puzzle`), Game servers `2 of 3 online` (`Checking…`). Sports and Daily word open their pages. **Game servers have no
  page yet**, so the row opens a small popover (name, status, Connect, copy the address).
- **Coming up.** Events running now or starting within seven days, running first, at most three: a 32x36 tile (weekday in
  the server's hue, day), the title, `Fri 9:00 PM · Lounge`, amber `Live`. Click opens the server's **Events page**
  (§4.7 says "event sheet"; there is none, and `ServerSidebar`'s `openEvent` is the one place to change when there is).
- **Header.** "N members · M here now" where here now is the members whose presence is `online` (not idle, dnd, offline),
  and before the roster has arrived just "N members" (no claim). The mark and name are one button (Overview, `aria-current`
  on that page); "…" (`aria-haspopup="menu"`, `aria-expanded` from `useServerMenuOpenFor`) and a right-click anywhere on
  the header open IX-9's `openServerMenu`.
- **Focus.** Header, "…", search field and each "+" are ordinary Tab stops; the rows (category buttons, channels, rooms,
  add-ons, events) are one stop (the open channel, else the first), arrow keys inside. Rows carry `data-place-row` (the
  phone frame focuses the first when the root returns).
- **The leaving pane** (`leaving`): keeps the channel that was open when it started to leave (frozen from the route),
  plays no glide, no roll, no collapse, does not scroll, and is the frame's `inert`/`aria-hidden`.

## Decisions and deviations from the spec

1. **Row height is 51, not 52.** §3.1 says "fixed height 52"; the prototype measures 51 at 1x (padding 8+8, name 18, gap 1,
   preview 16) with a 53 pitch, which is what every reference render shows. "The prototype wins on look": rows are `51px`
   (`--ix-ch-h`) with explicit line heights (name 18, line 16, header 20/15, label 15), so a different font build cannot move
   a row. The reference's selection in s0 is 55 tall (a measurement taken before the font loaded; s1 and later it is 51); mine is
   always 51.
2. **Proportional digits.** `<body>` sets `font-feature-settings: 'tnum'` for the whole app; the prototype uses tabular digits
   only on times and counts (`1 member · 1 here now` is proportional). `.ix-sb` resets it. **IX-4/IX-11/IX-15: the main
   column wants the same reset** (`.ix-frame`, or per surface), or every Index digit is tabular.
3. **Room rows are weight 400**, as the prototype's `.rm` (§2.4 says 14/600 for "room rows"; the reference shows regular).
4. **ink-3 is .62** (IX-1's decision), so every ink-3 string is a hair brighter than the reference's .5.
5. **"Jeremy posted a clip" is "a video" in the harness** (IX-0 difference 5): `clip.mp4` is not one of the app's clip file
   names (`Clip 0m30s from Vincent's screen.webm`), and a video the app did not make is a video.
6. **Game Night reads "5 here now" in the harness**, the reference "4": the prototype leaves you out of its list; you are
   online and a member.
7. **No exact unread counts.** The Glass panel asked the server to count unread messages per channel; Index shows a dot, and a
   mention count is the read state's own. The sidebar makes no per-channel request.
8. **No light hooks.** `useBuildingLight` ticks once a second while anyone is in a call and follows every typing event; the sidebar
   reads who is in which room from `voiceStore.channelParticipants` and who is online from `presenceStore`, so it re-renders
   on those events only.
9. **Mute is the notification levels' "Nothing from this channel".** There is no separate Mute row.
10. **Edit channel** opens server settings at the Channels section with that channel highlighted; there is no lighter editor.
11. The Glass server-mode code (`PlacesPanel`'s `ServerBody`, `PlaceRows`, `AddonRows`, `ComingUp`, `ServerTitle`,
    `buildChannelRows`) is dead for servers but compiled because the People stub (IX-14 replaces it) still mounts `PlacesPanel` for Home.
    IX-19 deletes it; IX-14 should delete it with the People stub if it lands first.

## For the next packages

- **CSS classes you may reuse** (People sidebar, IX-14): `.ix-sh`, `.ix-sh__main`, `.ix-sh__more`, `.ix-search`, `.ix-section-label`
  (+ `.ix-sb__heading`), `.ix-ch` (+ `.ix-ch__name`, `__time`, `__line`, `__dot`, `__mention`; `data-unread`, `data-muted`,
  `data-mentions`), `.ix-sel`, `.ix-rm`. They are scoped by `.ix-sb` for the font reset and the shrink rule: wrap your pane's
  contents in `<div className="ix-sb" style={{ '--ix-hue': PEOPLE_HUE }}>`.
- **The motion helpers' hooks** (`useSelectionGlide`, `useRovingList`, `usePreviewRoll`, `useLongPress`) are generic over a container;
  People's DM rows can use them as they are.
- **IX-7**: your push moves `.ix-sb__rows` as one block; the selection and the collapse FLIP live inside it, so they do not fight.
  Elements the collapse FLIPs are `[data-ix-flip]` leaves (labels and rows); do not put that attribute on a container.
- **IX-9**: the sidebar opens `openServerMenu(server, { element, align: 'end' })` / `anchorFromEvent(event)` and
  `openCreateChannel({ guildId, scope, kind: 'text', parentId })`; it reads `useServerMenuOpenFor(guildId)`. The channel and room row
  menus are its own `ContextMenu` items (`useSidebarMenus`); restyle `ContextMenu` and they follow.
- **IX-10**: Game servers need a page (`/app/guilds/:g/game-servers` or similar); give `AddonModel.href` (`useAddons.ts`, the `games`
  entry) and the popover is not used.
- **IX-6**: the dock's live and unread rules are yours; `useServerLive` is IX-7's.
- **IX-18**: animation ids are `ix-select:glide`, `ix-select:fade`, `ix-preview:line`, `ix-preview:time`, `ix-collapse:move`,
  `ix-collapse:fade`. Nothing fills forwards; at rest `document.getAnimations()` holds none of them.
- **IX-16**: the search field hides its `Ctrl K` under `[data-layout='phone']`. Row long-press is in; action sheets are yours.

## Verification (commands run in `client/`)

- `npm run typecheck`: clean.
- Unit: `npx vitest run src/components/ix/sidebar src/components/glass/places src/hooks/useRoomMenu.test.ts`: 285 passed
  (new: `ix/sidebar/{sidebar,sidebarMotion,ServerSidebar,useSidebarMenus}.test.tsx`, `glass/places/{sidebarRows,usePlacesData}.test.*`; `model.test.ts` updated:
  "shared" is "posted", new `when`, `headerLine`, `Coming up`, clip and event-only cases).
- `npm run lint`: 0 errors in my files (`eslint` on `ix/sidebar`, `glass/places`, `useRoomMenu.tsx`, the spec: clean). The tree's 3
  errors are others' (`e2e/index-pages.spec.ts`, `glass/sheets/PeopleSheet.tsx`, one more jsx-a11y).
- `npm run test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast`: pass.
- e2e: `PARACORD_E2E_INDEX_SPEC=index-sidebar PARACORD_E2E_INDEX_PORT=4533 PARACORD_E2E_INDEX_RT_PORT=4535
  PARACORD_E2E_INDEX_WP=ix5 npx playwright test -c e2e/index-review.config.ts`: 11/11 pass (about 53 s). It measures the
  prototype's geometry (header mark at (18, 20), search 74-108 and 292x34, label 37, rows 51 on a 53 pitch at 149/202/255, rooms
  36 at 343/379), quiet at rest, the roll and dot after `arrive`, the leaving pane (inert, frozen on general, plays nothing), Game Night's
  rows after the visit, busy Fuel's Coming up, the glide's keyframes (`translateY(37px)` to `translateY(90px)`, 450ms, spring,
  transform only), join on click, the menus, the header, the search field, the keyboard, categories and the collapse (150ms fade, 450ms FLIP,
  Rooms 53px up, ghosts gone), and shots at 1440, 900 and 390.
- `node e2e/index-compare.mjs ix5`: whole-page mean s0 2.44%, s1 1.41%, s4 2.49%, s5 3.92% (the main column is the Glass
  conversation until IX-11/IX-15). The **sidebar crop** (x < 316, y < 730, `output/.../ix5` against `ref/`): s0 0.22%, s1 0.78%, s4 3.19%,
  s5 0.65%. s4's number is IX-7's pinned card being 178px tall against the prototype's 177, which moves everything under it by 1px;
  the rest of the difference everywhere is the ink-3 step, "a video", the harness's longer first preview, and Coming up (the
  prototype never draws it).

## Screenshots (`output/design-reference/index-build/ix5/`, gitignored)

I read each side by side with its reference. `s0-quiet.png`, `s1-someone-arrives.png`, `s4-other-server.png`, `s5-busy.png` (and
`compare/<state>.png` / `.diff.png`), `s1-someone-arrives@1440x900.png`, `@900x700.png` (280px sidebar), `@390x844.png`
(conversation) and `s1-someone-arrives-root@390x844.png` (the phone root: the sidebar).

## Left undone or uncertain

- **Event sheet** (§4.7) does not exist; events open the Events page.
- **Game servers page** does not exist; a popover stands in.
- **A selected add-on is not a glide target between pages that are not rows** (Overview, Events): their pages show no row highlight.
- The 1px offset under IX-7's pinned card (above) is theirs.
- `PlacesPanel` etc. (above) await IX-14/IX-19.
- Not measured: CPU on WebKitGTK (IX-20). The sidebar's own contribution is re-rendering on voice, presence, message-store, read-state
  and notification changes only.

## Files

New: `client/src/components/ix/sidebar/**` (13 sources, 4 test files), `client/e2e/index-sidebar.spec.ts`,
`client/src/components/glass/places/{sidebarRows,usePlacesData}.test.*`, this file.
Edited: `client/src/components/glass/places/{model,rows,usePlacesData}.ts`, `model.test.ts`, `client/src/hooks/useRoomMenu.tsx`,
`client/src/styles/ix-sidebar.css`. Deleted: `client/src/components/ix/sidebar/stub.tsx`.
Touched outside my list: none by me (`glass/places/ServerMenu.tsx` and `PlacesPanel.test.tsx` changed under IX-9 while I worked).
