# IX-7 checkpoint: Live room card

Contract: `docs/index-spec.md` §3.1 (Room card, People rows, Card actions), §4.3, §4.4, §4.10, §5.4, §5.5,
§5.7, §8.5. Plan row: `docs/design/index-plan.md` §3 (IX-7). Worktree `~/Documents/Paracord-index`, branch
`feat/index-ui`.

## What was built

`components/ix/card/` replaces the IX-4 stub. `CardSlot` keeps the IX-4 props (`{ place, position }`).

| File | What |
|---|---|
| `model.ts` | Pure rules: which card a place shows (`inlineCard`, `pinnedCard`, `heldBelongsTo`, `rankRooms`), the stable people order (`orderPeople`), rows and the "and N more" row (`cardRows`), the busiest stream (`rankStreams`), the room start (`roomStartedAt`, earliest `joined_at`), words (`liveLabel`, `headLabel`, `cardLabel`, `rowName`, `incomingLine`) |
| `useCardWorld.ts` | Reads the voice, speaking, watcher, channel, guild and member stores as slices into one `CardWorld` (the same sources the Glass pill used) |
| `CardSlot.tsx` | The slot: inline (`div.ix-card-slot`, empty when there is no card) and pinned (incoming call, then your call elsewhere; `null` when empty so the host collapses). Presence (a card stays for its exit), and the FLIP of the content below when the slot grows or shrinks |
| `RoomCard.tsx` | Head (speaker / stage / phone glyph, name, amber state), server line, now-playing line (listen together), the privacy line while system audio is shared, people rows, actions; two background layers (live and yours, crossfaded on join); profile card on a row, a small context menu on right-click; the join flight and the pinned/inline move |
| `PeopleRows.tsx` | 32px rows, talking ring (its own element, opacity only), trailing waveform / screen button / mic-off, "and N more"; rows play in and out and close up |
| `CardActions.tsx` | Actions by state, wired to `glass/pill/pillActions.ts` and the stage's existing helpers |
| `IncomingCallCard.tsx` | "Jeremy is calling", Decline (wide) + Accept (cream); system notification when the window is not focused |
| `Wave.tsx` | The four-bar waveform |
| `cardMotion.ts` | Every card moment as Web Animations (ids `ix-card:*`) |
| `minuteTick.ts` | One shared `setInterval(…, 60_000)` while any card is mounted |
| `listenIn.ts` | Whether a room admits listeners (`GET /channels/{id}/features`, once per room per session) |
| `selectors.ts` | `useInlineCardRoom(place)` (for IX-5's Rooms list) and `useServerLive(guildId)` (for IX-6's live dot) |
| `JoinMutedSetting.tsx` | Settings › Voice & video › Join calls muted (`muteStore`) |

States (`data-state`, as `e2e/fixtures/index/drivers.ts` expects): `live`, `streaming`, `listening`, `yours`,
`incoming`; a pinned card keeps `yours` (or `listening`) and has `data-position="pinned"`. Test ids:
`ix-room-card`, `ix-card-join`, `ix-card-watch`, `ix-card-listen`, `ix-card-mic`, `ix-card-camera`,
`ix-card-screen`, `ix-card-open-call` (label "Open call" / "Back to chat"), `ix-card-leave`, `ix-card-decline`,
`ix-card-accept`.

### Behavior

- **Which room.** Your call in this place; else the server's room with the most people who joined (listeners
  never make a room live), ties to the earliest start, then channel order. People shows only your DM call
  inline. A call you hold that belongs elsewhere (another server, People for a DM, another account) is pinned
  with its server line ("Fuel", "Direct call"). A call that is closing, closed or failed is no card.
- **Order.** Streamers first (in the order they started), then join order (`joined_at`), then listeners
  ("You — listening" in ink-3). The voice store re-appends a person on every state change, so the order never
  comes from the list. Seven or more people: five rows and "and N more" with up to five faces.
