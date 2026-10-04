# IX-0: Review harness

The prototype's scene as mocked data, a way to move it through its story, the
config and tools to shoot it, and drivers keyed to the plan's test ids. Every
UI package after this one reviews its work through it.

## What exists

| File | What |
|---|---|
| `client/e2e/index-review.config.ts` | Playwright config for every Index spec; ports, spec and package label from `PARACORD_E2E_INDEX_{PORT,RT_PORT,SPEC,WP}` |
| `client/e2e/index-dev.mjs` | Vite through its API (not named `vite`); allows the symlinked `node_modules` so fonts load |
| `client/e2e/index-compare.mjs` | Side-by-side PNG and mean per-pixel difference against `ref/`, composed in a Playwright page canvas |
| `client/e2e/index-smoke.spec.ts` | The scene loads in today's UI and every step reaches the page (10 tests) |
| `client/e2e/fixtures/index/` | The harness (below) |

`fixtures/index/` is self-contained: it imports only `src/test/guildContractFixtures`,
nothing from `fixtures/glass`, so IX-19 can delete the Glass fixtures without
touching it.

## Running a spec

```
cd client
PARACORD_E2E_INDEX_SPEC=index-sidebar \
PARACORD_E2E_INDEX_PORT=4533 PARACORD_E2E_INDEX_RT_PORT=4535 \
PARACORD_E2E_INDEX_WP=ix5 \
npx playwright test -c e2e/index-review.config.ts
node e2e/index-compare.mjs ix5
```

The config starts the realtime stub and `index-dev.mjs` on your ports. Defaults
are IX-0's 4513/4515; `PARACORD_E2E_INDEX_REUSE=1` reuses servers already up.
`SPEC` takes `index-sidebar`, `index-sidebar.spec.ts` or a path; unset runs
every `e2e/index-*.spec.ts`. Page timezone is America/Chicago, viewport 1280x800
at 1x, glyph hinting off (as the reference renders).

Shots go to `output/design-reference/index-build/<WP>/` (gitignored): at 1280x800
`<state>.png`, at any other size `<state>@<w>x<h>.png`.

## The compare tool

```
node e2e/index-compare.mjs <ix5 | path | ref> [--only s0-quiet,s5-busy] [--max 4.5] [--quiet]
```

For each `<state>.png` in the folder that has a `ref/<state>.png` it writes
`<folder>/compare/<state>.png` (reference left, shot right, captioned),
`<state>.diff.png` (difference x4, black = identical) and `summary.json`, and
prints the mean per-pixel difference (all pixels, all RGB channels, percent of
full scale) and the share of pixels differing by more than 3% on any channel.
`@WxH` shots are skipped; a size mismatch is reported without a number.
`ref` compares the references with themselves: all ten report 0.00% (checked).
The number is a guide. The side-by-side is what you read. Today's Glass UI
against the references is 6 to 8% mean, 84 to 93% changed: that is the distance
the build closes.

## The scene (`scene.ts`, `world.ts`)

Cast: you (Sean, "S"), Jeremy, Vincent, Brendan, Nick, Maya. Servers: Fuel (new,
you only; channels general, clips, plans; rooms General, Late night), Game Night
(12 members, filler members make the list true; lounge, looking-for-group,
screenshots; Lounge live with Vincent streaming and talking, Brendan, Nick;
Ranked), Basecamp (5; general, builds; Workshop). DMs: Jeremy, Nick, Maya. No
server icons, so monograms show. Clock: Thursday 1 October 2026, 9:38 PM,
America/Chicago, pinned on the page; steps move it.

- **Ids carry the hues.** Every id is minted so `paletteHue(id)` (index-spec §2.2:
  last nine digits mod 11 into the palette) gives the prototype's hue or the
  nearest palette hue: Fuel 350, Basecamp 150, you 200, Jeremy 22, Vincent 36,
  Brendan 214, Nick 162, Maya 350 (the prototype's 330 is excluded as purple).
  Game Night's 195 is not in the palette, so the harness sends `hue: 195` on its
  guild payloads the way an admin's Server color would (IX-2's field). If IX-1's
  `paletteHue` differs from the spec formula, avatars will differ from the
  prototype's; the smoke test pins the spec formula (`paletteHueOf`).
