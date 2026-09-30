# WP-G19 checkpoint: Home, DMs, Friends, a server's Overview, forum

Contract: `docs/glass-spec.md` §1, §2, §3, §9. Plan: `docs/design/glass-plan.md` §1.3 (features
without a home), the WP-G19 row in §4, §5, §8 (owner decisions: the server home is an "Overview"
reached from the server menu, not a row; App Home keeps DMs and friends). Checkpoints read:
G7 (frame, the 720px column), G9 (places panel), G11 (header and message box), G21 (primitives),
and G13's plan card, used as it stands in the tree. Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

There is no reference render for any of these pages. They are held to the language the renders
establish and to the places panel's row rhythm beside them: content solid tonal with no outline,
controls glass, kickers for groups, the instrument cut for times and counts, amber for live, white
for "for you", one filled (cream) button, no `#`.

## What each page is now

Every page sits in the pane's 720px column (the scroller is the pane's full width and pads itself
with G7's `--glass-column-inset`, so the column lands where a conversation's does: x 526 to 1246 at
1440, fluid with 28px sides below that, 12px on the phone). Each has the conversation header's
geometry: a 76px bar, the title at the column's left edge (20/600, tracking -0.01em), a line under
it (13, ink-2), the page's decision at the column's right edge, and your face with its presence dot
at the pane's right edge.

