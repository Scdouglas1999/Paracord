# WP5 — The text channel, and the DM that is one

Contract: [`docs/lantern-stage-spec.md`](../lantern-stage-spec.md) §7.4, §7.6,
§8 (HereNowStrip / TextRoomRow / Composer), §6, §9. Depends on
[WP0](./wp0-checkpoint.md) and [WP1](./wp1-checkpoint.md). Branch:
`design/lantern-stage`.

A text channel is now a **plate on the street**: the header, the timeline and the
composer are one surface on the 12px gutter. The header says who is reading it,
the timeline says who wrote each line and where they are, and the composer
invites the people who will actually read it. A DM is the same plate between two
people; a group DM is a channel.

Nothing about delivery changed. The durable-delivery runtime, the recovery
drafts, the encryption readiness gates and the encrypted-attachment seam are
untouched — they were restyled, not rewritten, and the whole `lib/messages/**`
tree is byte-identical.

---

## 1. Where things live

| File | Role |
|---|---|
| `client/src/components/message/messageLight.ts` | **The seam.** Everything a message surface needs from the light that WP1 does not already model: the author's light, a DM as a text channel, and the one client-side timeline event. |
| `client/src/components/message/TimelineParts.tsx` | The timeline's small shapes — day divider, author meta, reply chip, channel-lit event row, thread row, attachment frame. Presentational, tokens only. |
| `client/src/components/layout/TopBar.tsx` | The channel header (§7.4) and the DM header (§7.6). |
| `client/src/components/layout/ConversationHeaderActions.tsx` | Search / pins / threads / overflow, with counts. |
| `client/src/components/message/MessageList.tsx` | The timeline: 36px lit avatars, Gabarito names, in-channel meta, reply chips, reaction chips, thread rows, attachments, the inline channel event. |
| `client/src/components/message/MessageInput.tsx` | The composer (§8) and its copy. |
| `client/src/components/message/Messaging{QueuePanel,RecoveryNotice}.tsx` | Delivery and recovery, as raised rows above the composer. |
| `client/src/pages/GuildPage.tsx` (text branch) · `client/src/pages/DMPage.tsx` | The plate and its gutter. |
| `client/src/components/file/**` | Attachment previews on the well recipe. |
| `client/src/components/layout/ContextPanel.tsx` + `overlays/{Pinned,Search}*` | Pins / threads / search / members as **contextual plates**, not a docked rail. |
| `client/src/test/messageLightMock.ts` | The light seam, stubbed for suites that are not about light. |

---

## 2. The seam: `messageLight.ts`

WP1's handover has one rule above all others — **do not re-derive a light**.
This module keeps it by never inventing a rule, only by feeding WP1's own pure
functions the three things a message surface knows that a server does not.

### An author is a person, as light

`useAuthorLights(guildId, serverId)` returns a resolver from a message author to
a `PersonLight`. Voice occupancy comes straight off `RoomLight.occupants` — the
gateway sends every `VOICE_STATE_UPDATE`, so **"in Shop floor · 9:12 AM" is
never a guess** — and presence goes through WP1's `personLight()`. The presence
lookup is scoped by `serverId`, because a user id is a per-server snowflake.

The row draws `LitAvatar size={36}` and `AuthorMeta`. §9 is kept two ways: a channel
is named in words beside the dot, and when there is no channel the person's own
label ("Lights on", "Away") is rendered `sr-only`, so a rim is never the only cue.

### A DM is a text channel

A DM has no guild, so it never appears in a `BuildingLight`. `useDmLight()`
therefore lights it with **`textRoomLight()` — the same function a guild text
channel uses** — fed the same three reading terms (typing, recently authored,
self-viewing). "Reading" means exactly the same thing in a DM as it does in
`#build-log`, term for term, because it is literally the same code path.

That is what makes §7.6 true rather than approximated: a group DM is a channel
because it is built as one, and its here-now strip and people sheet are the same
components the channel header uses.

`peerLightSentence(peer, reading)` is the 1:1 header's line. The third clause is
only ever added when the channel can actually tell the peer is here:

```
Ren · lights on · reading this     ← a fresh channel-bound signal
Ren · lights on                    ← the app is open somewhere; that is all we know
Ren · away / lights off
```

### A channel lighting up, in the timeline

`useRoomLitEvents(guildId)` watches WP1's channel lights for a voice channel going
dark → lit **while you are reading this one**, and the timeline renders it
inline ("Shop floor lit up · Mara, Priya and Ren are in there now · Join").