- **Voice states carry `joined_at`** (and `self_stream_started_at`) so the card's
  "live N min" has its source: Lounge since 9:12:50 PM (34 min at 9:46:50), Fuel's
  General since Jeremy joined at 9:44:10 (18 min at 10:02:20).
- **Previews come from the last message**, the way the server's channel-previews
  endpoint says it. Empty Fuel channels have topics "Share your best moments" and
  "Nothing planned yet" (their sidebar line); general has none ("No messages
  yet").

## The story: steps

`await h.step(name, args?)`. A step changes the world, moves the clock, and
sends the same gateway frames a server would (through the realtime stub's real
SSE stream), so the page runs its real gateway and message pipeline. A reload
after a step lands in the same world (READY carries it). It resolves once the
page has processed every frame (`emit` ends with a marker frame and waits for
it); React may still be rendering the last one, so assert what you expect to see.

| Step | Story | Clock after |
|---|---|---|
| `arrive` | s0 to s1: Jeremy joins Fuel, posts two messages (9:41 PM), a clip in clips (9:42 PM, an unread there), joins General talking (9:44:10, "just now") | 9:44:20 |
| `join` | s1 to s2: you join General (store state, no click; see Fake voice) | 9:45:10 |
| `crowd` | part of s5: Vincent, Brendan, Maya join Fuel and General, Nick comes online; Vincent talks instead of Jeremy; 6 members, 6 here now | 9:58:30 |
| `busy` | part of s5: the nine messages (9:58 to 10:02 PM) across general and plans (event post, Movie night created just before it). `{ pace }` ms between messages, default 150, 0 for shots | 10:02:20 |
| `message` | `{ channel, who, text, attachments? }`: one message now | unchanged |
| `typing` | `{ channel, who }`: TYPING_START | unchanged |

`CLOCK.call` (9:45:40) and `CLOCK.visit` (9:46:50) are the clock for "call open"
and "visiting Game Night" (the Lounge reads 34 min there). Set them with
`h.setClock(CLOCK.visit)`.

**Adding a step** (later packages): a new file under `fixtures/index/steps/`,

```ts
export const lateNight = defineStep('lateNight', async ({ world, emit, setClock }) => {
  world.joinVoice('nick', 'fuelRoomLateNight');
  await emit(frames.voiceState(world, 'nick', 'fuelRoomLateNight'));
});
// in a spec: await h.step(lateNight);
```
Nothing to register. Frame builders are in `gateway.ts` (`messageCreate`,
`presence`, `memberAdd`, `voiceState`, `speaking`, `typing`, `watchers`,
`eventCreate`); world mutators in `world.ts` (`post`, `joinVoice`, `leaveVoice`,
`setSpeaking`, `addMember`, `setOnline`, `addEvent`, `markRead`).

## Using it in a spec

```ts
import { installIndexScene, shoot, walkStates, reachState, ... } from './fixtures/index';

test('...', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);            // before the first goto
  await h.open(h.routes.channel('fuelGeneral'));      // goto + wait for READY + fake voice
  await h.step('arrive');
  await shoot(page, 's1-someone-arrives');            // settles 1.6s, parks the mouse, writes the file
});
```

- `h.routes.channel(key)`, `.dm(key)`, `.place('fuel' | 'gameNight' | 'basecamp' | 'people')`.
- `navigate(page, route)` moves with a history push and popstate, **no reload**:
  stores and the held call survive. (`page.goto` reloads and drops the call.)
- `h.reload()` reloads into the current world.
- Routes are last-wins: add your own `page.route` after `installIndexScene` (a package
  that mocks its own POST does this). `onUnhandled` logs REST calls nobody answered.
- Every `/api/v1` and `/api/v2` answer carries `X-Paracord-History-Epoch`. Copy that
  into any route you add, or the client sees a history mismatch and **reconnects**
  (this cost an hour here: a 204 without the header resets voice state).
- Sending works: `POST /channels/{id}/messages` stores the message, announces it, and
  answers with it. Read position (`PUT .../read`) is tracked. Message recovery is a
  faithful per-channel revision log, which the client's durable pipeline needs to
  accept live messages.

### Clock

`h.setClock(iso)` pins the page's `Date` (timers keep running). Two traps are
handled for you: the client's 60 s SSE watchdog reads the same clock and would
reconnect on a jump (a heartbeat frame follows every `setClock`), and labels read
the clock on a **60 000 ms interval** ("live N min"). The harness wraps every
`setInterval(fn, 60_000)` and `setClock` fires them (`h.tick()`), so a jump shows at
once. A minute tick **must use exactly 60_000 ms** to be reached this way (IX-7:
use it; the spec says one shared minute tick).

### Fake voice (`call.ts`)

`open()` replaces the voice store's actions with state-only fakes (`joinChannel`,
`listen`, `joinFromListen`, `leaveChannel`, `toggleMute/Deaf/Video`, `startStream`,
`stopStream`, `startWatch`, `stopWatch`, `fetchWatchers`), so clicking Join on any
card reaches "yours", Leave leaves, Watch opens a watch view, and the engine paints
the DEV fixture camera (Brendan) and stream (Vincent) into canvases. Voice levels
are published for whoever talks. `holdCall(page, { channelId, guildId, mode })`
puts you in a call without a click (what `join` does); `releaseCall(page)` leaves.
Your call is never in READY (a reload drops it, as for real). The fixture is
`/src/lib/room/fixtureFrameSource.ts` (`FIXTURE_MODULE` in `call.ts`); if M2 or
IX-19 moves it, change that constant. `installIndexScene(page, { fakeVoice: false })`
turns all this off; `{ video: false }` skips the fixture.