| Page | Route | What it is |
|---|---|---|
| **App Home** | `/app` | A calm list, in the order things matter: **For you** (friend requests with Accept, mentions with the white `@` chip, DMs waiting with a dot, a time in the instrument cut), **Live now** (amber kicker; the places panel's live row at page width: room tint behind a dark end, faces, waveform when somebody talks, "Vincent is streaming", "LIVE 42 MIN" only when the wire says when the stream began; Join is cream on the busiest room and glass on the rest), **Around now** (faces, amber ring on anyone in a call, one line), **Coming up** (plan cards), **Pick up where you left off** (rows). Title is the greeting; the line is "5 for you, 2 live" or "Nothing needs you", and never claims nothing while the activity behind it is still loading. |
| **DM conversation** | `/app/dms/:id` | Already G11's `ConversationPane` (header, bubbles, capsule). This package restyled what is DM-specific: the call stream that shows above the timeline is a solid `--deep` surface in the column (no rules, no black strip), and the **incoming-call notice** (below). |
| **Messages index** | `/app/dms` | The all-conversations list as the places panel's rows at page width (face with a presence mark in ink, name, last line, time, white `@N` chip or unread dot, a group is a glyph tile), a filter well, and **New message** as the one cream button. |
| **Friends** | `/app/friends` | Segmented tabs (Online / All / Requests / Blocked, counts in the instrument cut), a search well, rows in the panel's rhythm: presence as ink on the face (solid dot online, ring away, dot with a bar do-not-disturb, faint ring offline), the line is the presence word then, in amber, where they are ("In Lounge, Game Night") or, in ink, what they are doing ("Playing Hazard 5", "Listening to ..."). People in a call sort first, then here, away, do not disturb, offline. Add friend is a glass button that opens a solid card; Send friend request is the page's one cream button. Requests: Accept (glass) and Decline (text), Cancel for ones you sent, Unblock as text. |
| **Server Overview** | `/app/guilds/:id` | The banner (or the cover made from the icon's color) lights the top of the pane and fades into it through a mask, with a scrim so the title reads on any banner. Head: the mark, the name at 28/600 narrow, who is online (opens the members popover), the description, and icon-only circles for notifications, media and settings plus a glass **Invite**. Then, one column at every width: **Live now**, the owner's widgets in the owner's order (each a kicker over one solid card), then **Latest**. |
| **Forum** | `/app/guilds/:id/channels/:forum` | A toolbar of glass controls (sort, list or grid, archived, tags), a search well, tag chips, then **Posts** as solid rows: title, tag chips, author, message count, time. **New post** is the one cream button. Default is rows (it was a grid); the grid remains, two to a line. A post opens as a conversation, which it already was. |
| **Incoming call** | any page | A near-black capsule with the faint amber glow, as the call pill is: the caller's face, amber "Live call" kicker, "Brendan is calling you", **Decline** as text and **Join** as the cream button. Still in `BannerStack`'s slot, so it reserves its own height (62px) at the top of the app. |

## Retired or moved, and why (nothing is dropped silently)

Retired, with where the feature went:

- **Home "Your servers" cards** (`HomeBuildingCard`, `HomeAddBuilding`, `HomePage.openBuilding`).
  A server card was a header, a window map, a live thumbnail and text-room lines. The server row in the
  places panel is the list of servers now, so a second list would repeat it. What the cards *told* you
  moved to where it belongs: a live room is a row under **Live now**, mentions in a text channel are
  rows under **For you**, who is around is **Around now**. The window map (Lantern light) and the live
  thumbnail on the card are gone with it; the live row shows the room's tint until G8/G12 supply a
  stream frame, as the places panel's does.
- **"Add a server — join with an invite, or start your own" row.** The `+` in the server row (G9) does
  this. Home keeps it only as the empty state when you are in no server ("Add a server", cream), so a
  fresh account is never left with no way in. The dialog is the same `CreateGuildModal`.
- **Dead helpers and their tests:** `buildingMetaCaption`, `roomActivityLine`, `textRoomCaption`,
  `ADD_BUILDING_LABEL` (`homeCaptions.ts`); `BUILDING_TEXT_ROOMS`, `litTextRooms`, `activeTextRoom`,
  `isLitBuilding` (`homeModel.ts`); `pickUpContext`; `eventWhen` / `eventMeta` (replaced by G13's
  `planWhen`); `useFeedPerson` (a lit `PersonLight`; a face is a `Face` now).
- **The Overview's two-column layout and its phone variant:** `usePlateLayout`, `PHONE_MAX`, `WIDE_MIN`,
  the 340px widget aside, "on a phone Coming up sits above the feed and the rest after its fourth
  post" (`ServerFeed`'s `interleave`), `compact` on the feed cards, and `phone` on `LiveNow`. A 720px
  column has no room for a side column, and it is the same column on a phone, so there is one order at
  every width: live, widgets, latest. The live game card is no longer hidden on a phone.
- **`components/light/**` in this scope** (`LitAvatar`, `AvatarStack`, `WindowMap`, `RoomThumbnail`,
  `VoiceParticipants`): every use in the files I own is replaced by G9's `Face` / `FaceStack` and the
  ink presence mark. The folder itself is still imported elsewhere (user profile, settings), so its
  retirement stays with WP-G22.

Moved:

- **The server home is still not a row** (owner decision, G9): it opens from the server menu. This
  package changes what opens.
- **The account menu** was reachable only from a conversation header. Home, Friends, Messages and the
  Overview have no conversation header, so each page bar carries G11's face at the pane's right edge.
- **The forum layout toggle's default** moved from grid to list (the brief asks for rows); both stay.
- **Coming up** is now a top-level section on Home and a widget on the Overview that still respects the
  owner's on/off and order (`hub_settings.widgets`).

Kept as they were: every route, all data hooks (`useBuildingLights`, `useUnifiedConversations`,
`useComingUp`, `useUpcomingEvents`, `useServerFeed`, `useHomeMessagePreview`), the hold-order behavior of
For you while the pointer or focus is inside it, RSVP, the members popover, mute and mark-as-read from the
bell, media and settings, invite, the calendar dialog, walk-into-room motion, every widget, the forum's
sort, archived, tags, search and new-post flows.

## Decisions worth a look

- **Cream is Join.** On Home and the Overview the one filled button belongs to the busiest live room.
  Invite is glass. With nothing live there is no cream on the Overview. On Friends and Forum the page's
  own primary action (Send friend request, New post) is the cream one.
- **Presence is ink, amber only for a live room.** The face's mark is a solid dot (here), a ring (away),
  a dot with a bar (do not disturb) or a faint ring (offline); a person in a voice room wears an amber
  mark. Friend requests and blocked people show none.
- **"LIVE 42 MIN" is written only when `self_stream_started_at` is on the wire**, the same rule as G9.
- **Widgets are content, so each is a kicker over one solid card**; Media is pictures in a row of squares
  (it was a 3x2 mosaic sized for a 340px column). The pinned widget no longer prints `#channel`.
- **Row text and rhythm reuse G9's:** 64px rows, 44px leads, name 15/600, line 13 ink-2, time 13 in the
  instrument cut, the same wash on hover and press. The kickers sit 10px in, aligned with the rows' faces.
- **Coming up on Home has no host face** (`ComingUpEvent` does not carry the creator), so the slot is
  yours only: an open circle until you take it, your face once you have. On the Overview the host is
  the second slot (members are at hand there).
- **Overview in the compact frame:** the frame's places button floats over the banner instead of sitting
  in a bar above it, so the banner reaches the top.

## Files

New: `client/src/styles/glass-pages.css` (imported in `styles/globals.css`, `layer(components)`, after
`glass-cards.css`); `components/home/{GlassPage,PageRow,LiveRoomRow,HomeLiveNow}.tsx`; tests
`components/home/GlassPage.test.tsx`, `components/dm/IncomingCallBanner.test.tsx`,
`components/rooms/lobby/feedGlass.test.tsx`; harness `e2e/glass-pages.{spec,config}.ts`,
`e2e/fixtures/glass/pages.ts`.

Rewritten or restyled: `pages/{HomePage,DMPage,FriendsPage}.tsx` and the comment of `GuildHomePage.tsx`;
`components/home/{HomeAroundNow,HomeComingUp,HomeNeedsYou,HomePickUp,homeCaptions,homeModel}`;
`components/rooms/lobby/{ServerHome,ServerHead,ServerCover,LiveNow,ServerFeed,FeedItemMessage,FeedItemForumPost,FeedItemMembersJoined,feedParts,serverCoverModel}`
and `widgets/{WidgetCard,WidgetColumn,ComingUpWidget,MediaWidget,MostActiveWidget,PinnedWidget,NewHereWidget,DailyWordWidget,GameWidget,GameServersWidget,HomePageSettings}`;
`components/channel/ForumView.tsx`; `components/dm/IncomingCallBanner.tsx`.
Deleted: `components/home/{HomeBuildingCard,HomeBuildingCard.test,HomeAddBuilding}`.
Tests updated: `pages/{HomePage,FriendsPage,DMPage,GuildHomePage}.test.tsx`,
`components/home/home.test.tsx`, `components/rooms/lobby/LiveNow.test.tsx`,
`widgets/HomePageSettings.test.tsx`, `components/channel/ForumView.test.tsx`.
Outside the scope: none edited. (`styles/globals.css` got the one import line the brief names.)

## Harness

```bash
cd client
PARACORD_E2E_GLASS_WP=g19 npx playwright test -c e2e/glass-pages.config.ts   # 25 shots, ~1.5 min
```

Its own ports (4383 dev server, 4385 realtime stub), so it never lands on another checkout's server. If a
run is killed, look for a leftover `vite --port 4383` before the next one ("already used").
`e2e/fixtures/glass/pages.ts` layers on the G2 scene without editing it: six friends with a spread of
presences and activities, a request each way and a blocked person, a forum with tags and five posts and a
conversation inside the first, Game Night's feed (a picture with reactions, a forum post, a poll, people
who joined), its gallery, leaderboard and members with two recent joiners, the attention previews that
"For you" asks for, stream start times (so "LIVE 42 MIN" can be read), an evening's conversation with
Brendan, and a call ringing in that DM (`{ ringing: true }`). Two things it had to learn the hard way, kept
as comments in the file: the client refuses a response without `X-Paracord-History-Epoch`, and a channel
that is not in the scene's `channels/visible` list is silently filtered out.

## Verification (from `client/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | 386 of 387 files, 3,868 of 3,869 tests pass. The one failure is `glass/sheets/PeopleSheet.test.tsx` "opens someone's profile from their row", WP-G18's file, in flight; my earlier full run of the same suite was 387 of 387 |
| the suites I touched (`home`, `rooms`, `channel`, `dm`, four pages) | pass |
| `npm run test:tokens` | pass (777 files) |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors (254 warnings repo-wide; the ones in my files are the existing `react-hooks/*` patterns: `Date.now()` in `HomeNeedsYou`, `HomePickUp`, `FeedItemMessage`, and `setState` in effects in the widgets and hooks that were already there) |
| `npm run test:contrast` | pass (40,242 comparisons; no new tokens) |
| `npm run test:a11y:static` | pass |
| `PARACORD_E2E_GLASS_WP=g19 npx playwright test -c e2e/glass-pages.config.ts` | 25 of 25 |

New tests (about 70): the page scaffold and row (siblings not children, real links with modified
clicks left to the browser, descriptions, presence marks, badges), the live row and `liveRoomsOf`
(busiest first, cream on the first only, no "LIVE 42 MIN" without a start time, Return for a call you
are in), Home in six states, Friends (amber where, sort order, ink presence, block/unblock, the one
filled button), the Messages index (presence mark, group tile, white chip, the call stream's surface),
the incoming-call notice (words, faces, Join and Decline, no green, no literal color), the feed cards,
the forum rows, layouts, tags, and no `#`.

## Screenshots (`output/design-reference/glass-build/g19/`)

`<state>-desktop.png` is 1440x900, `<state>-phone.png` is 390x844. Every one was opened with the Read tool.

- `home`, `dm`, `dm-index`, `friends` (Online), `friends-all`, `friends-requests`, `friends-add`,
  `overview` (Game Night, made cover), `overview-basecamp` (uploaded banner), `forum`, `forum-post`,
  `dm-ringing`, each at both sizes.
- Tall windows to read a whole scrolling page: `overview-long-desktop.png` (1440x2600),
  `home-long-desktop.png` (1440x1500).
- Other widths: `home-1024.png`, `friends-1024.png`, `forum-1024.png` (fluid column) and
  `overview-820.png` (compact frame).
- States: `friends-hover-desktop.png` (wash, the reveal of Remove), `friends-focus-desktop.png` (the
  2px ring, offset 2).
- `../g19-before/` is the same set before this package, for comparison.

### Read against the Glass language

- **Geometry** matches the conversation's: title at x 526, search well and cards 526 to 1246, your face at
  1372 to 1404, kicker text 10px in at the rows' faces, bar 76px. Phone: 12px sides, 17/600 title.
- **The places panel's rhythm carries over:** the same 64px rows, faces and mark, kicker, instrument-cut
  times and white chips. The live rows are the panel's live row with a Join beside it.
- **Content solid, controls glass:** cards, rows' faces, plan cards, feed posts and forum rows are tonal
  (`--bub` / `--raise`) with no outline; the tabs, Add friend, Invite, the toolbar and the icon circles are
  the glass controls; the only hairlines are a control's own edge.
- **Amber** appears only on a live kicker, a live row's line, the ring or mark of someone in a call, and
  the call notice. **White** is the mention chip, the cream button and the focus ring.
- Type: 28/600 narrow for the server name, 20/600 titles, 17/600 for a post title and a card title,
  15/600 names, 13 lines, 12/700 kickers, the instrument cut on every time and count.

### Differences and things I could not settle from the renders

1. There is no reference for these pages; the judgment is against the language, not a pixel diff.
2. Live rows show the room's tint, not a stream thumbnail (G8/G12).
3. A forum post's header reads "Best loadout for Hazard 5 wit..." with the server name under it, because
   `GuildPage` builds the header `subject` (its topic line is the server). "Strategy" would say more.
4. The harness's DM names are lowercase (`brendan`): the scene's DM recipients carry no `display_name`.
5. Wide-window Overview: the banner is 224px and fades over its lower three quarters; a very bright
   banner would still be dimmed by the scrim, which is intended, but I only had the two scene banners.

## Left undone, or not mine

- **Live check.** Nothing was run against a real instance (`live-drive`), and a live incoming DM call was
  only simulated in the harness with a `VOICE_STATE_UPDATE` frame.
- **High contrast and reduced transparency** were not eyeballed on these pages; they use the same tokens as
  everything else, and the contrast audit covers the tokens, not my selectors.
- **Pick up where you left off** was seen once in the tall Home shot, with the mocked read states; the
  wrapped two-line preview is covered by tests, not by a shot with long text.
- **Specs that still assert the old Home or server home** (WP-G22 retires or rewrites them):
  `e2e/smoke.spec.ts` lines 465 and 760 (`Your servers`), `e2e/design-review.spec.ts` lines 1292, 1311,
  1324 (`Your servers`, the server `article`/`group`, `Join voice`), `e2e/motion-gate.spec.ts` (the Lantern
  "walk into the shop floor" flow starts from that Home). `real-server*.spec.ts` only use the `For you`
  region and its list items, which are unchanged.
- **`components/guild/ServerHubSettings.tsx` (G21's scope)** still says "Home page" and "widgets beside the
  feed". The Overview stacks them in one column; the label wants to say "Overview" and drop "beside".
  `HomePageSettings`' own preview and copy are fixed here.
- **`styles/server-home.css`** is now nearly all dead (`pc-home-*`); only `pc-home-enter` is still used, by
  `ServerHome`. WP-G22 can prune it. `components/gameServers/GameServerParts` (`StatusDot`) is outside this
  scope and still draws a status dot in the Game servers widget.
- **The call notice** floats as a capsule but the `BannerStack` (`components/BannerStack.tsx`, outside the
  scope) still reserves its full height at the top and pushes the panes down 62px while it rings. Letting
  the notice float over the gutter needs that component to stop reserving space for it.
- **The phone frame** (drawer button, bottom bar) is still Lantern until WP-G20; the phone shots show it
  under these pages.