Four rules make it an event rather than decoration:

- a channel that was **already lit when you arrived** is state, not news — the first
  observation of a server is the baseline;
- a channel that **empties again** loses its event immediately, so the Join it
  offers can never lead into a dark channel;
- a channel **you are already in** is not an invitation;
- at most two, aged out after ten minutes.

It is a client-side observation, never a server message: it lives in the
virtualized row list as its own row type and never enters `messages`.

---

## 3. The surfaces

### The text channel header (§7.4)

```
[ ▪ ]  build-log                    [ ●●●●● 5 reading · 19 lights on ]      ⌕  ⚲2  ⌸3  ⋯ More
       Kestrel Robotics · Hardware bring-up
```

- The **window dot** is the channel's own light: amber when people are reading,
  white for a voice channel with people in it, dark when nobody is there.
- The name is Gabarito 20/700 and is the `ChannelSwitcher` trigger, so fast channel
  movement survives (layout-spec §7.8).
- The **server is the breadcrumb** — it is the link back to the Lobby, so the
  header carries one name for the server instead of two.
- The **here-now strip** is WP1's `HereNowStrip`. §7.2 words it "4 here"; §7.4
  words it "5 reading". One optional `caption` prop was added to
  `components/light/HereNowStrip.tsx` so the surface that knows the verb supplies
  it — additive, defaulted to the old sentence, and still the light's DOM text
  equivalent.
- **There is no member list.** The strip's people sheet is the only full list of
  people in the product (§6.5), in a guild channel and in a group DM alike.
- **Counts** ride on the control they belong to: threads from the channel list
  (free), pins from one `GET /channels/:id/pins` per channel, cached five minutes
  and silently countless on failure — a number nobody can trust is worse than no
  number.

### The timeline

36px lit avatars, Gabarito author names, `in Shop floor · 9:12 AM` meta in the
mono face, day dividers as chips on hairlines, reply chips, reaction chips
(`Chip`), thread rows with their faces and reply count, and attachments in a
well with the file's own line beneath it.

Two things the screenshots forced:

1. **A channel reads from the bottom.** The reference render pins the conversation
   to the bottom of the plate; the virtualized feed filled from the top. The
   scroll container is now a flex column and the rows sit on `mt-auto`, so a
   short timeline drops to the composer and a long one scrolls exactly as before.
2. **A timeline with no day on it is a list.** The first message now gets a day
   divider too, so a channel opens with "Today" the way the artboard does — and the
   per-message meta drops to the bare time, because the day is already stated.

### The composer (§8)

Raised, 50px (46 on a phone), radius 12, the warm top highlight plus a lift —
never a border, so the drop state cannot reflow the row. Plus on the left, the
tools on the right, send in emerald.

The copy is the point:

| Situation | Copy |
|---|---|
| people other than you are reading | `Say something to the 5 people reading` |
| one other person | `Say something to the 1 person reading` |
| a channel nobody else is in | `Say something in build-log` |
| a one-to-one DM | `Say something to Mara Okafor` |

`readingOthers` **excludes you**. You are always reading the channel you have open,
so counting yourself would mean the fallback never appeared and a channel you are
alone in would invite you to talk to yourself.

The capability model is untouched: the composer still explains *why* it is
disabled, still offers "Set up encryption" / "Unlock encryption" / "Check again",
and every blocker is still repeatable from the same place.

### Delivery and recovery

Pending and failed sends, saved edits and deletions, and recovery drafts are
**raised rows** directly above the composer, each with the actions it had before
— Retry, Copy, Edit, Discard, Restore into the composer. One real fix along the
way: those panels painted their errors with `var(--text-danger)`, a token that
does not exist, so failures rendered in inherited ink. They are
`text-accent-danger` now.

### Pins, threads, search, members

They are contextual plates on the gutter beside the channel, mounted only when
open. Nothing about their behaviour changed.

---

## 4. Verification