## Drivers (`drivers.ts`)

Keyed to the §1.3 test ids (`ix(page, id)`, `TEST_IDS`). The plan left a few
values open; they are fixed here and **the UI packages must emit them**:

- `ix-dock-item[data-place]` = `people`, or the server's id (decimal string)
- `ix-action-card[data-action]` = `invite` | `plan` | `hello`
- `ix-room-card[data-state]` = `live` | `streaming` | `listening` | `yours` | `incoming`
  (a card pinned in another server keeps `yours`)
- `ix-card-open-call` is the card's wide control in the joined states; label is
  "Open call" or "Back to chat", the id does not change
- `ix-card-join` joins the room (also the Join control next to Watch); `ix-card-leave`
  is the danger control
- `ix-title` is the large title; the folded title lives inside `ix-toolbar`
- `ix-composer` is the message box root with one `role=textbox` inside

Locators: `sidebar`, `sidebarHeader`, `searchField`, `dock`, `toolbar`, `title`,
`welcome`, `composer`, `composerInput`, `callView`, `channelRow(page, key|id)`,
`roomRows`, `roomRow(page, name)`, `roomCards`, `roomCard(page, state?)`,
`cardJoin/cardOpenCall/cardLeave(card)`, `dockItem(page, place)`,
`actionCard(page, action)`. Actions: `goToPlace`, `openChannel`, `clickActionCard`,
`typeInComposer`, `clearComposer`, `joinFromCard`, `openCall`, `backToChat`,
`leaveFromCard`, `scrollConversation(page, 'bottom' | scrollTop)` (largest scrolling
element in main, so it survives a restyle).

`walkStates(h, { visit, until, navigate: 'route' | 'ui' })` walks the whole
reference story as `index-reference.mjs` shot it (quiet, Plan a night, open box, then
arrive, join, open call, Game Night, busy, folded, People), calling `visit(state)`
in each; `reachState(h, state)` stops at one. People-actions are drivers, the
world's changes are steps. Default `navigate: 'route'` works before the dock
exists; `'ui'` clicks it. `shoot(page, state, { size: 'reference' | 'desktop' |
'narrow' | 'phone', wp })` sets the viewport (1280x800, 1440x900, 900x700, 390x844)
and names the file. **The drivers are not yet exercised against Index UI** (none
exists): the smoke test proves each locator resolves on a synthetic page that has
every id, and that is all it can prove. `walkStates` needs the welcome cards
(IX-15), the room card and call view (IX-7, IX-13) for its later states; a package
that lacks them passes `until`.

