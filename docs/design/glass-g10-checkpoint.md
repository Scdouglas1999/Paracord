# WP-G10 checkpoint: timeline bubbles

Contract: `docs/glass-spec.md` §2.4 (bubble grouping and joined corners), §3.2 (messages), §9.
Plan: `docs/design/glass-plan.md` WP-G10 row, §5, §6 ("MessageList monolith"). Frame: WP-G7's
`.glass-conversation__timeline` region. Nothing is committed. Everything is in
`~/Documents/Paracord-glass` (branch `design/glass`).

The timeline is bubbles now. It is still the same `MessageList`: virtualization, the scroll
machinery (bottom follow, prepend anchor, jump to message, hash and `?message=` jumps), roving
keyboard navigation, edit, delete confirm, bulk delete, reply, threads, reactions, attachments,
report, forward, remind, save and the context menu are unchanged in behavior. Only the row model
and the row markup changed.

## Files

| File | Change |
|---|---|
| `client/src/components/message/MessageList.tsx` | Row model gains `isLastInGroup` and `isSystem`; grouping rules; the message row, typing row and system line rewritten as Glass markup; `MessageRowMemo` deps updated; scroller and empty state put in the column; `paddingStart`/`paddingEnd` on the virtualizer. New exports `isSystemMessage`, `systemMessageText`, `markSelfMention`. |
| `client/src/components/message/TimelineParts.tsx` | Glass shapes: `TimelineAvatar` (plain 32px face), `MessageActions` (react / reply / more, 26×22, the prototype's glyphs), `TypingBubble`, `typingSentence`, `isToday`; `DayDivider` is a centered kicker; `ReplyChip` is the quote at the top of a bubble; `RoomLitEventRow` a centered amber line; `ThreadRow` and `AttachmentFrame` restyled (the frame takes `joinTop`). `timelineTime` now gives the locale's own "9:02 PM" from one cached formatter. `AuthorMeta` and `TIMELINE_GUTTER` are gone. |
| `client/src/styles/glass-timeline.css` (new) | All timeline CSS. Tokens only, `@layer components`. |
| `client/src/styles/globals.css` | One import line after `glass-layout.css`. |
| `client/src/components/message/MessageList.bubbles.test.tsx` (new) | 12 tests (below). |
| `client/src/components/message/MessageList.a11y.test.tsx` | The two assertions on Lantern markup rewritten (jump highlight via `data-jump`; the actions by their new names, in the header); one focus-within test added. |
| `client/src/components/message/TextRoom.test.tsx` | The `AuthorMeta` ("in Shop floor") tests replaced by tests for the face, the actions, the typing sentence and the clock; the day divider test also checks it is a named separator. The composer tests there are untouched. |

`messageLight.ts` did not need to change.

## The row model

For each loaded message (`rows` memo):

- `isGrouped` (continues the group above): same author (`shouldGroup`, 7 minutes, unchanged),
  **and** no day change between them, **and** the message is not a reply, **and** neither it nor
  the one above is a system message. Two fixes fell out of this: a pair straddling midnight used
  to group *across* its own day divider, and a pin notice could group with its author's words.
- `isLastInGroup`: the next message does not continue this group. Computed from the same
  `joinsPrevious` array, so first/last can never disagree.
- `isSystem`: `message_type` 1–8 (the server's `MessageType` incl. `SystemMessage = 8`, which the
  client enum does not name).
- A day kicker goes between days, and above the oldest loaded message **only when it is not
  from today** (the references open today's conversation with no "Today"; an older conversation
  still states its day).

A reply starts a new group (its name line sits above the quoted context); the reader's own
following messages can join it. Reply nesting indentation and guide lines are gone:
`computeReplyLayout` still resolves the parent (and stays exported and tested), the depth is no
longer drawn.

### MessageRowMemo deps

Added: `isLastInGroup` (a message arriving under this one from the same author moves the face
down, and this row must redraw), `row.isSystem`, `mentionsMe`. `mentionsMe` also fixes a latent
bug: it depends on the reader's roles (`myRoleIds`), which were not in the deps, so a role
mention highlight could stay stale after roles loaded. Removed: `replyDepth`, `guildRoles` (role
colors are no longer drawn; `roleNameMap` stays for reply previews). `selfMentionLabel` derives
from `mentionMap` and `me`, both already deps.

## Markup (what later packages can rely on)

```
div.glass-msg.glass-tl-col[role=article]  data-own data-grouped data-last data-mentions-me
                                          data-jump data-from-room data-variant data-coarse
  span.glass-msg__check        (bulk delete)
  span.glass-msg__face         (others only; the face only when data-last)
  div.glass-msg__body          (container `tl-body`)
    div.glass-msg__head        name, chips, time, reminder, expires, [actions]   (first of group, others)
    div.glass-msg__head--own   anonymous / reminder / expires, only when there is one  (yours)
    div.glass-msg__line        div.glass-bubble[data-join-top] (+ actions beside it)
    div.glass-msg__card        poll / score / feed card, in place of a bubble
    components, embeds (.glass-msg__extras), threads, ReactionRow, stickers,
    div.glass-msg__attachments > .glass-tl-media[data-join-top]
  div.glass-msg__menu          (the "More actions" menu, hung from the row)
```

Corners (§2.4): every bubble keeps a 6px corner at the bottom on the author's side (the join to the
next, and on the last one the tail); `data-join-top` adds the 6px top corner for every piece after
the group's first. Yours mirror on the right. Attachments get the same shape; the frame's footer,
shadow and size are left for G13.