- **Talking.** `channelSpeakers` (engine flags in your call, the `VOICE_SPEAKING` relay elsewhere). The ring is
  an element whose opacity fades 150ms in / 300ms out. The waveform exists only while the person talks; in a
  call you hear (joined or listening) it carries `data-real` + `data-motion-speaking` and follows
  `--voice-level` from `lib/motion/voiceLevel.ts`; elsewhere it runs its CSS loop. Reduced motion: still bars.
- **Words.** "just now" under a minute, "live N min", "live 1 hr 5 min" past an hour, "live" when no
  `joined_at` is known (nothing is invented); "You’re in", "Listening", "Joining…", "Reconnecting…".
  Accessible name: "General, just now, 1 person, Jeremy talking" (sharing is named too).
- **Actions.** Join → `joinCall` (applies Join calls muted; from listening it upgrades in place). Listen →
  `toggleListen` (absent in DMs, stage channels, and rooms whose `listen_in_enabled` is false). Watch <name> →
  `watchStream` on the busiest stream (most watchers, then earliest started). Mic → `toggleMic`; right-click,
  Shift+F10 or a long press → the stage's `DeviceMenu` (Deafen, devices). Camera → `toggleVoiceVideo`. Screen →
  `useShareScreen` and `ScreenSharePickerModal`. Open call → `showCall` (opens whatever the call slot hosts;
  today the IX-4 stub's Glass stage); Back to chat → `closeStage`. Leave → `leaveCall`, one click. A stage
  audience gets Open call and Leave only. The screen glyph on a streamer's row opens their stream.
- **Incoming.** `useIncomingDmCall` (unchanged) feeds the pinned slot. Decline is local (as before); Accept
  opens the DM and joins with the mute preference. `IncomingCallBanner` and its test are deleted and its mount
  line is gone from `AppProviders`.

### Motion (all `ix-card:*`, transform/opacity only)

| Moment | What plays |
|---|---|
| A room goes live (§5.5) | `card-in` 600ms spring; content below `push` down 600ms |
| A person joins / leaves | `row-in` 500ms (rows and actions below push 500ms) / `row-out` 250ms ease, then `push` up 450ms |
| The room empties | `card-out` 300ms ease (fills, then removed), then `push` up 450ms |
| Join (§5.7) | yours layer crossfades 400ms (CSS); your face flies from the toolbar avatar as a ghost on the document (`fly`, 750ms, translate + one scale), your name and the new controls hold at 0 until 45% (`fly-hold`) |
| Pinned ↔ inline (§5.4) | inline → pinned: the pinned card FLIPs from the copy in the leaving pane (`pin`, 550ms; the copy is hidden). Pinned → inline: the pinned card's copy travels on the document to the new inline card (`pin` ghost) while the panes slide; the real card shows when it lands. Between two other places it stays still |
| Incoming call | `card-in` / `card-out` |

Nothing moves on a slot's first commit (a pane mounting) or in a pane that is sliding out. No animation fills
forwards on an element that stays mounted. Development's StrictMode runs mount effects twice: the mount motion
is decided once per card and only a real unmount (still gone a microtask later) ends a running move.

## Decisions and deviations

1. **Listen control on the live card.** The spec's state table has `[listen] + Join`; the prototype and
   `ref/s1` draw Join alone. Spec wins on behavior, so s1 shows a 36px listen control left of Join (where the
   room admits listeners). If the server cannot say, the control is drawn and a refused press is reported (and
   blocks the control) by `pillActions` as before.
2. **Streaming card has Join beside Watch** (spec: Join wide + Watch cream). `ref/s4` draws Watch Vincent
   alone, full width.
3. **Waveform loop lengths 1, .8, 1.2, 1s** (prototype .9 and 1.15) so all four bars tick on the shared 100ms
   grid (desktop CPU, Glass release check). Bars use `steps()` like Glass.
4. **Trailing mark precedence follows the prototype**: sharing (screen glyph) over talking (waveform) over
   muted; a streamer who talks shows the ring and the screen glyph (`ref/s4`).
5. **Your monogram is your own initial** ("S"), the row says "You".
6. **Narrow (280px sidebar)**: icon controls 31px wide, wide control 13px with 4px padding, so "Back to chat"
   fits; labels ellipsize rather than overflow anywhere narrower.
7. **Person right-click**: View profile (and Watch their screen when sharing). There is no client API for
   moderator voice actions (server mute, move, disconnect), so they are not offered; IX-9's People menu can
   replace this menu. The "and N more" row opens the call view when joined, otherwise the people sheet
   (unfiltered: the sheet has no room filter yet).
8. **No ring timeout and no ringtone exist** in the client today (the spec says "the existing ring timeout" /
   "unchanged"): the incoming card stays until answered, declined or the caller hangs up. A system
   notification did not exist for calls either; the incoming card now sends one when the window is not focused.
9. **Settings › Join calls muted** lives in `JoinMutedSetting.tsx`; `components/user/UserSettings.tsx` (IX-17's
   file) gained one import and one line in the Input mode section. Default stays muted (Glass's default).
10. Not mine and not done: the "You joined General" system line (IX-11), the polite live region announcing
    joins (IX-18, §10), the phone call strip (IX-16), the call view itself (IX-13).

## Files outside the package's own directory

- `client/src/lib/AppProviders.tsx`: banner mount and import removed (owned by IX-7 per the plan).
- `client/src/components/dm/IncomingCallBanner.tsx`, `IncomingCallBanner.test.tsx`: deleted.
- `client/src/components/user/UserSettings.tsx`: +2 lines (named above).
- `client/src/styles/ix-card.css`, `client/e2e/index-card.spec.ts`.
- Left alone: `BannerStack.tsx` still carries dead `.glass-callbanner` rules and a comment (IX-15/IX-19);
  `glass/pill/*` is unchanged (reused read-only).

## For the next packages

- **IX-5**: you render `<CardSlot place={place} position="inline" />` (done). Leave the card's room out of
  Rooms with `useInlineCardRoom(place)`. The slot is `flex-shrink: 0`; the search field above it shrinks when
  the pane overflows (seen in s4/s5 with Coming up): give your pane children `flex-shrink: 0` too. The card
  pushes what follows it with `transform` animations on the slot's next siblings (`.ix-sb__rows` …): a FLIP of
  your own on the same element at the same moment would replace it.
- **IX-6**: `useServerLive(guildId)` is the live-dot rule (a room somebody joined).
- **IX-13**: Open call calls `showCall` / Back to chat `closeStage` on `glassStore`; label follows
  `stage.mode !== 'none' && stage.channelId === card.channelId`. The card is `[data-ix-call-card]`
  `[data-card-key="serverId:channelId"]` for the grow-out-of-the-card FLIP (§5.8).
  `real-server.voice-join.spec.ts` case 4 looks for `region "Stage"`, but the IX-4 call stub names it "Call":
  update the spec with the call view.
- **IX-14**: render `<CardSlot place={PEOPLE_PLACE} position="inline" />` under People's search for your DM
  call.
- **IX-16**: the card's controls are already 40px under `.ix-frame[data-layout='phone']`.
- **IX-18**: card animation ids are `ix-card:{card-in,card-out,row-in,row-out,push,fly,fly-hold,pin}`.
- **Harness note**: in your own call the card trusts the engine's `speakingUsers`; the fake engine does not
  follow `VOICE_SPEAKING`, so after `crowd` set `speakingUsers` to Vincent (the spec does) or s5 shows Jeremy
  talking.

## Verification (commands run in `client/`)

- `npm run typecheck`: clean (at the time of the run; concurrent packages' files come and go).
- Unit: `npx vitest run src/components/ix/card src/hooks/useIncomingDmCall.test.ts
  src/components/user/UserSettings.test.tsx`: 52 passed. New: `model.test.ts` (20: busiest room, ties,
  listeners, other server, your call wins, pinned elsewhere, DM and other-account calls, closing calls, every
  state, busiest stream, talking, your face's name, stable order, overflow, labels, start time, accessible
  name, incoming line), `CardSlot.test.tsx` (14, real stores: empty slot, live, listen fetched and absent,
  streaming + Watch + the row's screen button, listening, talking and real levels, yours with every control,
  device menu, pinned only elsewhere, stage audience, DM, incoming Decline / Accept, the 60 000 ms tick),
  `cardMotion.test.ts` (8: keyframes transform/opacity only, durations, curves, ids, fill, push targets,
  flight ghost, pin moves, reduced motion, snapshot).
- Full `npx vitest run`: the failures (67 at the time) are all in files other packages were editing
  (sheets, CommandPalette, GuildSettings, EventList, feedGlass, UserProfile, PeopleSheet, Dock, AppShell via
  `DmPickerModal`, vocabulary via `ix/menus` and `CommandPalette`) or pre-existing at HEAD
  (`useGlassKeybinds`, `stageTransition`). None in IX-7 files; my one vocabulary hit ("room") is fixed.
- `npm run test:tokens`, `test:motion-lint` (no allowance added), `test:contrast`: pass.
  `test:a11y:static` reports only `UserProfile.tsx:600` (IX-9's in-flight file). `npm run lint`: 0 errors in
  IX-7 files (the run's 2-3 errors are in `PeopleSheet.tsx` and `GuildOnboardingGate.tsx`).
- e2e: `PARACORD_E2E_INDEX_SPEC=index-card PARACORD_E2E_INDEX_PORT=4553 PARACORD_E2E_INDEX_RT_PORT=4555
  PARACORD_E2E_INDEX_WP=ix7 npx playwright test -c e2e/index-review.config.ts`: 9/9 (s1 live + talking stops,
  s2 join flight + mute + Open call/Back to chat + leave, s4 pinned move both ways + still between other
  places + Watch, s5/s6, listening → join, room empties, rows in/out + overflow, incoming, sizes incl. the
  narrow fit). Animations asserted by a recorder; nothing of the card running 2s after each moment.
- `node e2e/index-compare.mjs ix7`: s1 1.41%, s2 1.34%, s4 2.50%, s5 3.88%, s6 2.80% mean. I read every
  side-by-side: the card's geometry (top 124, head, rows at 32, actions at 36, pinned at y=28) matches the
  references; differences are the listen control (s1), Join beside Watch (s4), and other packages' content
  (the Glass pill and conversation header in main, IX-5's search field shrinking under overflow, People stub).
- `PARACORD_E2E_REAL=1 PARACORD_E2E_PORT=18157 PARACORD_E2E_MEDIA_PORT=18558
  PARACORD_E2E_SERVER_BIN=…/Paracord-glass/target/release/paracord-server npx playwright test
  e2e/real-server.voice-join.spec.ts` against a release build with this worktree's UI embedded (vite build,
  fake media devices, headless): 3 passed, 1 failed (case 4 waits for `region "Stage"`, which the IX-4 call
  stub names "Call"; not the card). The real app's card read "lounge, you’re in, 2 people, You talking".

## Screenshots (`output/design-reference/index-build/ix7/`, gitignored)

Read: `s1-someone-arrives.png`, `s2-joined.png` (+ `@1440x900`, `@900x700`, `@390x844`), `s4-other-server.png`,
`s5-busy.png`, `s6-people.png`, `compare/*.png`, crops `card-s1-live`, `card-s2-yours`, `card-s4-pinned`,
`card-s4-streaming`, `card-s5-five`, `card-s6-pinned`, `card-listening`, `card-overflow`, `card-incoming`,
`card-narrow`, `card-narrow-call-open`.