## Differences from the reference (expect these; they are data, not misses)

1. **Previews are derived**, not hand-written. Jeremy's last message is
   "who's up for a run tonight? I'm in General", so general's preview truncates
   where the prototype's reads "Jeremy: who's up for a run tonight?".
   Basecamp general's two messages are ordered so its preview matches the prototype.
2. **No "Today 9:58 PM" divider** in busy Fuel: index-spec §4.11 puts one after 30
   minutes or a day change, and 9:41 to 9:58 is 17. The prototype has a hand-placed one.
3. **"Coming up" appears from `busy` on** (Movie night, Friday 9 PM, is within seven
   days; §4.7); the prototype never draws it. IX-5 will show it in s5.
4. **Fuel general's subtitle** ("Fuel's main channel") is not a topic here (the empty
   preview is "No messages yet", which a topic would replace). It is the product's to
   derive (IX-15).
5. **The clip** is a `video/mp4` attachment with a generated still. IX-5 derives
   "Jeremy posted a clip" from it, or says "video"; that is its rule. Screenshots
   are four generated images, "Nick posted 4 photos".
6. **DM channel `recipient` carries `display_name`**, an extra field. Today's UI titles
   a DM by username ("jeremy").
7. Sidebar order in the dock is Fuel, Game Night, Basecamp (the prototype's).

## Findings that cost time (for the next harness user)

- `page.waitForFunction` does **not** poll an async predicate (it resolves on the
  first Promise). The harness hands the stores to the page (`window.__ixProbe`) and
  waits on synchronous predicates.
- A `route.fulfill` with no `X-Paracord-History-Epoch` header makes the client
  reconcile history and reconnect, which re-sends READY and wipes your fake call.
- Moving the pinned `Date` forward more than 60 s without a frame trips the SSE
  watchdog (see Clock).
- `client/node_modules` is a symlink to another checkout; without `server.fs.allow`
  Vite refuses the font files and the shots render in a fallback face. `index-dev.mjs`
  allows the real path.
- `tsconfig.json` includes `e2e/fixtures`, so `npm run typecheck` checks the harness;
  specs are not type-checked (Playwright strips types).

## Verified

- `cd client && npm run typecheck`: clean (0 errors).
- `npm run test:tokens`: passes. `npm run lint`: 0 errors (214 warnings, none mine;
  my files lint clean).
- `PARACORD_E2E_INDEX_SPEC=index-smoke PARACORD_E2E_INDEX_PORT=4513
  PARACORD_E2E_INDEX_RT_PORT=4515 PARACORD_E2E_INDEX_WP=ix0 npx playwright test -c
  e2e/index-review.config.ts`: 10 passed, about 40 s. Covers: s0 stores, clock and
  zone; `arrive` messages live in the open channel and Jeremy in the room; `join`;
  Game Night visit while in the call with "live 34 min"; `crowd` and `busy` (5 in the
  room, 6 members, clock at 10:02:20); reload lands in the current world; sending a
  message stores, announces and shows it once; a package-style step object; hue
  mapping; every §1.3 id through the drivers; shot naming.
- `node e2e/index-compare.mjs ref --max 0`: all ten states 0.00%.
- Shots of today's UI in `output/design-reference/index-build/ix0/` (s0, s1, s2, s4,
  s5, s6) and their `compare/` sheets, read.

## Not done / uncertain

- Drivers and `walkStates` are unverified against real Index UI (above).
- Only `ix-dock-item`, `ix-room-card` etc. values in the convention list are
  assumptions; if IX-4/5/6/7 choose differently, change `drivers.ts` once.
- Friends and relationships are not mocked (GET returns `[]`); IX-14 adds a step or
  override. No group DM, no encrypted channel, no threads, no polls in the scene
  (the Glass scene had a poll; IX-8's gallery brings its own).
- `walkStates` after "Plan a night" assumes the plan draft is client-only and a
  reload with an emptied box returns to a quiet Fuel.
- A first-class phone state (390x844) is `shoot(..., { size: 'phone' })` only; the
  phone navigation is IX-16's.
- IX-3 (live scene) has its own cast code; the two scenes share names and times by
  convention, not by import.
