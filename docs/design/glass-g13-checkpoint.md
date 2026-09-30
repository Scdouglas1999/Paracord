# WP-G13 checkpoint: timeline cards

Contract: `docs/glass-spec.md` §1, §2, §3.2 (media, reactions, catch-up divider, inline chips,
plan card), §9. Plan row: `docs/design/glass-plan.md` WP-G13, §5, §8 (owner: events and polls get
the plan-card style now, event capacity later). Builds on WP-G10's bubble timeline, and on the
"left for G13" list in `glass-g10-checkpoint.md`. Nothing is committed; everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

What a message carries besides words is Glass now: media with the joined corner and no footer,
reactions as one chip, the catch-up divider, the live-channel and event chips, mention chips that
name who they are for, and the plan card for events and polls. `MessageList` keeps its
virtualization, scroll machinery, keyboard navigation, edit, delete, reply, threads and
reactions; the rows it draws for these things changed.

## Files

| File | Change |
|---|---|
| `client/src/components/glass/cards/` (new) | `MediaFrame.tsx` (`GlassMedia`, `MediaTool`, `GlassFile`), `ReactionBite.tsx`, `CatchUpDivider.tsx` + `catchUp.ts`, `InlineChips.tsx` (`ChannelMentionChip`, `EventChip`), `PlanCard.tsx` (`PlanCard`, `PlanAction`), `EventPlanCard.tsx`, `useGuildEvent.ts` (event cache, RSVP), `eventTime.ts`, `eventRefs.ts`, `CardGlyphs.tsx`, `useNow.ts`, `index.ts`; 6 test files |
| `client/src/styles/glass-cards.css` (new) | All the CSS for the above. Tokens only, `@layer components` |
| `client/src/styles/globals.css` | One import line after `glass-timeline.css` |
| `client/src/components/message/MessageList.tsx` | Render sites only (below). `ReactionRow`, `markSelfMention`, `MARKDOWN_MENTION_FILL` and the Lantern attachment footers are gone |
| `client/src/components/message/PollMessageCard.tsx` | Rewritten as a plan card. Voting logic unchanged |
| `client/src/components/file/MediaPreview.tsx` | Glass video shape; the captions line is a quiet text row (file input hidden behind its label) |
| `client/src/lib/markdown.ts` | `data-user-id` on mentions; `selfUserId` option; `<#id>` and `<event:id>` tokens; previews say "an event" |
| Tests | `MessageList.bubbles.test.tsx` (+15 tests, seam test rewritten), read-state mock gains `getReadState` in the four MessageList suites that mock the store, `PollMessageCard.test.tsx` (new, 7), `markdown.test.ts` (+7) |
| `client/e2e/fixtures/glass/scene.ts`, `install.ts` | The scene now uses `<event:7001>` (Brendan's plan card), `<#2002>` (Vincent's live chip) and `<event:7002>` (Jeremy's event chip); a single-event route; a reaction-people route; `tall` and `doc` attachment keys for review shots |
| `client/e2e/glass-review.spec.ts` | **Outside my list.** Two `expectText` regexes: `/Movie night still on/` became `/still on\? I'm bringing the projector/`. With the event chip drawn, "Movie night" is no longer contiguous with "still on" in the page text, so the old regex could never match again and states 01 and 07 would fail for everyone. Two-line change; revert it if you would rather change the fixture instead |

### Render sites in `MessageList.tsx`

- **Row model:** a `catch-up` `VirtualRow` (`estimateSize` 40) and the group break it causes
  (`joinsPrevious[i]` is false at the boundary, so the previous message becomes `isLastInGroup`).
- **Bubble line:** `data-bitten`, and the reactions chip as a child of the line.
- **Cards:** score, feed, poll and event wrappers; `glass-msg__card--plan` gives a plan card a
  width; event cards for a message that is only `<event:ID>` tokens.
- **Attachments:** `GlassMedia` for pictures, `GlassFile` for files and for pictures with previews
  off; `ResolvedAttachmentImage`'s placeholder is the frame's own tone, and a failed load now says so
  instead of sitting on "Loading attachment…" forever.

## Decisions

### Media (§3.2)

- **Size:** 240px wide (the reference's 240 x 135 for a 16:9 picture), never taller than 320px. The
  frame takes the attachment's own `width`/`height` when the server sent them (so it holds its shape
  while loading) and crops with `object-fit: cover` past 320px; without dimensions it is 16:9 while
  loading and the picture's own shape after. A small picture is scaled up to the frame's 240px; say if
  you would rather cap it at its natural size.
- **Corner and shadow:** radius 20 with the group's 6px join on the author's side (top join when it
  follows a bubble or another picture), mirrored for your own; `--sh-raised`, no outline.
- **Footer: none.** Open is the picture itself (the lightbox, which also downloads). Download and, on
  your own pictures, Delete are 30px near-solid icon buttons over the bottom-right corner, shown on
  hover and on focus-within, and always on a touch screen (`data-coarse`), where there is no hover.
  A federated picture keeps a small "Federated" label in the top-left corner (its hash in the
  tooltip). "Preview off" and the generic file row became one `GlassFile` card (icon tile, name,
  size, Download and Delete as text); the file's name is still a button that downloads it.
- **A hard rule found on the way:** `container-type: inline-size` (the plan card) and a percentage
  `width` (the media host) both collapse to nothing inside `.glass-msg__attachments` and
  `.glass-msg__card`, which shrink to their content. The media host has a definite 240px width and
  the plan card's wrapper carries `glass-msg__card--plan` (`width: 100%`). Keep that if you touch it.

### Reactions (§3.2)

- **ONE chip** (`#34353a`, 3px `--solid` ring), an icon and a count for each reaction. Each reaction
  is still its own button: `aria-pressed` for yours (brighter ink and a faint fill), the label reads
  "🔥, 5 reactions, including yours", resting on it opens who reacted (or a right-click: the whole
  list, from `reactionUsersApi`), a click toggles yours. Arriving reactions still pop and leaving ones
  shrink (`useFlipList`). The chip wraps to a second row past 320px rather than growing without bound.
- **Icons:** the flame (🔥) and the heart (❤️ ❤ 🤍 ♥️) are drawn as Paracord's own line marks, as the
  reference does; every other reaction is drawn as itself (emoji, or a custom emoji's picture). The
  people list header shows the real emoji.
- **Where it hangs** (`ReactionPlacement`):
  - `media`: off the picture's top-right, 12px up and 18px out, exactly as the prototype. It is a
    child of the media host, not of the frame that clips the picture.
  - `bubble` / `card`: **a deviation from "the same way", on purpose.** A bubble or a card has words
    and a button in that corner (a plan card's "Take the spot" is there), and the reference's
    12px-up placement covers the top 3-4px of the first line. The chip is anchored by its bottom edge
    8px into the corner, so it rides above it, a wrapped chip grows upward, and the row gets 16px of
    room (`data-bitten`). Mirrored to the top-left for your own.
  - `inline`: the same chip in the flow for a message with nothing to bite (a sticker, an embed, an
    encrypted attachment, or while editing).
  - The overhang is clamped by the column's side room (`min(18px, --tl-pad - 4px)`), so on the phone
    (12px) the chip is 8px out and is never clipped by the scroller.
- **Add reaction is unchanged:** the React action beside the name, on focus-within, and "Add
  reaction" in the message menu. There is no plus in the chip (a test pins that the action is one
  gesture away).

### Catch-up divider (§3.2)

- "6 new since 8:58" (instrument cut, 600), hairlines either side (`--glass-hair`), "Mark read" as a
  text button (28px, ink-2). It sits above the first message **from somebody else** after the read
  position. Your own messages and system lines neither open it nor count.
- **From the read state at open time:** `markLatestRead` reads the position with
  `getReadState(...).last_message_id` **immediately before** it moves it, once per conversation opened
  (the list is keyed by channel, so the ref resets for free). A unit test pins the order (the mutation
  "read after `markRead`" fails). "Mark read" clears the marker and calls `markLatestRead`.
- The label quotes the clock bare when it was today ("8:58", the reference's form) and names the day
  otherwise ("Tue 8:58 PM"). "Since" comes from the read position's own snowflake, so it is right even
  when that message is not loaded. If the loaded history starts inside what you missed and more
  exists, it reads "50+ new".
- The boundary splits a group: what you missed starts a new one (name and time above it), so a
  divider never sits between two bubbles of one author with no header.
- **Known edge:** if the account's read states have not loaded when the conversation opens,
  `markLatestRead` marks it read first and there is no position to catch up from, so no divider. A
  channel that has never been read has none either (30 "new" over an empty read state would be noise).
  Not fixable in this scope without delaying the read write.

### Inline chips and mentions (§3.2)

- **Live channel chip:** a channel mention (`<#id>`) of a voice or stage channel with people in it:
  amber tint, amber dot, "Lounge  3 in" (the count is `voiceStore.channelParticipants`). Every other
  channel mention is a quiet chip with the name only, never a `#`. A channel that is gone or not
  visible reads "a channel" and is not a button. A live or quiet chip goes to
  `/app/guilds/:g/channels/:c`.
- **Event chip:** `<event:ID>`: calendar glyph, the name, a short time ("Fri 9 PM", "Today 9:30 PM",
  "now").
- **Wire syntax is mine to introduce: `<event:ID>`.** Nothing in the client or the server made an
  event referable from a message before (no embed, no link). It follows `<#id>`/`<@&id>`, is resolved
  against the conversation's server, and an older client shows it as typed. A message that is *only*
  event tokens is an event share and draws as a plan card; an event inside a sentence stays a chip in
  it. **Nothing emits the token yet**: the composer (G11) and the events list (G21, "Share to
  channel") are not in this scope. Until then it appears in messages that a bot, the API or a person
  typing it sends. A follow-up should also decide whether to carry the name on the wire
  (`<event:ID:name>`) so panel previews and notifications can say "Movie night" instead of "an event".
- **Mentions:** `parseMarkdown` gives every user mention `class="glass-mention"` and `data-user-id`;
  with `{ selfUserId }` the reader's own is also `glass-mention-self` (the white chip, glass-timeline.css).
  `markSelfMention` is deleted and its "seam" test rewritten against `parseMarkdown` directly. Other
  people's mentions are a quiet chip. `getCachedParsedMarkdown`'s key includes the reader.
- **Ink:** chips inside your light bubble keep their own dark fills, so `glass-cards.css` copies
  `--ink-1/2/3` to `--card-ink-*` on `:root` (a value, not a live var, so a bubble re-pointing `--ink-*`
  does not reach them; High contrast still does, being on the same element).

### Plan card (§3.2, plan §8)

- `--raise`, radius 20 with the joined corner, `--sh-raised`, 12px 16px padding, at most 452px; the
  title (15/600), the time-and-place line (13, ink-2), the decision top right as text ("Take the spot",
  and "You're in" with a check once taken; pressing again gives the spot back), slots as 28px faces
  with names in a 4-column grid, a dashed circle for an open slot.
- **Names hide under 340px of card content** by a container query on the card itself, as in the
  prototype (`@container (max-width: 340px)`, evaluated on the content box, so the card hides them at
  372px and under; measured in Chromium: 374 shows, 372 hides). The faces stay and every name is still
  in the accessible text. The 322px card of the side-by-side pane and the phone's 324px card hide them.
- **Events** (`EventPlanCard`): one `GET /guilds/:g/events/:e` per event however many chips and cards
  name it, kept fresh by the gateway's `paracord:scheduled-events-changed`; RSVP is the existing
  `PUT`/`DELETE …/rsvp`. "Tonight at 9:30 PM in Lounge · 3 going". **Slots are what the server can vouch
  for**: the host ("Brendan, Host") and you (your face, ringed, once you are in). The dashed circle is
  *your* spot ("Your spot"), open until you take it. The server returns a count and whether you are
  going, not who, so it cannot show every face and does not pretend to. Capacity ("1 open") is the
  owner's "later". An event that is over or canceled has no decision; one that is gone says so.
- **Polls** (`PollMessageCard`): the question is the title, "Pick one · 6 votes · 2h left" the line,
  each option a row (a well one step down) with its share as a left-origin `scaleX`, a check for yours,
  "Closed" in place of the decision when it has ended. Voting, the 15s refresh and the expiry timer are
  unchanged.

## Verification

Commands run in `~/Documents/Paracord-glass/client`.

| Command | Result |
|---|---|
| `npm run typecheck` | **My files pass.** The whole run currently fails on two files that are not mine and are in other agents' hands: `src/components/layout/overlays/SearchOverlay.tsx(874)` (`bodyRef` on `SheetFrameProps`, G18 in progress) and `src/gateway/dispatch.ts(598)` (`handleWatchersUpdate` missing from `VoiceStoreState`, the media work). It was clean before those landed, and a filtered `tsc` for `glass/cards`, `MessageList`, `PollMessageCard`, `MediaPreview`, `markdown` and the e2e fixtures reports nothing |
| `npx vitest run src/components/glass/cards src/components/message src/components/file src/lib/markdown.test.ts` | pass: 35 files, 355 tests |
| `npm run test:unit` (whole suite) | 3,619 pass, **15 fail, none mine**: `components/layout/TopBar.{summary,inbox,follows,dm}.test.tsx` (their `useMobile` mock has no `DEFAULT_MOBILE_MAX_WIDTH`; the Lantern header those tests cover was replaced by G11) and `overlays/SearchOverlay.test.tsx` (G18 in progress) |
| `npm run test:tokens` | pass (755 files) |
| `npm run test:motion-lint` | pass (761 files); opacity, transform and color only |
| `npm run test:contrast` | pass (40,242 comparisons). The audit does not cover the card chips; I checked them by hand (below) |
| `npm run test:a11y:static` | pass. It had failed at `glass/cards/PlanCard.tsx:123` (the decision button looked icon-only because its words are an expression); it now carries `aria-label` equal to its visible words |
| `npm run lint` | 1 error, 253 warnings; the error is `components/media/MediaGalleryPanel.tsx:27` (`displayName` unused, not mine). `eslint` on my files: 0 errors, 1 warning (`useVirtualizer` and the React Compiler, pre-existing) |
| `npx vite build --outDir <scratch>` | pass; the container query is in the CSS output |
| `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g13 npx playwright test e2e/glass-review.spec.ts` | 15/15 pass on the repo's own config (ports 4173/4175 were free this time). My extra shots used a scratch config on 4673/4675 outside the repo |

Contrast, by hand (arithmetic, not the audit): reaction chip ink-2 on `#34353a` about 7:1; event chip `--card-ink-2` on `#45464b` 5.4:1; the
live chip's "3 in" at the reference's 72% measured 4.45:1, so it is 80% (5.05:1), the one deliberate
departure from the prototype's numbers on a chip.

New tests (all pass): `catchUp` (boundary rules, own and system excluded, numeric id order, "or more",
"since" from the snowflake, label forms), `eventTime` and `eventRefs`, `ReactionBite` (icons, marks
yours, toggles, inline, people list, error), `PlanCard` and `EventPlanCard` (every state), `InlineChips`
(live, quiet, no `#`, navigation, gone, only voice counts), `useGuildEvent` (one request, RSVP, refusal,
404 vs error, gateway refresh), `PollMessageCard`, markdown (data attribute, self chip, tokens with and
without a server, previews), and in `MessageList.bubbles.test.tsx` the divider (above the first missed,
group break, read-before-move order, Mark read, absent), reactions (one chip on the bubble, on the
picture and outside its frame, toggle, React still reachable), media (open and download reachable, no
footer, delete on yours, join) and events (card vs chip).

## Screenshots (`output/design-reference/glass-build/g13/`)

- The seven states at both sizes (`01-conversation-desktop.png` … `07-phone-phone.png`), from the
  repo harness. `g13-before/` holds the same two frames before this package.
- `hover-media-desktop.png` (tools over the picture, the React/reply/more plate),
  `rsvp-taken-desktop.png` ("You're in", your ringed face, "4 going"), `reactions-people-desktop.png`
  (who reacted), `after-mark-read-desktop.png`, `plan-card-322-desktop.png`.
- `poll-desktop.png`, `poll-phone.png` (LFG's poll as a plan card).
- `words-own-reactions-desktop.png` / `-phone.png` (a wrapping 10-reaction chip above a bubble, a
  short bubble, your own picture with the chip mirrored to its top-left, your own bubble),
  `tall-and-file-desktop.png` (a 300x600 picture cropped to 240x320, a file card).

Against the references (`01-conversation`, `07-phone`, positions in px at 1440x900):

- **01:** own bubble at y 107 (reference 107); divider 173 (173) with "6 new since 8:58" and "Mark read"
  between hairlines; Brendan's name 210 (210); plan card 268-370 (269-370), x 568, 452 wide; Vincent
  394 (394); the live chip "Lounge 3 in" (amber tint, amber dot); Nick 474 (474); the picture
  240 x 135 at 533-668 (534-669) with the joined corner and soft shadow and no footer; the reactions
  chip at x 748-826, y 522-548 (748-826, 522-550) with the flame and heart marks; the `@Sean` white
  chip, the event chip "Movie night Fri 9 PM" (calendar glyph, `#45464b`).
- **07 (phone):** the plan card is 324px wide so its names hide and the faces stay, as the reference's
  narrow card; the chip bites the 240px picture. The pill, stream and header are other packages'.
- **04:** the harness state is still the Lantern voice-channel page (G14), so the narrow-card check
  is done on the phone frame and by measurement (above), not on 04.

## Differences left

- **The slots row is not the reference's.** The reference shows Brendan, Vincent, Luke ("10 min") and
  "1 open"; the server has no attendee list and no capacity, so the card shows the host and "Your spot"
  (see Plan card). The line also says "· 3 going". When capacity ships, the open circle becomes "1 open".
- **The reference's typing bubble sits between the picture and Jeremy's message; ours is at the end of
  the timeline** (G10's row order, untouched).
- **The places panel's preview of General reads "Jeremy: @Sean is an eve…"** (reference: "…is movie
  n…"). The panel's own model calls `messageSnippetText`, which now maps `<event:ID>` to "an event"
  (it cannot know the name; see the wire-name note). G9's `previewText` needs no change.
- **A picture-only message's actions** are still G10's plate at the far right of the column; the
  reference does not show one.
- The first frame after opening a conversation can show the divider a beat late (the marker is taken
  in an effect just before the read write, so the row is inserted on the next render); the timeline's
  follow-bottom keeps it pinned.

## Notes for others

- **G22 / whoever deletes Lantern:** `ReactionChip` in `message/ReactionPeople.tsx` is still used by
  `rooms/lobby/FeedItemMessage.tsx`; `ReactionBite` duplicates its who-reacted popover (about 100
  lines) because that file is outside my scope. A shared hook would remove the copy. `FilePreview.tsx`
  (an encrypted attachment's preview) still uses Lantern classes around `MediaPreview`.
- **G11 / G21:** an event needs a way to become `<event:ID>` in a channel (composer picker or "Share
  to channel" on an event row). The renderer is ready.
- **Media gallery / lightbox** were not touched.
- `parseMarkdown` gained a fifth argument (`{ selfUserId }`), and `FeedItemMessage`, `PinnedWidget` and
  `UserProfile` now get quiet mention chips through the shared CSS.
- The four MessageList suites that mock `readStateStore` (`a11y`, `bubbles`, `deleteConfirm`,
  `hashJump`) each gained `getReadState: vi.fn(() => undefined)`.