Run from `client/`.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint . --quiet` | pass, 0 findings |
| `npx vitest run` | **252 files, 2279 tests passed** |
| `npm run build` | pass |
| `npx playwright test` (mocked smoke) | WP5's flow green; see the note below |
| `npm run test:a11y:static` | pass for WP5's files (it caught one: the reply chip had no name) |
| `npm run test:contrast` | 49 checks × 4 themes passed |

> **The smoke.** The two remaining failures at the time of writing are one flow
> run twice (desktop and touch), both at `smoke.spec.ts:698` on
> `getByRole('listbox', { name: 'Buildings and rooms' })` — WP2's sidebar
> assertion, ahead of its implementation in the shared worktree. Every WP5
> assertion in that flow passes, including the three composer-placeholder
> assertions WP7's checkpoint left for this package, the header's control count,
> and the DM header's people sheet.

### WP5's own tests

- `components/message/messageLight.test.tsx` — the channel-lit event, rule by rule
  (already lit is not news, an emptied channel drops its event, a channel you are in is
  not an invitation, a text channel is not an event, the cap), plus the DM header's
  sentence.
- `components/message/TextRoom.test.tsx` — the header strip's "5 reading · 19
  lights on", the server-as-breadcrumb, the absence of any member-list control,
  the pins count, the in-channel meta (and its refusal to claim a channel for somebody
  whose lights are off), the channel-event row, the composer copy in all four
  cases, and the timeline's small shapes.
- The older message and header suites keep their subjects and stub the light
  seam through `src/test/messageLightMock.ts`. Those suites mock the stores down
  to the two or three fields their subject needs; light reads half a dozen more,
  so wiring it through them would make each one a fixture for a question it is
  not asking. The seam itself is covered by the two files above, against real
  models.

### Screenshots

```bash
PARACORD_E2E_DESIGN=1 PARACORD_E2E_DESIGN_WP=wp5 npx playwright test e2e/design-review.spec.ts
# → output/design-reference/wp5/ (gitignored)
```

Twelve frames at **1440×900 and 390×844**: `text-room`, `text-room-people` (the
sheet open), `text-room-pins`, `dm`, `dm-index` and `dm-needs-setup` — the
first-DM encryption-setup state, driven by a capabilities response that reports
an encrypted conversation this device has no identity for. All inspected against
`output/design-reference/Channel.png`; the three things they caught are in §3.

---

## 5. Decisions a reviewer should see

1. **The member list is gone from the header**, in a guild channel and in a group
   DM (§6.5). `smoke.spec.ts`'s member-list assertions were rewritten to assert
   its absence and to open the people sheet instead. `ContextPanel`'s `members`
   mode still exists — it is reachable from the mobile swipe gesture in
   `AppShell` — and removing that last door is WP8's sweep.
2. **The composer placeholder changed**, so three `smoke.spec.ts` assertions
   moved with it; WP7's checkpoint explicitly left them for this package.
   `e2e/production-messaging.spec.ts` and `e2e/real-server.smoke.spec.ts` (both
   real-server suites, outside the default gate) still select the old
   `Message #channel` placeholder and will need the same one-line change when
   those suites are next run.
3. **`HereNowStrip` gained one optional prop** (`caption`). §7.2 and §7.4 word
   the same strip differently and only the calling surface knows the verb. It is
   additive and defaults to WP1's sentence.
4. **`ChannelSwitcher` was restyled** (Gabarito 20px trigger, `pc-floating`
   menu). It is the channel name in the header and had no other owner; the hash
   icon is gone for text channels because the window dot beside it now says what
   kind of channel it is, and it is kept for voice/stage/forum/announcement, which
   the dot cannot distinguish.
5. **Pins/threads are primary controls above the small breakpoint and overflow
   items below it.** §7.4 puts them in the header; layout-spec §7.8 folds them
   into the labeled overflow menu on narrow screens. Both are true at once.
6. **The pins count costs one request per channel.** Threads are counted from the
   channel list for free; pins have no count endpoint. The five-minute cache
   keeps a channel switch from re-asking, and a failure leaves the control
   countless rather than wrong.

---

## 6. Left for later

- **A real channel-presence signal.** The strip's "5 reading" is WP1's floor,
  not a ceiling: a silent lurker is not counted. If the server ever emits
  "user is viewing channel", it becomes term (d) of the reading definition and
  this header improves without changing.
- **WP8** — `ContextPanel`'s `members` mode and the mobile swipe that opens it
  are the last docked-member-list door; the two real-server e2e suites still
  select the old composer placeholder; `styles/components.css` still carries the
  `.chat-header-action` / `.chat-header-active` rules, now unused (the header
  keeps only `.chat-header`, `.chat-header-actions`, `.chat-header-connection`,
  `.chat-header-dm-name`, `.chat-header-mobile-dm-title`,
  `.chat-header-capture-status`, `.chat-header-navigation` and the two attention
  badges).