Max width: `min(560px, 100%)`. 560 is 78% of the 720 column; the side-by-side (420px pane) and
phone references show bubbles using the full width of a narrow column, so the cap is absolute
rather than a share (renders win on look).

Column: every row is `.glass-tl-col` = `min(720px, 100% − 2 × pad)`, centered. It does not rely on
the scroller's padding, so it lands on the column with or without a frame adapter padding the
feed. Pad is `--glass-column-pad` (28), 12 on the phone frame, 14 in the ribbon variant.

Fade: `mask-image` on the scroller, 28px (a mask rather than a painted gradient, because the pane
behind carries the room glow). The virtualizer gets `paddingStart: 28` so the first row clears the
fade, `paddingEnd: 16` above the composer.

### Hover actions

React / reply / more, 26×22, ink-2, wash on hover, `aria-expanded` on more. Shown for the hovered
**or focused** row (`onFocus` bubbles, so focus-within works), and while its menu is open. Where:

- first message of someone else's group: in the header, 6px after the time (as the prototype);
- a continuation, or your own message: beside the bubble, absolutely positioned so revealing
  them never changes the row's height (no virtualizer re-measure on hover). In a body narrower
  than 660px (side by side) they become a small `--raise` plate over the bubble's top corner;
- a message with no bubble (only a picture or a card): a plate at the far side of the column;
- coarse pointer: under the bubble, revealed by tapping the message (a tap focuses the row,
  `tabIndex=-1`). This replaces the always-visible 32px "Message actions" chip that Lantern put
  on every row on touch screens.

