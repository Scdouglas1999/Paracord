# WP-G11 checkpoint: header and message box

Contract: `docs/glass-spec.md` §1, §2, §3 (layout), §3.2 (header and message box), §5 (only the pill's
slot), §8 (phone), §9. Plan: `docs/design/glass-plan.md` §1.1, the WP-G11 row in §4, §5, §8. Nothing is
committed by this package. Everything is in `~/Documents/Paracord-glass` (branch `design/glass`).

The conversation slot is real now. `components/glass/conversation` exports the Glass `ConversationPane`
(76px header, notices, timeline region, message box, dock) and the header behind it; the G7 stub and its
adapter block are gone. The message box is `components/message/MessageInput`, restyled in place as the
52px capsule. Measured against `screens/01`, the title starts on the column edge (x 526), search,
members and the face sit where the reference puts them (x 1272, 1318, 1368), and the capsule is the
reference's (x 514 to 1258, 52px tall, 20px above the pane's bottom edge).

## Files

New (`client/src/components/glass/conversation/`):

| File | What it is |
|---|---|
| `ConversationPane.tsx` | The slot component. Regions keep the shell's `.glass-conversation__*` names. Phone: the pill's stacked slot above the header. A status line while system audio capture is on. |
| `ConversationHeader.tsx` | The 76px header, built from `subject`. Desktop and phone variants, the title's channel menu, search / members / face, the DM call control, "N new" on the phone. Keyed per conversation like `TopBar` was. |
| `HeaderAvatar.tsx` | Your face with a presence dot; opens the account sheet. |
| `useChannelMenu.tsx` | The channel menu's rows and the dialogs they open (catch-up summary, follows, inbox, shortcuts), moved unchanged out of `TopBar`. |
| `useDmCall.ts` | Start or end a DM call from the header (`TopBar`'s `handleDmCallToggle`, unchanged). |
| `sheetBridge.ts` | Interim door to the sheets (below). |
| `ConversationPane.test.tsx` | 30 tests. |

New: `client/src/styles/glass-conversation.css` (imported in `styles/globals.css` right after
`glass-layout.css`, unlayered).

Changed: `conversation/index.ts` (real exports); `message/MessageInput.tsx`, `MarkdownToolbar.tsx`
(no scale on press), `MessageInput.test.tsx` (with the sticker suite, the two MessageInput files went from 34 tests to 41), `MessageInput.sticker.test.tsx`;
`styles/glass-layout.css` (the `glass-stub-conversation` adapter block deleted, nothing else);
`glass/shell/stubs/ConversationPaneStub.tsx` deleted.

Outside my scope, reported rather than avoided (each is the test-side half of replacing the stub):

- `pages/DMPage.test.tsx`, `pages/GuildPage.test.tsx`, `pages/guild/TextChannelView.test.tsx`: their mock of
  `layout/TopBar` stood in for the conversation header; it now mocks `glass/conversation/ConversationHeader`
  (`GuildPage.test` keeps its `TopBar` mock too, because `GuildStateScreens` still draws `TopBar`).
- `components/message/TextRoom.test.tsx`: two assertions read `Message #general`; they read `Message general`.
- The orchestrator's G9 commit (`194af211`) already carries my deletions of the stub and of the adapter block.

## The header (§3.2)

Measured in Chromium at 1440x900, `screens/01` geometry in parentheses:

| Part | Measured | Reference |
|---|---|---|
| Header | 348,16 1076x76 | 76px |
| Title text | x 526, 20/600, tracking -0.01em | x 526 |
| Topic (or server name) | x 526, 13, ink-2 | x 526 |
| Search / members / face | x 1272 / 1318 / 1368, 40px, y center 54 | 1272 / 1318 / 1368 |
| Face dot | 10px, ring in `--solid` | white dot on the face's corner |
| Right cluster's edge | 1408 (16px in) | 1408 |

- **Title at the column edge, no dot, no `#`.** The row's start padding is `--glass-column-inset`, so the title
  follows the column at every width: 526 at 1440, 376 in a 1024 window (28px fluid), and so on.
- **The title opens the channel menu.** It is a button inside the `h1`; its hover wash reaches 8px past the text so
  the text itself stays on the edge. `aria-haspopup="menu"`, ArrowDown opens it, Escape returns focus to it. The menu
  opens under the whole heading (the topic too) and has the rows the Lantern "More" menu had: catch-up summary,
  pinned messages, threads (channels), manage follows (announcement channels), media, server leaderboard
  (channels), server settings (with permission), inbox, keyboard shortcuts. Search and people are not rows: they
  have their own buttons. Unavailable rows stay, disabled, with the reason (the catch-up summary).
  Dropped: the pin and thread counts (a Lantern nicety with no room in Glass); the inbox row keeps its unread
  caption and the title carries it as its accessible description.
- **Subtitle.** A server channel: the topic, else the server's name (screens/02: "Trips / Basecamp"). The phone
  always shows the server (screens/07). A DM has no topic; its line says how it is protected ("End-to-end encrypted",
  "Encryption locked on this device", ...) and says nothing until the server has answered (so "Not encrypted" is
  never a guess). A group DM's title is the group's.
- **Search, members, face.** Quiet 40px icons (no fill until touched), hover wash `--wash-hover`, press
  `--wash-press`, every one named, with tooltips. The face has a presence dot made of ink, not color: online a solid
  dot, away a ring, do not disturb a dot with a bar, invisible and offline a faint ring; the state is also in the
  button's name ("Your profile, online").
- **DMs** keep the call control (`Start direct message voice call`, disabled with the reason when calls are not
  allowed; `End direct message call` while in one) until the pill carries calls (G12). A group DM's people button
  is named "People in this message".
- **Compact frame (768 to 859).** `PlacesToggle` is first in the row, so there the title is 46px right of the
  column edge (the toggle is 36px plus 8px). Nothing else about the row changes.

### The pill's slot (for WP-G12)

`.glass-header__pill` is a flex item after the title: `flex: 1 1 0; min-width: 0; justify-content: flex-end;
height: 52px; margin-top: 6px; position: relative; z-index: 3`. It is 6px under the header's top, like the
reference's pill (y 22 to 74). Its right edge is the column's right edge (1246 at 1440); in a fluid pane, where
the column edge would land under the cluster, it stops 8px short of the cluster
(`padding-inline-end: max(column inset, cluster width + 8px)`). It takes what the title leaves, so the pill can
give up its labels when it is short (§5); it renders nothing and takes no space while `CallPill` returns null.
The expanded pill (column width, ~222px tall) has to escape the slot: it is a positioned child anchored to
the slot's right edge and `z-index: 3` is already above the timeline. The title is capped at `max(40%, 200px)`
and ellipsized, so a long name never runs under the pill. On the phone `CallPill layout="stacked"` is mounted
above the header in `.glass-conversation__phone-pill` (`screens/07` order), not in the header.

### Sheets (for WP-G18)

The Sheets slot still renders the Lantern `ContextPanel` from `uiStore.contextPanelMode`; nothing renders
`glassStore.sheet` yet. So each header button states its intent on `glassStore` (`openSheet('search' | 'people' |
'account')`, `closeSheet()`) **and** drives the panel that can show it today, from one file, `sheetBridge.ts`:

| Button | glassStore | Today's surface |
|---|---|---|
| Search | `openSheet('search')` | ContextPanel search (works; pressed state follows it) |
| Members, group DM | `openSheet('people')` | ContextPanel recipients (works) |
| Members, channel and 1:1 DM | `openSheet('people')` | **Nothing opens** until the people sheet exists. No Lantern surface lists members (§6.5 removed it). Recorded intent only |
| Face | `openSheet('account')` | Opens user settings (the status picker stays in the places panel's account plate) |

G18: replace `sheetBridge.ts` with a store-only version, and replace `useChannelMenu.tsx` (and the `ContextMenu` the
header renders from it) with `openSheet('channel')`. The header calls nothing else. `glassStore.sheet` can go stale
when the ContextPanel closes itself; nothing reads it today.

## The message box (§3.2)

A 52px glass capsule: `+`, the reply chip when replying, the input, emoji, send. Fill `--glass-fill-quiet` with
`--glass-edge` and a hairline, `backdrop-filter: blur(24px)` (a control: allowed), opaque `--sel` and no blur under
reduced transparency. Radius 26. It grows upward for a long draft (the field is capped at 50vh, send stays in view)
with its buttons at the bottom. One focus ring on the capsule (§9), not on each control.

- **Width: 744px, not 720.** The brief and §3.2 say "the column width"; `screens/01` and the prototype's CSS
  (`left: max(24px, (100% - 744px) / 2)`) draw it 12px wider each side, so the `+` sits over the avatar column. I
  followed the render (the spec says renders win on look). One variable flips it:
  `--glass-composer-bleed: 12px` in `glass-conversation.css`; set it to 0 for exactly the column (720; 28px fluid).
- **Send** is a quiet circle (`--glass-fill-quiet`, arrow at 40%) until there is something to send, then cream
  `--join` with `--join-ink`, hover `--join-hover`, press `--join-press` (the Join press color). It is a real
  disabled button until then. Under a poll it is enabled, as before; under scheduling it carries the clock.
- **Reply chip** ("Jeremy ×", 36px, `--glass-fill`) inside the capsule; the field says "Reply to Jeremy", and just
  "Reply" where the chip carries the name (phone, narrow). What was said is the chip's `title` and its group
  name is "Replying to Jeremy"; the old row above the composer is gone. Cancel is the chip's x.
- **Placeholders:** "Message General" (a channel), "Message Mara" (a DM), "Write a message" (no name), "Reply to
  Jeremy"; no `#` anywhere. `conversationKind` no longer changes the words; the prop and `composerPlaceholder`'s
  second parameter stay so callers and `TextRoom.test` need no edit.
- **Stack above the capsule** (solid, no outlines): the blocker row (with its Set up / Unlock / Restore /
  Check again routes), anonymous-posting note, command-thinking note, staged files, poll card, schedule card
  (now with a Cancel), scheduled panel, recovery and queue notices, draft-save and send errors (one danger ink).
  Unchanged in behavior; restyled as `--bub` / `--raise` surfaces.

### Where the secondary tools went

Decision: **one "+" menu.** The capsule carries only `+`, emoji and send, as the reference draws it. `+` opens the
existing "Message tools" menu (same `ContextMenu`, same name), which now stands **above** the capsule:

| Row | What it does |
|---|---|
| Attach files | the file picker (first, because it is the reason for the button); disabled with the reason when attaching is not allowed |
| Formatting tools | opens the Markdown toolbar over the capsule and puts the caret back in the field |
| Create a poll | the poll card (close it from the card) |
| Schedule message | the schedule card (cancel it from the card) |
| Stickers | server channels only |
| GIFs | |
| Emoji | only where the capsule has no room for its own emoji button |

Emoji keeps its own button while the capsule is 420px or wider; below that (a phone, the 420px side chat, a thread
panel, the Stage ribbon) it folds into the menu, and so does nothing else, so `screens/07` (no emoji in the
capsule) holds. The pickers grow from the capsule's right end as before. Mentions, slash commands, drafts,
drag and drop, paste, uploads (plain and encrypted), slowmode and refusal messages, the encryption blockers and
the ribbon and narrow variants are untouched in behavior.

Removed on purpose: the press scale on send and the send gesture's `relax` and `flash` (both scale; §9: nothing
scales on press). The words still lift out of the capsule (`liftOut`, transform and opacity).

## Phone (`screens/07`)

The header is 56px: the title (17/600), the server under it, "6 NEW" (kicker; the count is taken once, when the
conversation opens: messages from others after the read marker, so it is 6 in the scene), search and members as
quiet icons. The capsule is 50px with 38px controls; the reply chip and "Reply" placeholder follow the render.
Kept until WP-G20 replaces the phone frame: the Lantern drawer button (channels) and the way back to messages
(DMs). No face on the phone (the bottom bar has Settings).

## Commands

Run in `~/Documents/Paracord-glass/client`, on a box at load average ~19 with other packages editing.

| Command | Result |
|---|---|
| `npm run typecheck` | **fails on one error, not mine:** `src/components/glass/cards/CardGlyphs.tsx(9,11)` (WP-G13, in flight). Nothing else. Passed before G13's files appeared |
| `npx vitest run` (the full suite) | pass: 363 files, 3,553 tests (`DailyWordView.test.tsx` now passes; it no longer hangs) |
| `npx vitest run src/components/glass src/components/message src/pages src/components/layout` | pass: 76 files, 771 tests |
| `npm run test:tokens` | pass |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors, 255 warnings (mine: none new; `MessageInput.tsx` has the same 4 it had) |
| `npm run test:contrast` | pass (40,242 comparisons) |
| `npm run test:a11y:static` | **fails on one finding, not mine:** `src/components/glass/cards/PlanCard.tsx:123` (WP-G13). Passed earlier in the run, before that file appeared |
| `PARACORD_E2E_GLASS=1 PARACORD_E2E_GLASS_WP=g11 npx playwright test e2e/glass-review.spec.ts` | pass, 15/15 |
| `npx playwright test e2e/smoke.spec.ts --project=chromium` | **fails at `smoke.spec.ts:526`**, `getByRole('button', { name: /Switch channel, current:/ })`: the Lantern `ChannelSwitcher`, which is gone by design. Details below |

### The smoke spec

The spec is one long test and its header sections assert the Lantern header (`.chat-header`, the
"Switch channel" button, four `.chat-header-actions` buttons, "More channel actions", "Back to messages", "People
here now"), so it cannot pass with any Glass header. I did not edit it (WP-G22 rewrites it). To check the
composer, I ran a throwaway copy with those header blocks removed (deleted afterwards): every composer step passed,
at 320, 390 and 768 wide: the draft survives opening "More message tools", the menu is named "Message tools" and
Escape returns focus to `+`, the 30-line draft stays bounded with Send in view at 390x420, Enter sends, an unbroken
long word sends and does not overflow at 320, revoking the role disables Send and Enter while keeping the draft,
and the menu at 390x800 and at 390x420 stays inside the viewport with Create a poll and Attach files disabled and
Emoji reachable (the phone "Message tools" test the brief mentions passes; `ContextMenu.tsx` had G21's
uncommitted changes in the tree when it ran). The copy then failed at line 650 on the Lantern "Servers and channels"
listbox, which the G9 places panel replaced. That is not this package either.

## Screenshots

`output/design-reference/glass-build/g11/` (1440x900 and 390x844; the harness's own, plus extras from a
throwaway spec, deleted):

- Harness: `01-conversation-desktop.png` … `07-phone-phone.png` (`01-…-desktop`, `02-quiet-desktop`,
  `07-phone-phone` are the ones to read).
- Reply staged: `g11-reply-1440x900.png`, `g11-reply-390x844.png`. Text typed (send cream): `g11-typed-1440x900.png`,
  `g11-typed-390x844.png`. With a topic: `g11-topic-1440x900.png`.
- Menus: `g11-channel-menu-1440x900.png`, `g11-plus-menu-1440x900.png`, `g11-plus-menu-390x844.png`.
- Popovers and cards: `g11-mention-`, `g11-format-`, `g11-emoji-`, `g11-gif-`, `g11-poll-`, `g11-schedule-1440x900.png`;
  the search sheet: `g11-search-1440x900.png`.
- Widths and states: `g11-fluid-1024x768.png`, `g11-fluid-820x768.png` (compact), `g11-dm-1440x900.png`,
  `g11-long-1440x900.png` (long title and placeholder), `g11-contrast-1440x900.png` (high contrast),
  `g11-reduced-transparency-1440x900.png`. Geometry: `g11-rects-1440x900.json`.

Against `01` and `02`: the header and capsule match (positions above; title and topic type; presence dot;
capsule, `+`, chip, emoji, send). `07`: title, server, "6 NEW", capsule, chip and "Reply" match.

## Differences left

- **No call pill** in `01`, `02` or `07`: the slot is in place and empty (G12).
- **Phone header** has the drawer button and search / members icons; the render has neither (G20 replaces the
  frame's navigation; search and members stay reachable meanwhile). No face on the phone.
- **Topic:** the mocked scene's channels have none, so the header shows the server's name where `01` shows
  "Haz 5 runs from 9. Bring snacks." (`g11-topic-1440x900.png` sets one and matches). The fixture would need
  `topic` on General (G2's file).
- **Capsule is 744px**, not the column's 720 (above).
- **Focus ring:** the reference rings the bare input; this rings the capsule (§9).
- **Compact frame:** the title is 46px right of the column edge (the places button precedes it).
- **Members** does nothing in a server channel or 1:1 DM until the people sheet (G18); **face** opens user settings.
- The places panel (G9) and the timeline (G10) in the shots are theirs.

## For the next packages

- **G12:** the slot contract above; the stacked slot for the phone; `glassStore.pillExpanded` is yours.
  `useDmCall.ts` and the DM call button in the header go when the pill carries DM calls.
- **G18:** `sheetBridge.ts`, `useChannelMenu.tsx`, and the header's `ContextMenu` (above).
- **G20:** the phone header's drawer button and DM back button, and `.glass-conversation__phone-pill`.
- **G22:** `layout/TopBar.tsx`, `ConversationHeaderActions.tsx` and their five test files are no longer used by the
  conversation (`TopBar` is still drawn by `GuildStateScreens`); dead CSS: `.chat-header*` and
  `.message-composer-secondary` / `-more` / `-surface` in `components.css`, and `.glass-conversation__heading` /
  `__places-toggle` in `glass-layout.css` (region rules, outside the block I was allowed to delete);
  `smoke.spec.ts`'s header sections; `LayoutTour`'s "Skip tour" button no longer appears (its Lantern anchors are
  gone), which the smoke test also expects.
- The stub had also inset the timeline (`[role='feed']`); that rule went with the adapter block. The timeline
  sits in the column through G10's own CSS.
