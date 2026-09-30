# WP-G9 checkpoint: the places panel

Contract: `docs/glass-spec.md` §1, §2, §3.1, §9. Plan row: `docs/design/glass-plan.md` §4
(WP-G9). Nothing is committed. Everything is in `~/Documents/Paracord-glass` (branch
`design/glass`).

The places slot now holds the real panel. It replaces the Lantern sidebar stub that WP-G7 left
in the slot: server row, server title, channel rows that show what is in them, a live voice row,
one-line quiet rows, add-on rows and "Coming up". In Home the same rows are your conversations.
`presentation` `'pane'`, `'overlay'` and `'browse'` render the same content in the containers the
shell provides.

## What is where

New, in `client/src/components/glass/places/`:

| File | What it holds |
|---|---|
| `PlacesPanel.tsx` | The panel: server row, title, list, focus, every action. `PlacesPanel` (exported by `index.ts`) is the panel inside an `ErrorBoundary`, as the stub was |
| `model.ts` | Pure rules: quiet threshold, channel order, badges, times, preview line, faces, server line, live line and kicker, event tile and line. Unit-tested without React |
| `rows.ts` | Pure: one server's channels + previews + read state -> `live` / `text` / `quiet` row models |
| `usePlacesData.ts` | The stores the panel reads (read-only): circles, one server's rows and events, Home conversations |
| `useUnreadMessageCounts.ts` | Exact unread counts, when they can be known (see "Unread counts") |
| `PlaceRows.tsx` | `TextRow` (64px), `QuietRow` (44px), `LiveRow` (92px), `GlyphRow` (add-ons), `EventRow` |
| `ServerRow.tsx`, `ServerTitle.tsx`, `ServerMenu.tsx`, `ComingUp.tsx`, `HomePlaces.tsx`, `AddonRows.tsx` | The parts of the panel |
| `Lead.tsx` | Faces, two-face lead, glyph tiles, picture lead, the glyphs the prototype draws |
| `*.test.ts(x)` | 6 files, 141 tests |

Also new: `client/src/hooks/useChannelPreviews.ts` (+ test), `client/src/styles/glass-places.css`.

Changed inside the brief's scope:

- `client/src/styles/globals.css`: one import line (`glass-places.css`, after `glass-layout.css`).
- `client/src/styles/glass-layout.css`: deleted the `.glass-stub-places` adapter block.
- `client/src/components/glass/places/index.ts`: exports the real panel.
- Deleted `client/src/components/glass/shell/stubs/PlacesPanelStub.tsx`.
- `client/e2e/fixtures/glass/{scene.ts,install.ts,generate-images.mjs}` (+ three PNG icons), see "Harness".