"Reply" appears only when the surface passes `onReply` (it used to render a dead button).
Labels are "React to {name}", "Reply to {name}", "More actions" (the prototype's).

Hover is per message, not per group: acting on "the group" would leave no way to reply to its
third message, and the hover state lives on the row the pointer is over (the timeline's existing
scroll hold still applies).

### The mention chip

`lib/markdown.ts` (G13's) draws a user mention as a span with inline styles and no identifying
attribute, and it is not in this package's scope. `markSelfMention` walks the parsed nodes of a
mention-of-you message and swaps the span whose text is exactly the reader's mention ("@Sean") and
whose fill is markdown's mention fill for `.glass-mention-self` (white chip). Only that mention:
another person's in the same bubble is untouched. "the self mention seam" in
`MessageList.bubbles.test.tsx` runs the real markdown, so if markdown changes how it draws a
mention the test fails instead of the chip quietly disappearing. **G13:** when you own the chip
rendering, give mentions a `data-user-id` and delete `markSelfMention`.

### Other rows

- Typing: one row per typist (up to three): the typist's face and a 58×34 `--bub` bubble of three
  6px dots (opacity only, 1.2s, 0.15s stagger; still under reduced motion). The sentence
  ("Eric is typing") is `sr-only`. The old visible "X is typing" line is gone.
- System messages: centered 13px ink-3 line plus the time; still an `article` in keyboard order.
- Day: centered kicker (ink-3). A named `separator`.
- A voice channel going live while you read: centered line, amber dot, amber "Join".
- "Delivered" under your last message: 12px instrument cut, ink-3, right-aligned in the column.
- Own bubble: the ink tokens (and their Tailwind `--color-*` twins, which resolve where declared)
  are re-pointed at `--own-ink` inside it, so links, code, quotes and the reply context stay
  legible on the light fill.

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run src/components/message/` (after G11's composer work settled) | pass for my suites: `MessageList.bubbles` 12, `MessageList.a11y` 11, plus anonymous, deleteConfirm, hashJump, helpers, mentions, `TextRoom` |
| `npx vitest run` (full) | 3,388 pass, **3 fail, none in this package**: `pages/AppShell.test.tsx` ×2 (looks for `data-testid="unified-sidebar"`, i.e. G9's places panel replaced it) and `components/home/home.test.tsx` ×1 ("a lit server card", `TypeError … reading 'filter'`). Earlier in the session `MessageInput*` and `TextRoom`'s composer tests failed while G11 was mid-change; they pass in the final run |
| `npm run test:tokens` | pass (741 files) |
| `npm run test:motion-lint` | pass (747 files) |
| `npm run test:contrast` | pass |
| `npm run lint` | 1 error / 261 warnings, none in my files: errors are `e2e/g11tmp/glass-review.spec.ts` (unused imports, G11's temp spec) and `components/glass/places/useUnreadMessageCounts.test.ts:92` (G9). `eslint` on my five files: 0 errors, 1 pre-existing warning (`useVirtualizer` and the React Compiler) |
| `npm run test:a11y:static` | fails on `components/ui/Button.tsx:19` (native `confirm()`), G21's file in progress; nothing from this package |
| `npx vite build --outDir <scratch>` | pass; the container query and mask are in the output CSS |

Perf, `MessageList.bubbles.test.tsx` "draws 500 messages and does not redraw one of them when
somebody starts typing": 500 messages in groups of three, every row mounted (virtualizer mocked to
render all), faces counted per render through a wrapped `TimelineAvatar`. Typing starts: the
typist's face renders, **no message row's face renders again**. Hovering one row redraws exactly
that row (+1). Mutation check: adding `activeTyping` to the deps makes it fail (504 vs 378).

Other new tests: first/continuation/last edges (header only on the first, `data-join-top` from the
second, face only on the last); the face moving down when the same author writes again (the memo
sees the new edge); midnight breaking a group with a kicker; no kicker for a today-only
conversation; a reply starting a group with its context inside the bubble; own message (no face,
no header); mention bubble raised with the white chip on your mention only; the self-mention seam
against real markdown; system line not a bubble and the system type helpers; typing bubble with
the typist's face and the sentence.

### Screenshots (`output/design-reference/glass-build/g10/`)

The harness's own webServer ports (4173/4175) were held by another agent's live run both times I
tried `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g10 npx playwright test e2e/glass-review.spec.ts`,
so I ran the same scene (`e2e/fixtures/glass/install.ts` + `scene.ts`) from a scratch config on
ports 4473/4475 (not in the repo). Same viewports, clock, timezone and locale.

- `01-conversation-desktop.png`, `02-quiet-desktop.png`, `07-phone-phone.png` (+ `.json` with each
  row's bubble/face/media rects, radii and fills), `side-420-desktop.png` (1024×768, fluid column)
- `hover-group-desktop.png` (first of Brendan's group), `hover-continuation-desktop.png`,
  `hover-own-desktop.png`, `hover-media-desktop.png`
- `../g10-before/` the same three states before this package

Against the references, bubble by bubble:

- **01** Own "home in 20…": `#ecebe6`, dark ink, corners 20/20/6/20, right edge at x 1246 as in
  the reference (it is scrolled just above the fold in our shot because the picture below is
  taller, G13). Brendan: name/time at x 582 (reference 582), bubbles from x 568 (568), first
  bubble 6px bottom-left, second joined top and bottom, face at x 526 bottom-aligned with the last
  bubble. Vincent, Nick: single-author groups, face beside the last piece; Nick's face sits beside
  the picture as in the reference. Group gap 12, bubble gap 4, bubble height 40 (reference 40).
  Jeremy: bubble fill `(57,52,49)` = `--raise` warm, `@Sean` chip `#f3f5f5` on `#111214`. Typing:
  58×34 dots bubble beside Eric's face. Fills: `--bub` resolves to `(46,40,38)`.
- **02** Eric / Luke / Eric: same x positions; y within 3px of the reference (the composer region
  is G11's). Eric's two bubbles show the joined corners (see "prototype bug" below).
- **07** bubbles use the column's width and wrap like the reference ("@Sean is Movie night still
  on? I'm / bringing the projector"); face column 32 + 10.
- **Hover** matches the prototype's `.acts`: three ink-2 glyph buttons 6px after the time.

Differences that remain, all owned elsewhere: no "6 new since 8:58" divider or Mark read (G13;
there was no unread divider in the timeline before this package either, so nothing was removed);
Brendan's second message is plain text rather than the Haz 5 plan card (G13, the fixture says so);
no "Lounge 3 in" and "Movie night Fri 9 PM" chips (G13); reactions are a row under the text rather
than one chip biting the picture, and the picture is 400px with a filename/Open/Download footer
rather than 240×135 (G13); faces are initials (fixture).

**Prototype bug worth knowing:** in `GlassV14*.dc.html` every text bubble's style reads
`box-sizing: border-box border-bottom-left-radius: 6px;` (no semicolon), so the browser drops the
radius and the renders show text bubbles fully round, while the plan card and media (written
correctly) show the joined corners. The spec text (§2.4) and the correctly written pieces agree
on the joined shape, so the bubbles follow the spec.

## Things removed or changed on purpose (not silently)

- **"in Lounge" on a message's meta** (Lantern §7.4, `AuthorMeta`) and the presence rim on
  timeline faces: the references draw name and time only, and plain faces, even for someone
  talking in the Lounge. Presence lives in the places panel and the pill now.
- **Role colors on author names**: names are ink-1 (13/600) as in the references. Role colors
  still exist elsewhere (member list, role chips).
- **`fromRoom`** (`inRoomUserIds`, the Stage ribbon's "from the room" raised row): the prop is
  kept and the row carries `data-from-room`, but nothing draws it. The ribbon is Lantern's stage
  chat; G14 decides whether the Glass stage chat wants it.
- **Reply nesting indentation and guide lines**: replaced by the quote inside the bubble.
- **The touch "Message actions" chip on every row**: replaced by tap-to-reveal (above).
- `styles/primitives.css` `.pc-message-row` (the `--row-bg` fill) no longer matches anything;
  not my file, safe to delete in G22.

## Left for G13 (and notes for others)

- Catch-up divider ("6 new since 8:58" + Mark read): a new `VirtualRow` type before the first
  unread message; the read state is in `useReadStateStore`. Row estimate goes in
  `estimateSize`.
- Reactions as one chip biting the media's top-right (`#34353a` / `--chip-react`, 3px `--solid`
  ring): `ReactionRow` is rendered after threads today; it needs to move into the media's
  wrapper, and the virtual row must allow `overflow: visible` (it does; the rows are only
  transformed, not clipped).
- Media: the frame already has the bubble shape and joined corner (`.glass-tl-media`,
  `data-join-top`); size (240×135 look), shadow and the footer are yours. The low-bandwidth and
  file-row variants still use their Lantern classes.
- Inline live-channel and event chips, the plan card for events/polls: cards render inside
  `.glass-msg__card[data-join-top]`, which does not restyle them.
- Mentions: give markdown's mention a `data-user-id`, style the self chip there, delete
  `markSelfMention` and its seam test.
- `EphemeralMessage`, `ForwardedCard`, `MessageEmbedCard`, `GitHubEventEmbed`, stickers and
  `MessageComponents` sit inside or under the bubble untouched.
- The mask on the scroller is one more composited layer while scrolling; worth including in G23's
  WebKitGTK CPU measurement.
