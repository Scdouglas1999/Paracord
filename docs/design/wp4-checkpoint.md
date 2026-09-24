# WP4 — The Lobby: a server seen from the street

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §7.3 (the
surface), §8 (RoomCard, RoomThumbnail, EventCard, TextRoomRow, HereNowStrip), §6
(the kill-list), §9 (accessibility). Builds on [WP0](./wp0-checkpoint.md) and
[WP1](./wp1-checkpoint.md). IA carried over from `docs/layout-spec.md` §7
("Channels recipes") — the behavior is kept, the presentation is replaced.
Branch: `design/lantern-stage`.

Reference render: `output/design-reference/Lobby.html` / `.png`.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/components/rooms/lobby/Lobby.tsx` | The whole surface. The only place this package reads stores and decides what belongs to the server. |
| `client/src/components/rooms/lobby/LobbyHeader.tsx` | Server mark, Gabarito name, the one-line summary, Invite / settings. |
| `client/src/components/rooms/lobby/AroundNowWell.tsx` | Lit faces + WP1's one-sentence summary + "+17 lights on". |
| `client/src/components/rooms/lobby/RoomCard.tsx` | `RoomCard` (lit / dark) and `AddRoomTile` — the three things in the grid. |
| `client/src/components/rooms/lobby/TextRoomRow.tsx` | §8's `22px 1fr auto` row. |
| `client/src/components/rooms/lobby/EventCard.tsx` | The "Coming up" well: day tile, title, meta, RSVP. |
| `client/src/components/rooms/lobby/MediaStrip.tsx` | "Recently in …" — four recent images, and the count. |
| `client/src/components/rooms/lobby/useNextEvent.ts` | The next scheduled event + RSVP, over the endpoint the app already calls. |
| `client/src/components/rooms/lobby/useRecentMedia.ts` | Which images the strip may show — and which it refuses. |
| `client/src/components/rooms/lobby/lobbyCaptions.ts` | Every string this surface owns. |
| `client/src/components/rooms/lobby/lobbyTime.ts` | The wall clock: event times, the day tile, a channel's last stamp. |
| `client/src/pages/GuildHomePage.tsx` | Thin router adapter → `<Lobby/>`. |

`components/rooms/lobby/index.ts` is the barrel. Nothing in `lobby/` re-derives a
light: every count, caption, occupant and reader comes from WP1's selectors
(`useBuildingLight`, `useBuildingPeople`, `useAroundNow`, `useRoomThumbnail`) and
WP1's components (`RoomThumbnail`, `AvatarStack`, `LitAvatar`, `LiveDot`,
`RoomDuration`). Styling is tokens + `ui/` + `light/` only; the standing
"no literal color" assertion covers every part in every state.

### Deleted (presentation replaced)

`RoomsView.tsx` · `GuildHomeHeader.tsx` · `LiveRoomsGrid.tsx` ·
`AroundNowStrip.tsx` · `TextChannelList.tsx` (+ its test) · `SpaceBriefing.tsx`.
Nothing outside `components/rooms/` imported any of them (checked across
`src/` and `e2e/` before deleting — only comments referenced them).

### Kept on purpose

`components/rooms/RoomCard.tsx` and `OccupantStack.tsx` are the **Emerald
Commons** card, now marked `@deprecated`. `pages/HomePage.test.tsx` still mocks
the path while WP6 is mid-rewrite of `HomePage.tsx`; deleting them would break a
package that is running concurrently. They are WP6/WP8's to remove, and nothing
in the Lobby touches them. The new card is `lobby/RoomCard.tsx` — a different
module, so the two never collide.

---

## 2. The surface, top to bottom (§7.3)

**Header.** Server mark (`getIdentityColor`, never the emerald — a server is
not an action), the name at the Display step in Gabarito, and one line of facts:

> 24 of 61 have their lights on · 2 calls live · thermal test at 1 pm

Each clause drops out rather than printing an empty one, and the denominator is
dropped when the server has not told us the roll. Invite appears when there is a
text channel to invite somebody into; the settings gear is gated on
`canAccessGuildSettings` exactly as the old header was. The Coins →
"Space economy" entry is **not** carried over: the TopBar's "Space leaderboard"
is the same destination, so nothing became unreachable.

**Around now.** `AvatarStack` of the people the server's channels can see (lit
first), WP1's `aroundNowSentence`, and `+N lights on` for everybody else. One
correction to WP1's default empty sentence: with lights on but nobody in a channel,
"Nobody's lights are on right now" would contradict the "+N lights on" beside
it, so the Lobby passes **"Nobody's in a voice channel right now"**. With nothing on at
all, WP1's string stands.

**Channels grid.** Lit channels as lit cards — `RoomThumbnail height={168}` with the
live frame or a still plus the LIVE dot, the channel name, `RoomDuration`, the
occupant stack, "Mara speaking", and **Join in white light** (the one button in
the product that spends a light token). Dark channels as matte cards —
"Dark · nobody's in" in the thumbnail, `last lit 2 h ago` (or **"never lit"**,
never a fabricated hour), the invitation, and Open. An **add tile** only for
somebody holding `MANAGE_CHANNELS`; for everybody else it is omitted, not
disabled. Grid: 3-up at 1440 (`xl`), 2-up narrower (`sm`), 1-up on a phone.

Two actions survive from the old card rather than being dropped: **Join** joins
the call, and the lit thumbnail is a button that opens the channel's own surface,
setting `watchedStreamerId` first when somebody is sharing — the same handoff
`GuildPage` has a regression test for. A Stage channel's button says "Enter" and
routes instead of joining.

**Coming up + Recently in …** Both are **omitted entirely** when empty. The event
card reads `GET /guilds/:id/events` — the endpoint `components/guild/EventList`
has always used — picks the soonest event that is still scheduled or running,
and RSVPs with the same PUT/DELETE. The media strip reads the message timelines
this client has already loaded (see §3).

**Text channels.** Rows, never cards (§6.8): window dot (amber when somebody is
reading), name, "Priya · 10:02", the preview, the reader stack, "5 reading", and
a mention chip. Two columns at 1440, one narrower. The active channel is raised and
carries `aria-current="page"`. Unread without a mention renders an 8px dot **and**
the word "Unread" for assistive tech. No categories: §7.3 and the reference put
nothing above the rows, so they are ordered lit-first then by the server's own
channel order.

---

## 3. Two surfaces that had to decide what they may claim

### The media strip

It shows images **the reader can already see**: image attachments in the message
timelines this client has loaded for this server's text channels. No new endpoint,
no store, no background fetch. Three refusals, each asserted in a test:

1. **E2EE messages are skipped.** Their attachments are ciphertext until
   `EncryptedAttachment` unwraps them; a thumbnail strip is not the place to
   start that, and a broken tile is worse than no tile.
2. **Federated attachments are skipped.** An attachment with an `origin_server`
   has to be proxied per channel; pointing an `<img>` at its raw URL would 404.
3. **The count is what it can see.** "14 photos this week" counts the images in
   the loaded timelines within seven days — it is a floor, exactly like WP1's
   reading count, and never an extrapolation.

The consequence, stated plainly: **a lobby opened in a fresh session has no
media strip until the reader has opened one of its channels.** That is the same
promise WP1 makes about the "authored" reading term ("an unopened channel
contributes nothing rather than a guess"). Making it unconditional would need a
server-side "recent attachments" projection, which this package is not allowed
to add. The design-review capture therefore walks the honest path — open the
channel, return to the lobby — rather than faking a store.

Bytes come back through the same authenticated blob path the timeline uses
(`fileApi.resolveAttachmentObjectUrl`), and each tile revokes its object URL on
unmount, so a strip that re-renders on every message cannot leak one per frame.

### Text-channel previews

The byline, stamp and preview come from the loaded timeline. For a channel this
client has never opened there is no author and no preview — only the name and,
when the channel carries a `last_message_id`, its stamp. A guessed last line is
worse than none.

---

## 4. The scheduled-event seam

There was **no** client API module, store or hook for guild scheduled events —
everything lived inline in `components/guild/EventList.tsx`. WP4 did not build
one; `useNextEvent.ts` calls the same endpoints through `getApi()` and keeps its
own state, and it listens to the same `paracord:scheduled-events-changed` DOM
event the gateway already dispatches, so an event created elsewhere refreshes
the Lobby. A calendar that cannot be read produces **no card and no toast** —
there is nothing a reader can do about it from the street. A failed RSVP does
toast, because that one was their action.

`toLobbyEvent` / `nextEventOf` are pure and exported so "what counts as coming
up" is pinned in a test: a canceled, completed, past or unparseable event is not
put in front of a human; an event that is already running still is.

---

## 5. Two things worth a reviewer's eye

1. **`SpaceBriefing` is gone, and with it the only member-facing render of a
   space's Hub settings** (welcome copy, banner, featured channels). §7.3 has no
   slot for it and the WP4 brief lists it for deletion, so it was deleted — but
   the admin form in space settings now writes to something nothing displays.
   That is a product decision to make in WP8, not a bug in this package.
2. **The card duration is the mono `RoomDuration` ("34:12"), not the reference's
   "34 min".** `RoomDuration` is WP1's vocabulary and is what the Stage and the
   on-air pill show; two spellings of the same fact would be worse than one that
   differs from the artboard. It is also a lower bound by construction — the
   client only counts from the moment it first saw the channel lit.

A third, smaller one: `RoomThumbnail` puts a dark channel's words at the **top
left** rather than centred as in `Lobby.png`. That is WP1's component and
matches `design-spec` §6 ("empty states left-aligned"), so it was left alone.

---

## 6. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass (whole client) |
| `npx eslint . --quiet` | pass, 0 findings (whole client) |
| `npx vitest run src/components/rooms src/pages/GuildHomePage.test.tsx` | **6 files, 79 tests passed** |
| `npx vitest run` | 2186 passed; 12 files failing, all in `components/message/**`, `components/layout/TopBar*` and `pages/DMPage` — WP5's surfaces, mid-rewrite in this worktree. None are WP4's. |
| `npm run build` | pass |
| `npm run test:contrast` | 49 checks × 4 themes passed |
| `npm run test:a11y:static` | no WP4 finding (the audit's one icon-only-button complaint about `AddRoomTile` was fixed by naming it explicitly; the two that remain are WP5's and WP6's files) |
| `PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp4 npx playwright test e2e/design-review.spec.ts` | pass — four frames |

The mocked smoke (`npx playwright test`) reports **82 passed, 2 failed** — both
failures are the same assertion in `smoke.spec.ts`, waiting on the composer
placeholder `Message #qa-general-channel`. WP5 has already replaced that copy
with §7.4's "Say something to the N people reading", so the flow aborts there,
**before** it reaches the Lobby leg. WP4 updated that leg's fixtures in place
(keeping their intent): the region is now `Rooms` with `exact: true` — "Text
channels" is the landmark directly below it and would otherwise make the old
locator ambiguous — and `Text channels` became `Text rooms`. Those same
landmarks, the space-settings entry and the keyboard-reachable channel rows are
asserted directly in `pages/GuildHomePage.test.tsx` and visible in the
design-review captures, which boot the same mocked shell.

### WP4's tests

- `lobby/lobbyCaptions.test.ts` — every string pinned, including the kill-list
  check that the surface never says "No data", "It's quiet here" or "Online".
- `lobby/lobbyTime.test.ts` — the clock and the Today / Tomorrow / weekday /
  date boundaries, asserted by shape so they are locale-independent.
- `lobby/lobby.test.tsx` — every card state (lit, dark, add), the
  permission-gated add tile, the text row in all four of its states, the event
  card with and without its optional clauses, the media strip, the Around-now
  well, the header's gated actions, the selection rules behind both optional
  sections, and the no-literal-color assertion.
- `pages/GuildHomePage.test.tsx` — the Lobby end to end against the **real**
  stores, seeded the way WP1's `useLights.test.tsx` seeds them, so the light is
  derived by the same code the app runs. Covers the header line, the settings
  gate, lit-before-dark ordering, joining, the add-tile permission gate, the
  event card appearing / being omitted / surviving a failed fetch, the media
  strip being omitted, and a text channel lighting amber when somebody types.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp4 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp4/ (gitignored)
```

Four frames — `lobby-{lit,dark}-{1440x900,390x844}` — a **lit** server (a live
channel with a screen share, people reading a text channel, an event on the calendar,
an image in the strip) and the **same server all dark**.

Getting a lit server into a mocked capture needed one new piece: light comes
from the gateway, and the design-review mock never delivers a guild. The WP4
block installs a `window.EventSource` stub — the exact thing
`connectionManager` asks the platform for — that replays one READY carrying the
server's voice states and presences, and keeps a typing signal alive so a text
channel stays amber. No app code knows about it, and it is confined to the `wp4`
branch of the spec.

Four things the screenshots caught and fixed:

1. **The "Around now" well collapsed on a phone.** The sentence was a `flex-1`
   child of a wrapping row, so at 390px it rendered one word per line with the
   "+N lights on" count on top of it. The well now stacks below `sm`.
2. **The header ellipsised the server's name on a phone** ("Kestrel Rob…").
   It now wraps to two lines below `sm` and truncates only on a desktop row.
3. **"+1 lights on" sat next to "Nobody's lights are on right now"** in an
   all-dark server where the reader's own lights were on. Hence the corrected
   empty sentence in §2.
4. **A text channel's stamp read "Dec 31".** The row was resolving the time from
   the message's snowflake, and the capture's fixture ids are not snowflakes; a
   loaded message's own timestamp is now used first and the snowflake is the
   fallback for an unopened channel.

All four frames were inspected against `output/design-reference/Lobby.png`:
plate gutter and padding, the 14px grid gap, the 168px thumbnail flush to the
card's top, the lit ring (`--ring-lit-plate`) against the matte card's
`--shadow-tile`, the white-light Join, the day tile, the `22px 1fr auto` rows,
and the three column counts (3-up / 2-up / 1-up).

---

## 7. Handover

**WP6 (Home, §7.5)** depends on this package and inherits two things: the
deprecated `components/rooms/RoomCard.tsx` + `OccupantStack.tsx` are now unused
by `HomePage.tsx` and only referenced by a `vi.mock` in `HomePage.test.tsx` —
delete all three references together. Home's own recipe is `BuildingPlate` +
`RoomThumbnail height={176}`, not this card.

**WP8 (sweep)** has one decision to make: `SpaceBriefing` is deleted, so a
space's Hub welcome copy, banner and featured channels are configured but never
shown. Either give them a home or retire the settings section.

**Anybody adding to the Lobby**: the rule this package keeps is WP1's — do not
re-derive a light, and do not spend a light token on emphasis. The Lobby's own
copy goes in `lobbyCaptions.ts`, next to its test; light copy stays in
`lib/attention/lightCaptions.ts`.
