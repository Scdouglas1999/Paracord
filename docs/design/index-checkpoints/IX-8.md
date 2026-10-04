# IX-8 checkpoint: Conversation cards

Contract: `docs/index-spec.md` §3.1 (event card metrics), §4.11 (conversation), §8.4 (where each card
lives). Plan row: `docs/design/index-plan.md` §3 (IX-8). Worktree `~/Documents/Paracord-index`, branch
`feat/index-ui`. `MessageList.tsx`, `MessageInput.tsx` and `lib/motion` are untouched.

## What the next packages get

### The card family (`styles/ix-cards.css`, unlayered, imported after every Glass sheet)

`.ix-card` is the one surface: `--ix-card`, radius 20, padding 16, `--ix-shadow-event`, width 400 and
`max-width: 100%` (the prototype's `.event`). Event, poll, plan, link, GitHub, feed and score cards are all
`.ix-card` plus their own class. A file (`.ix-file`, `.ix-media-card`) is the same surface at 360.
High contrast keeps an `inset 1px --ix-edge-lit` ring on all of them.

Because the Glass card sheet (`glass-cards.css`) is in `@layer components` and `ix-cards.css` is not, an Index
rule wins any tie with a Glass rule at any specificity. Where the timeline still draws a Glass element, an
override here makes it look right until IX-11 rebuilds it (all marked in the file):

- `.glass-msg__card--plan { width: auto; max-width: 100% }`: the wrapper `MessageList` puts event and poll cards
  in is as wide as the card, so a card in your own messages sits at the right edge.
- `.glass-msg .glass-file` (+ `__icon`, `__name`, `__line`, `__action`): `GlassFile` (`MediaFrame.tsx`, IX-11's)
  wears the file card (38px tile in the place's hue, radius 20). Scoped to a message row: the server pages draw
  their own `.glass-file` chips.
- `.glass-mention:not(.glass-mention-self)` is ink 600 with no fill; `.glass-mention.glass-mention-self` is the
  white chip (`--ix-ink` on `--ix-mention-ink`, radius 6, padding 0 5). Both have a `[data-own]` variant for your
  cream bubble. IX-11 may move these rules into the timeline sheet; the spec puts them in §4.11.

Chips and the ephemeral line key their "inside your own bubble" variants on a `[data-own]` ancestor (today's
`.glass-msg[data-own]`). Keep `data-own` on your own message row and they follow.

### Components (all under `client/src/components`)

```tsx
// glass/cards/EventCard.tsx (new): presentational, for the empty channel's draft too (IX-15)
<EventCard weekday="Fri" day="9" title="Game night" meta="Friday at 9:00 PM · in General" kind? label? tone?='live'|'over'|'canceled' joinTop?>
  <EventButton primary>Post it</EventButton>      // the one cream button (CreamButton size sm)
  <EventButton pressed? check?>Edit</EventButton> // quiet: padding 8 12, radius 10, 13.5/600
</EventCard>
dayTile(date): { weekday: 'Fri', day: '9' }       // glass/cards/eventTime.ts; CSS sets the capitals
planWhen(...)  // now "Friday at 9:00 PM" (long weekday inside 6 days), "Tonight at 9:30 PM", "Tomorrow at ..."
endsWhen(date, nowMs)  // "ends in 12 min" / "ends today 9 PM" / "ends tomorrow" / "ends Fri" / "ends Oct 9" / "ended"

// glass/cards/EventPlanCard.tsx: EventPlanCard (hooks) over EventPlanView (props only), EventUnavailable
<EventPlanCard guildId eventId joinTop? onOpenDetails?={(event) => …} />
```

- IX-15 ("Plan a night"): draw the draft with `EventCard` + `EventButton primary` "Post it" / `EventButton` "Edit";
  FLIP from the action card to the card's `.ix-event` element. The reference's card is 400x130 at (832, 526).
- `PlanCard` / `PlanAction` stay (Home, the lobby widgets and a server's Overview still import them: IX-10 and
  IX-14 retire those) and are the same card now: `.ix-plan*` classes, faces drawn with `Avatar` (not
  `TimelineAvatar`). `PollCard` is built on it.
- `PollCard` (view: poll, canVote, nowMs, pendingOptionId, onVote) over `PollMessageCard` (poll store, refresh
  every 15 s while open). `pollMeta(poll, nowMs, closed)` is "Pick one · 12 votes · ends Fri".
- Inline chips: `ChannelChipView` and `EventChipView` (props only) under `ChannelMentionChip` / `EventChip`.
  Classes are `.ix-inline`, `--live`, `--channel`, `--event`, `__dot`, `__aside` (were `glass-inline-chip`,
  `glass-chip--live/event`).
- `MessageComponents`: the bot's Primary button is cream only when it is the message's only Primary
  (`data-tone="cream"`); several Primaries, and Success, take a lit edge (`data-tone="primary"`); Danger is the
  danger ink; Link is text. Selects are `.ix-bot-select*`; a multi-select sends nothing until Confirm (cream).
- `EphemeralMessage` renders its children and "Only you can see this" (12, ink-3, an eye) under them, inside
  whatever bubble the caller draws. (`MessageList` still draws the Glass bubble around it.)
- `FilePreview`: file card (`a.ix-file`), picture / video / sound in `.ix-media-card` with a name-and-size line,
  blocked / loading / failed in `.ix-media-note`, the viewer is `.ix-lightbox` with an Index `Control` close.
  `MediaPreview`: captions are `.ix-captions*`, the video `.ix-video`. Clips keep the Glass clip bubble.
- `MessageEmbedCard`, `GitHubEventEmbed`, `FeedPostCard`, `ScoreUpdateCard`, `CodeBlock`: classes `.ix-embed`,
  `.ix-gh`, `.ix-feed*`, `.ix-score*`, `.ix-code*`.

### The gallery (DEV only)

`/ix-cards` (`pages/IxCardsGallery.tsx`, mounted by one DEV route in `App.tsx`): every card in every state, the
clock pinned to Monday 5 October 9:12 PM. `?hue=150` tints the place, `?theme=glass-contrast` is High contrast.
Two cards at the end (`EventPlanCard`, `PollMessageCard`) are the real components over the real stores; the e2e
spec answers their API calls. Pictures are `/ix-gallery/<name>.png`, supplied by the spec (blank by hand).

## Decisions and deviations

1. **"Maybe" is kept on this device.** The server has one RSVP (going or not: `PUT`/`DELETE …/rsvp`, a count, a
   boolean `user_rsvp`; `event_rsvps.status` exists but the handler hard-codes 1 and `has_rsvp` counts any row).
   So Maybe cannot be told to anyone. It is a persisted mark (`glass/cards/eventMaybe.ts`, zustand
   `paracord:index:event-maybe`, keyed by account scope and event id, pruned a week after the event), never
   changes the going count, and the button's title says "Only you see your Maybe". Pressing Maybe while going
   withdraws the RSVP (Maybe is not going); going wins over a stale mark. If the owner wants Maybe shared, it is
   a server change (`PUT …/rsvp` with a status, count and `user_rsvp` carrying it): that is outside this package
   and this file is the one place the client changes.
2. **No separate "Vote" button on a poll.** The spec's "Vote (cream, one per card)" would stage choices; the poll
   API votes per option at once (`PUT`/`DELETE …/votes/:option`) and the existing behavior (press to vote, press
   to take it back, tests) is kept. The poll's primary action is the option row itself. If a staged Vote is wanted
   for multi-select polls, it is a behavior change for IX-12/IX-15's owner to decide.
3. **"Details" exists only with a handler.** The event sheet and Events page belong to IX-9/IX-10 and do not exist
   yet, so `EventPlanCard` takes `onOpenDetails` and draws the button only when given one. `MessageList` passes
   none, so no message shows it until one is wired (IX-11/IX-15).
4. **The weekday is `hsl(h 75% 78%)`, not the spec's 74%** (recorded in `docs/index-spec.md` §2.2, per §10 "text
   4.5:1 at every hue"). At 74 the 11px weekday on its tile is 3.8:1 at hue 240 (the eleven palette hues pass,
   a "Match icon" blue does not); 78 gives 4.6 at the worst hue. The value lives in `ix-base.css`
   `.ix-hue-weekday` (so IX-5's Coming up gets it too). High contrast draws the weekday in ink-2.
5. **A poll's percent is ink-2 (ink on your row), not ink-3**: on a share bar at 100% ink-3 is 3.6:1.
6. **Link-preview accent**: the source's own color (`embed.color`) is a 4px edge, and only when it sends one; the
   old default cream bar is gone (cream is the one action). GitHub events keep only a danger tint for "Deleted"
   (no blue / green / yellow in Index). A score's team color is a 2px rule under its score, not the score's ink (a
   team color can be as dark as the card); both teams get one (the old card colored only the lead).
7. **Syntax colors**: a restrained palette from the place's hue (keywords `hsl(h 75% 74%)`, strings paler), ink
   for numbers and built-ins, ink-3 comments; High contrast is plain ink. `utilities.css` sets `.hljs-*` with
   `!important`, so these rules use two classes of specificity.
8. **No joined corners on cards**: every card is radius 20 (spec §2.5); `data-join-top` stays as a hook only.
9. **One poll timer, not one a second**: a timeout to the moment it closes plus a minute tick for "ends in 12
   min" (the old card re-rendered every second while open). Unit-tested with fake timers.
10. **`Pull Request` is `Pull request`** (sentence case, the product's rule).

## Files

New: `client/src/components/glass/cards/{EventCard.tsx,eventMaybe.ts}`, `client/src/components/message/EphemeralMessage.test.tsx`,
`client/src/pages/IxCardsGallery.tsx`, `client/e2e/index-cards.spec.ts`, this file.
Rewritten or restyled: `glass/cards/{PlanCard,EventPlanCard,InlineChips,CardGlyphs,eventTime,index}` (+ `PlanCard.test`,
`InlineChips.test`, `eventTime.test`), `message/{PollMessageCard,MessageEmbed,GitHubEventEmbed,MessageComponents,
EphemeralMessage,CodeBlock}.tsx` (+ tests), `feeds/FeedPostCard.tsx` (+ test), `sports/ScoreUpdateCard.tsx` (+ test),
`file/{FilePreview,MediaPreview}.tsx` (+ test), `styles/ix-cards.css` (all of it).

**Outside my list, each the smallest edit (named so the orchestrator can check):**

- `client/src/styles/tokens.css`: one token, `--ix-code: #18191c` (the code block), in the Index block.
- `client/src/App.tsx`: one lazy import and one DEV-only route (`/ix-cards`); IX-14 owns this file next.
- `client/src/styles/ix-base.css`: `.ix-hue-weekday` 74% -> 78% (decision 4). `docs/index-spec.md` §2.2 row.
- `client/scripts/contrast-audit.mjs`: an additive block that audits the card family (below).
- `client/src/components/message/MessageList.bubbles.test.tsx` (fenced for send-flight, not an edit to
  `MessageList.tsx`): two assertions only, "Take the spot" -> "I'm in" and `.glass-chip--event` -> `.ix-inline--event`;
  without them two tests fail on the restyled card and chip. Expect no conflict at M1 unless send-flight edited
  those two lines.
- CRLF: `CodeBlock`, `EphemeralMessage`, `GitHubEventEmbed`, `MessageEmbed` are CRLF in HEAD and kept so.

## Verification (commands run in `client/`)

- `npm run typecheck`: clean.
- Unit tests for what I touched (`vitest run src/components/glass/cards src/components/message src/components/feeds
  src/components/file src/components/sports src/components/ix src/styles src/lib/markdown.test.ts
  src/lib/vocabulary.test.ts`): 65 files, 671 tests, all pass. New or rewritten: event card and view (RSVP states:
  I'm in cream, You're in with a check, Maybe pressed and toggled, going wins over Maybe, busy, over, canceled,
  live, Details only with a handler), the Maybe store (persist, prune), `eventTime` (`dayTile`, `endsWhen`,
  long weekday), poll (bars `--share` and `scaleX`, check, marks column, closed, locked, the one-timer close, `pollMeta`),
  bot tones and Confirm, embed accent, GitHub tone, feed shapes, score rule, code copy and sanitizing, ephemeral
  line, file and media cards, inline chips without a router.
- Full `npm run test:unit` at the end of my work: the only failures were not mine. At the time of the last full run
  they were `useGlassKeybinds` "S browses, T switches layouts, H hides the chat in theater only" and
  `stageTransition` "T: the stage pane grows to the window…" (both fail at HEAD, the theater-hides-chat default of
  19db3e60, as IX-1 recorded) and, a few minutes later, IX-10's in-flight `BuildingNotFound`, `GuildPage` and
  `GuildSettings` tests (files it is changing now). The one failure I caused, `vocabulary` ("building" in a
  gallery title), is fixed.
- `npm run lint`: 0 errors in my files (eslint on them is clean; the repo-wide count moves with other packages' work,
  one run showed 4 errors from files IX-10 was deleting). `npm run test:tokens`: passes (no literal color in
  the new CSS or components; the gallery uses `var(--ix-amber)` for the accent demo).
  `npm run test:motion-lint`: passes (color, transform and opacity only; the busy ring is a `transform` keyframe).
  `npm run test:a11y:static`: passes (it caught the lightbox backdrop and the select trigger; both fixed).
- `npm run test:contrast`: passes, 188 new comparisons in a block I added to `scripts/contrast-audit.mjs` (the
  card family: weekday on its tile and the code's hue colors swept over 35 hues x 2 themes, chips on a bubble and
  on your cream bubble, the poll's percent on its bar, a select's list, GitHub and danger labels, code ink). It
  found three real failures that are fixed (decisions 4 and 5, and the High-contrast live chip's aside). Negative
  check: with the weekday back at 74% the audit fails at hues 240-270.
- `PARACORD_E2E_INDEX_SPEC=index-cards PARACORD_E2E_INDEX_PORT=4563 PARACORD_E2E_INDEX_RT_PORT=4565
  PARACORD_E2E_INDEX_WP=ix8 npx playwright test -c e2e/index-review.config.ts`: 29 passed. It holds the event card to
  the prototype's metrics (400 wide, radius 20, padding 16, tile 48x52 radius 12, 16/700 title, 13.5 line, 8px gap
  between 32px buttons) and to the pixels (the card against the 400x130 crop of `ref/s0-plan-a-night.png`: mean
  difference 0.38%); drives I'm in / Maybe, a vote (bars read `matrix(0.5,0,0,1,0,0)` and move), the picture viewer,
  Copy, the selects; checks the wired cards over real stores (PUT / DELETE rsvp, a vote, Maybe surviving a reload);
  checks no animation runs two seconds after any change, no horizontal scroll at 1280, 1440, 900 and 390, High
  contrast edges, and the hue.
- Not run: the Tauri/WebKitGTK desktop, a live server, `npm run build`. The cards are not mounted in the real
  timeline in any shot, because `MessageList` is fenced; they were seen in the gallery and, for the card the
  prototype draws, against the reference.

## Screenshots (`output/design-reference/index-build/ix8/`, gitignored)

I looked at each. `event-card-vs-reference.png` (the reference crop beside mine, 2x: indistinguishable at the
reference hue); `section-{events,polls,files,links,text,bots,wired}.png` (1440 crops of each gallery section);
`gallery@{1280x800,1440x900,900x700,390x844}.png` (the whole gallery at each size);
`gallery-hue-150@1440x900.png`, `gallery-high-contrast@1440x900.png`. The prototype has only the event card
(`s0-plan-a-night`); every other card is held to the spec text and the event card's tokens.

## Left for others

- IX-11: swap `GlassFile`'s `glass-file*` classes for `ix-file*` and move the three override groups above into the
  timeline sheet; render `EphemeralMessage`'s note under the bubble rather than inside it; pass `onOpenDetails`
  once the event sheet exists; align `EventPlanCard` to the right for your own messages (the prototype's `ev-wrap`).
  I made the wrapper as wide as the card so the row's alignment can do it, but did not see it in the real
  timeline.
- IX-19 (dead CSS and tokens): in `glass-cards.css` the `.glass-plan*` and `.glass-plan__option*` rules, the inline
  chip rules (`glass-inline-chip*`, `glass-chip--live/event` for chips), `.glass-media-captions*`,
  `.glass-media-video*`, and `.glass-file*` once IX-11 renames them; in `glass-pages.css` the `.glass-plans
  .glass-plan` / `.glass-post .glass-plan` overrides; in `feeds.css` the `.pc-feed-card`, `-title`, `-host`,
  `-more`, `-thumb`, `-media`, `-play` rules (the other `pc-feed-*` classes belong to feed settings).
- Owner question: Maybe on the server (decision 1), and a staged Vote on polls (decision 2).