**Not in the brief's scope, needs a follow-up by whoever owns it:** `client/src/pages/AppShell.test.tsx`
asserts that the stub's mocked `UnifiedSidebar` sits in the places pane. With the stub gone two tests
in it fail (the real panel runs under that test's partial mocks and its error boundary catches).
I did not edit it. This patch makes the file pass 12/12 (verified, then reverted):

```diff
+vi.mock('../components/glass/places', () => ({
+  PlacesPanel: () => <div data-testid="places-panel" />,
+}));
 ...
-    expect(places).toContainElement(screen.getByTestId('unified-sidebar'));
+    expect(places).toContainElement(screen.getByTestId('places-panel'));
 ...
-    expect(overlay).toContainElement(screen.getByTestId('unified-sidebar'));
+    expect(overlay).toContainElement(screen.getByTestId('places-panel'));
```

(The `UnifiedSidebar` mock stays: the phone drawer still renders it until WP-G20.)

## Decisions

### Unread counts (the G2 open question)

A read state carries `last_message_id` and `mention_count`; a channel carries its newest message id.
Snowflakes order messages, they cannot count them, so "Clips  3" is not derivable for a channel the
client has not opened. One path, no guessing:

- **Unread or not** comes from the two ids (`isMessageUnread`): instant and exact.
- **The number** is asked of the server for a channel that is unread: `GET /channels/{id}/messages?after={cursor}&limit=100`.
  Fewer than 100 back is the exact count (your own messages excluded); 100 back is `99+`.
- **Until the answer is in, and if it fails, the row shows an unread dot.** Never a count it did
  not get. A failure asks again after 30 seconds and on the next change to the channel.
- **What is not asked:** a channel with a mention (the white `@` outranks a count), a muted channel
  or server, and the channel you are reading. At most 3 requests at once; answers are cached until
  your read position or the channel's newest message changes; a new message re-asks after a 400ms
  quiet, so a burst is one request. Only the server on screen (and Home's unread conversations).
- Mentions: white `@` for one, `@N` from two (the server circle in the reference reads `@2`).

This costs one request per unread channel of the server you open. The right fix is server-side: an
`unread_count` (capped) on `GET /users/@me/read-states`. When it exists, `useUnreadMessageCounts.ts`
and its test are deleted and `rows.ts` reads the field.

### Quiet channels

Quiet = **no message for more than 7 days AND nothing unread AND no mention**. A channel that never
had a message is quiet. An unread or mentioned channel is never quiet however old, so a mention can
never be hidden in a one-line row. A muted channel that is unread stays quiet (muting is what asks
for that). The reference draws "Patch notes, Tue" (two days old) as quiet while "Photos, Sun" and
"Gear, Sat" are full rows, which no recency rule can reproduce, so the harness scene's Patch notes
message is now nine days old (a Tuesday) and reads "Sep 22". Change `QUIET_AFTER_MS` in `model.ts` to
move the line.

### Order

The server's own order: channels without a category first, then each category's channels, both by
position; categories, threads and DMs are not rows. **Rows never re-sort by activity**, and "quiet"
only changes a row's height, so nothing moves under the pointer when a message lands or a channel is
read (the Lantern column needed `steadyOrder` for exactly this).

### Faces

A text row leads, in this order, with: the **latest picture** when the newest message has an image
(`media.content_type` starts with `image/`; the whole file is fetched, the server makes no thumbnails
yet); else **the last two distinct speakers** overlapped (earlier one behind top left, latest in front
bottom right, 30px in the 44px slot); one speaker is one 36px face; else a **glyph tile** for the
channel's type. Speakers come from the previewed message's author (always known) plus the authors in
the timeline the message store has loaded; pictures come from the message, else from the member
roster; else initials on the person's identity color. A 1:1 DM leads with the person's 44px face and a
light dot when they are online (no colored presence, plan §1.3).

### Other calls I made

- **Server ring vs bar.** The current server wears the bar; a *different* server with something live
  wears the amber ring. The reference draws Game Night (current, live) with the bar and no ring, and
  the renders win on look. To ring the current server too, drop `:not([data-current])` in
  `glass-places.css`.
- **The current server's circle has no badge** (screen 01); other servers show a white `@N` for
  mentions, else a gray count of their unread channels.
- **The live row** shows `LIVE`, plus ` 42 MIN` only when a stream start time exists. The client's
  `VoiceState` does not carry one yet (`self_stream_started_at` is WP-G5/G6), so the row reads a
  `self_stream_started_at` field defensively and writes nothing it cannot back. Its scene is the
  room's own tint (`--room-rgb`) until the room and stage packages give it a stream thumbnail.
- **Click on a live row:** somebody streaming -> `glassStore.openStage({ guildId, channelId, streamerId })`
  and `onClose` (closes browse or the overlay); nobody streaming -> there is nothing to watch, so it
  opens the voice channel's page.
- **Server menu** is the Lantern building menu, re-homed (Overview, Invite people, Mute, Mark as read,
  Server settings, Leave), left-aligned under the title, also on a right click of a circle. WP-G18
  turns it into the server sheet. **"Overview" (the server home) is a menu item, not a row**: the
  references draw no such row, and the plan's "first row Overview" (§1.3, §8.4) would push every row
  down. Owner call if the row is wanted.
- **Clicking the server you are already in** does nothing while you are in one of its channels; from
  its home, settings or an add-on it goes to a channel.
- **Home** (any route without a server): title `Home` with a line ("2 unread, 1 request"), a Friends
  row (white count of friend requests), then direct and group conversations, pinned first then newest,
  in the same row style with the newest message as the line (`useHomeMessagePreview`, never decrypts).
  The tray is the current place (bar under it), and shows no badge while you are in Home.
- **Tray badge** in a server: unread conversations plus friend requests.
- **Add-ons** (Sports, Daily word, Game servers) are 64px glyph rows after the channels, same data
  and destinations as the Lantern rows; Game servers opens a small popover. Feeds have no sidebar
  row today, so none here.
- **Times:** a clock time today, a weekday within six days, a date beyond it (year only when it is
  another year). Event tiles: `TODAY 9:30`, `NOW 9:00`, `FRI 2`, `OCT 14`.
- **Event line** writes what exists: time (when the tile does not), place, "you're hosting", "N going".
  "1 spot left" needs an event capacity (plan §8.6, later), so it is not written.
- **No `#`** anywhere: a `<#id>` in a preview reads as the channel's name.
- **Loading, failure and empty** are said: "Loading channels…", "Could not load this server's
  channels", "No channels yet", "Preview unavailable" on a row whose preview could not be fetched.

### Live updates

The preview request (`GET /guilds/{id}/channel-previews`) is the only cost of a server's rows; the
rest is kept live from what the client already receives. A MESSAGE_CREATE lands in the account's
message store whether or not that timeline is open; the store's newest message replaces the fetched
preview when it is newer (or is the same message, edited), but only when it is the channel's real
tail (`channel.last_message_id`), so a timeline opened around an old message never stands in for the
latest. A deletion of the previewed message asks the server again (once per deleted id, after a
500ms quiet); a reconnect or permission change (`paracord:conversation-capabilities-changed`) does
too. Encrypted messages have no text or thumbnail.

### Keyboard and accessibility

The server row is one Tab stop (Left, Right, Home, End); the list (channels, add-ons, events) is
another (Up, Down, Home, End); the stop starts on the open channel and follows focus. Enter opens (a
real link); Space opens a link too. Focus ring is `.glass-focusable` (2px, offset 2). Every row is
an `<a>` with an address (modified clicks are the browser's), `aria-current="page"` on the open one;
a badge has its words ("1 mention", "3 unread") for a screen reader; a live row lists who is in the
room; the date tile is text, not decoration.

## Harness (fixtures I edited, as the brief allows)

- `install.ts`: `GET /guilds/{id}/channel-previews` (built from the scene's messages as the server
  describes them), `after` and `limit` on channel messages (the unread count asks for them),
  server icons served as stored data URLs, `/users/@me/dms`.
- `scene.ts`: the reference's third circle, **Sunday League** (a live "Pitch" with Luke streaming, two
  unread mentions of Sean), two unread DMs (the "2" on the tray), a server icon per guild
  (`icon-*.png`, drawn by `generate-images.mjs`), Movie night without a place, Patch notes nine
  days old (see "Quiet channels").

## Verification (all from `client/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run src/components/glass/places src/hooks/useChannelPreviews.test.ts` | pass, 141 + 20 tests (6 + 1 files) |
| `npx vitest run src/components/glass src/hooks src/stores/glassStore.test.ts src/components/layout/sidebar` | pass, 38 files, 440 tests |
| `npx vitest run --exclude '**/DailyWordView.test.tsx'` (whole suite; that file hangs on a clean HEAD, G0) | 362 files, 3,545 tests: **3 fail**. 2 are `AppShell.test.tsx`, see the patch above. 1 is `components/home/home.test.tsx` "a lit server card" (`expected the Join button to have class bg-light-white`): WP-G21's edit of `components/ui/Button.tsx`, not from this package |
| `npm run test:tokens` | pass (741 files) |
| `npm run test:motion-lint` | pass |
| `npm run test:contrast` | pass (40,242 comparisons) |
| `npx eslint` on every file I added or changed | 0 problems |
| `npm run test:a11y:static` | **fails**, `src/components/ui/Button.tsx:19 - native browser confirm()`: WP-G21's file, not this package |
| `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g9 npx playwright test e2e/glass-review.spec.ts` | 15/15 pass. Run through a throwaway config on its own ports (another agent held 4175); the default command's behavior is unchanged |

`npm run lint` on the whole tree was not run; my files are clean.

## Screenshots (`output/design-reference/glass-build/g9/`)

- `01-conversation-desktop.png`, `02-quiet-desktop.png` (the harness, 1440x900): read against
  `screens/01` and `02` row by row, then again at 3x in side-by-side crops.
- Extra states (a throwaway spec, deleted afterward): `x-home.png`, `x-hover-clips.png`,
  `x-focus-clips.png`, `x-server-menu.png`, `x-overlay-820.png`, `x-stage-opened-from-live-row.png`,
  `x-browse.png` (against `screens/06`), `x-browse-picked.png`, `x-quiet-1024.png`,
  `x-servers-overflow-start.png` / `-mid.png` (edge fades with servers added to the row in the DOM).

### Against the references, row by row

Matches to about a pixel (checked at 3x): pane padding, server row position (tray, hairline, circles at
x 32 / 97 / 147 / 197 / 247), 40px circles, the 14x3 bar 11px under the current server, the amber ring,
badge sizes and offsets (`2`, `@2`), the title (28/600 narrow, chevron at half opacity) and its line, all
row heights (64 / 92 / 44), the row body (name 15/600, line 13, gap 2), the time and badge column (time
13 instrument cut, 20px chips 5px under it), selected `--sel`, faces 30px overlapped with a ring in the
row's color, the live row (gradient, 22px faces, waveform, amber line), the 32px gap and the kicker,
date tiles.

Differences left, none of them a panel bug:

1. Reference art (illustrated faces, the cave scene behind the live row, the drawn "41:07" thumbnail, an
   illustrated Trips tile): the panel draws real faces (initials in the harness), the room tint, and a
   center crop of the real latest picture.
2. "8 online" is "7 online" (the scene's member list has seven; the reference's eighth is not a person
   in the fixtures), Basecamp says "5 online" (all seven cast are online in the scene; the reference
   says 2).
3. "Lounge, 1 spot left" is "Lounge, 3 going" (no event capacity).
4. Trips' line is the newest message ("Eric: bring layers…"); the reference shows the first unread one.
5. Patch notes is the chat glyph, not the document one, and reads "Sep 22" (see "Quiet channels").
6. The Game Night circle shows a `@` badge and an amber ring in screen 02 because it has a mention
   and a live Lounge; the reference's prototype hard-codes badges on three circles only.
7. Screen 02's cool tint is WP-G8's (nothing writes `--room-rgb` yet), so 02 is warm.
8. The white `@` in a chip reads a hair smaller than the reference's.

## Not done, or unsure

- **Phone (< 768px)** is WP-G20: the shell still mounts the Lantern drawer there, so the phone shots
  in the harness show the old bottom bar. The panel itself is fluid (rows are 100% wide, the server row
  scrolls), and the compact frame (768 to 859) uses it as the overlay, shot at 820x768.
- **Picture leads download the whole file.** No thumbnails from the server; a follow-up there lets
  `useAttachmentThumb` ask for a 44px one. Cached (48 pictures, revoked on eviction).
- **The unread count costs a request per unread channel** (see above). Server-side `unread_count` is
  the fix.
- **Add-on rows have no room for a "live" cue beyond the words** ("2 live now"); amber was not
  applied since the reference draws no add-ons.
- **Forum channels** get a row but the previews endpoint holds no messages for them (WP-G4), so they
  read as quiet one-liners.
- **Threads** are not rows and the open thread's indented row is gone (WP-G11's pushed conversation).
- **Mentions and Saved rows** for Home (plan §1.3) are not here: Friends only. They belong with WP-G18
  (the inbox overlay) or WP-G19.
- **Server icons** can be an API path in a browser (no ticket added; `useAuthenticatedImage` handles
  the desktop). The Lantern rail had the same limitation.
