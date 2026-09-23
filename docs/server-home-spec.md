# Server home: spec

Chosen 2026-09-22: direction **A · Front page**, with the side column borrowed from
**B · Widgets**. Reference mock-up:
https://claude.ai/artifact/L3DeqnGyQQGAo6rqtz5T3h (switch it to A, then between busy and quiet).

The page replaces today's Lobby (`client/src/components/rooms/lobby/`), which shows a
row of "Dark · nobody's in · never lit" cards and a list of channels. The new page's
job: a server with three people online should still feel alive. It does that by
showing what people *made* (posts, photos, polls, forum threads, events), not only
who is online right now.

## Layout (desktop, content plate ≥ 1000 px)

1. **Cover.** The server banner (`guilds.banner_hash`, uploaded by workstream 1c),
   180 px tall, fading into the plate at the bottom. A server with no banner gets a
   generated cover: layered soft gradients seeded from the server icon's color and
   the server id, the same every time. This is the designed look for "no banner", not
   an error state.
2. **Head.** It overlaps the cover by about 58 px:
   - the icon at 76 px,
   - the name (Gabarito 800, 34 px) and description,
   - a face pile of online members (at most 6) with "8 online · 10 members",
     which opens the members panel.

   Actions on the right: the notifications bell (the existing notification-level
   menu), Media (the server media view from 1c), Invite (primary), and a settings
   gear for people who may manage the server.
3. **Body.** Two columns: the feed (1fr) and a 340 px widget column.

### Main column

- **Live now.** Shown only when something is live:
  - a voice channel with people in it (avatars at 38 px, a speaking ring, "Priya is
    talking · 42 min", Join);
  - a live stage;
  - an event whose time is now;
  - a live game from the Sports add-on (reuse its data and `LiveNowStrip` pieces).

  At most three cards, then "+2 more". Live cards carry the amber glow (styling only).
  When nothing is live, this becomes one line headed "Voice channels", with a button
  per voice channel (mic icon + name) and "Nobody in voice". No invented history.
- **Latest.** A feed across every channel the viewer can read, newest first, with
  infinite scroll. The server decides what is notable (see API below). Each item is a
  card:
  - header: channel (or forum) name and relative time;
  - the author (avatar and name) and content rendered with the existing message
    markdown, clamped to 6 lines with "Show more";
  - image attachments in a 2-column grid that opens the lightbox;
  - polls through the existing interactive poll card;
  - reactions through the existing interactive chips;
  - clicking the header jumps to the message in its channel.

  Forum posts show a title, reply count, the last replier and a face pile. New members
  are grouped into one item ("Yara and 2 others joined", with a "Say hi" action that
  opens a DM).

### Widget column

These are B-style cards. The owner chooses which appear and in what order.

- **Coming up:** the next 3 events, with RSVP inline on the first; "Calendar" opens
  the events list.
- **Media:** a 3×2 mosaic of the server's latest images that opens the server media
  view. Hidden when the server has none.
- **Most active this week:** the XP leaderboard (economy); top 4 with bars. Hidden when
  economy is off.
- **Game:** a game live now, or otherwise the next game, for the followed teams. Only
  when Sports is on. On desktop it moves into Live now while it is live.
- **Pinned:** the latest pin in an announcement channel.
- **New here:** people who joined in the last 14 days.

Configuration lives in `hub_settings.widgets = [{ id, enabled }]` and is edited in
Server settings → Server hub under the heading "Home page": a toggle per widget plus
drag to reorder, with a live preview. A widget with nothing to show is left out and
never leaves a hole.

### Phone (plate < 700 px)

One column, in this order: the cover (150 px), the head (wrapping, actions on their
own row), Live now (stacked), Coming up, then the feed. The remaining widgets come
after the fourth feed item, then the feed continues.

## API (new)

`GET /api/v1/guilds/{guild_id}/feed?limit=20&before=<cursor>` returns
`{ items: [...], next_cursor }`. Items are typed:

- `{ type: 'message', message, channel_id, channel_name, reason }`. `message` has the
  normal message shape: poll, attachments, reactions, viewer reactions. `reason` is one
  of `announcement | attachment | poll | reactions | pinned | thread_starter`.
- `{ type: 'forum_post', channel_id, channel_name, thread_id, title, author,
  reply_count, last_reply_at, last_reply_author, participants }`.
- `{ type: 'members_joined', users: [...], at }`: joins grouped by day.

**Notable** means any of these:

- posted in an announcement channel;
- has an image, video or file;
- has a poll;
- has at least 3 reactions (a constant, one place);
- is pinned;
- starts a thread with at least 2 replies.

Plain chat never appears in the feed; the channels are where that lives.

The route is permission-filtered like messages. It works on SQLite and PostgreSQL and
must not N+1: batch-load reactions and polls the way the channel message list already
does. Integration tests cover each reason, hidden channels, the cursor, and the
members-joined grouping.

## Motion

- Sections enter with a 40 ms stagger, 420 ms, translateY 8 px → 0 and scale
  0.99 → 1, from a visible rest state.
- Cards lift by 2 px on hover.
- A live voice or stage card's glow breathes on a 2 s cycle only while somebody in
  that channel is talking, driven by the same speaking flag the avatars breathe on.
  People in a call with nobody talking, events and games keep the still live glow
  (amber edge and halo) and nothing on the card animates. When the talking stops
  the glow eases back to rest rather than snapping. The breath is two still glow
  layers crossfading in opacity, never an animated box-shadow (composited, not
  repainted, which matters on the Linux webview).
- Poll bars grow.
- Photos scale to 1.04 on hover and their caption fades in.
- `prefers-reduced-motion` turns all of it off.

## Plain words (the same change, app-wide)

The light *styling* stays and spreads to anything live. The light *wording* goes (the
user, 2026-09-22: "Styling yes, terminology is kind of silly"). Change the words at
their sources:

- `lib/attention/lightCaptions.ts`, `components/rooms/lobby/lobbyCaptions.ts`,
  `components/home/homeCaptions.ts`, `homeModel.ts`, `components/message/messageLight.ts`;
- the call sites in the sidebar (`RoomRow`, `CollapsedRail`, `AccountPlate`),
  `TopBar`, `MessageInput`, `CommandPalette`, `HomeAroundNow`, `HomeBuildingCard`,
  `HomePickUp`, `LightCaption`, `WindowMap`, `RoomChatRibbon`.

| Now | Becomes |
|---|---|
| lights on / has their lights on | online |
| reading | here (in a channel) |
| Dark · nobody's in · never lit | Nobody in voice / Empty |
| Lights on (own status) | Online |
| Say something to the 3 people reading | Message #general |
| a call is "lit" | live |

Extend `client/src/lib/vocabulary.test.ts` so that "lights on", "reading", "never lit"
and "Dark ·" fail when they appear in user-facing strings.
