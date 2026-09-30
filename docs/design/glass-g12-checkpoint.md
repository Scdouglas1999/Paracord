# WP-G12 checkpoint: the call pill

Contract: `docs/glass-spec.md` §1, §2 (glyphs, waveform), §5, §7, §8, §9. Plan: `docs/design/glass-plan.md`
(WP-G12 row, §5, §8 owner decisions). Nothing is committed. Everything is in `~/Documents/Paracord-glass`
(branch `design/glass`).

The pill slot is real. `components/glass/pill` exports the Glass `CallPill`; the G7 stub
(`shell/stubs/CallPillStub.tsx`) is deleted. It had no adapter block in `glass-layout.css`, so none was removed.
A black capsule right-aligned to the column, 52px compact, growing to exactly the column width (720px at 1440)
and 222px tall (244px while listening in) on a 550ms spring; on the phone (`layout="stacked"`) two rows above the
header. It was driven from Sean's client against a real relay: **25 of 25 checks pass** (below), with the
mocked-harness shots held against `01`, `02`, `03` and `07`.

## What the pill does

**Which channel it shows** (`model.ts`, `pickPillTarget`; first that applies):

1. The call this client holds, anywhere: joining, listening or joined. Named with its server when it is not the
   one you are reading ("Game Night Lounge", `screens/02`). A DM call is named for the person.
2. This server's live voice channel.
3. A live voice channel in another server, named with its server. This is how `screens/02` (reading Basecamp,
   Game Night live) shows a pill without a call. It also applies in DMs and on any page with a header.
4. Nothing. `CallPill` returns `null`, so G11's `.glass-header__pill:empty` takes no room.

"Live" means somebody has **joined**. People who only listen never make a channel live. The ranking is: a channel
somebody else is streaming in first, then most people, then most talking, then the server's channel order, and the
stream is the earliest one started, never your own. That is the room light's rule (`lib/room/sources.ts`,
`pickRoomStream`), on purpose: G8's ambient view then lights the same stream the pill previews.

While a stage is open the pill is **not drawn on the row** (`screens/04`, `06`: the pill became the stage; G15's
shrink-back needs it mounted again when the stage closes). On the phone it stays (`screens/07` shows the stream and
the pill together) and its Watch button goes.

**Controls** (one filled button on the screen: Join). Every one is named; the labels below are visible text and the
accessible name adds the channel.

| State | Buttons |
|---|---|
| Not joined | Listen (glass, listen glyph, "Listen in to Lounge"), Watch (text, "Watch Vincent's screen"; hidden when nobody else streams), mute preference (36px circle, mic or mic-slash, "Microphone on when you join", `aria-pressed` = mic will be on), **Join** (cream) |
| Listening | Listen reads "Listening", pressed, amber (`data-tone="amber"`), "Stop listening in to Lounge"; Join upgrades in place |
| Joined | Microphone (circle, "Microphone", pressed = open), Watch, Leave (text) |
| Connecting | the same buttons, `aria-disabled` and `aria-busy`; a second press does nothing |
| DM call | Leave and the microphone; no Listen (listening in is for server channels) |

**What they call** (`pillActions.ts`):

- **Listen**: `voiceStore.listen(channelId, guildId)`. Never opens the microphone and never sends. Pressed while
  listening it leaves (there is nothing else to stop).
- **Join**: `joinChannel`, which from listening is G6's in-place upgrade. The mute preference is put in first.
- **Leave**: `leaveChannel`. The only way out of a call.
- **Watch**: `glassStore.openStage({ serverId, guildId, channelId, streamerId })`, with `serverId` the instance the
  channel belongs to (the held call's, else `activeServerId ?? LOCAL_SERVER_ID`). **It does not call `startWatch`**:
  see "For the next packages". Watching never joins.
- A refused join or listen does not throw in the store: it closes the call and sets `connectionError`. Each action
  reads that back and says so with a toast (`Could not join Lounge: <the server's sentence>`).

**The mute preference** (`muteStore.ts`, persisted per device, default **muted**). `voiceStore.selfMute` is false
again after every call, so the pill puts the preference back before every listen and every join (`toggleMute`, which
works without a call). While listening, the circle moves both the preference and the store, because G6's upgrade
applies `selfMute`. The call's own microphone button never writes the preference. Proven live below.

**LISTEN_IN_DISABLED.** A refused listen (403 `LISTEN_IN_DISABLED`) disables Listen (`aria-disabled`, it stays
focusable) with the server's own sentence as its tooltip, shows that sentence as a toast, and never turns into a
join; Join stays offered. The disabled state lasts two minutes, then a press asks the server again (a moderator
turning it back on is noticed without a reload). The server stays the authority.

**Expanded** (click the faces or the name; `glassStore.pillExpanded`). The capsule grows to the column, shows a
256x144 preview (click to Watch) and the roster: each person with a 26px face and their state. "Sharing screen" and
"Talking" are amber (`--amber-ink`), "Muted", "Listening in" and "Mic on" are ink-2 (yours is ink-1). Talking and
sharing wear the amber ring. While you listen, under the roster: "Everyone in Lounge can see you're listening in."
The row also says a line under the name ("Listening in quietly", "You're muted", "Brendan is talking", "Vincent is
streaming"). Escape collapses it and, when the focus was inside, puts the focus back on the faces.
`role="status"` announces "Listening in to Lounge", "Joined Lounge", "Left Lounge".

**The preview** draws the frames the media layer already receives: the watch view of this stream if that is what is
being watched, else the ambient view of it (`subscribeViewFrames`, 4 Hz cap, ambient 1). It never opens a view of its
own (ambient is one per client and belongs to G8; a watch belongs to the stage). With none it shows the room's tint,
and the label still says whose screen it is. Proven live: with G8's ambient target it draws Vincent's real frames.

**The waveform** appears when somebody talks. Inside a call this client holds it follows the real voice: the bars read
`--voice-level`, which `lib/motion/voiceLevel.ts` writes on the element marked `data-motion-speaking` (the loudest
person is the first talker). For a channel you are not in there is only "somebody talks" from the server, so it
loops. Its place is kept while nobody talks, so the pill does not change width with every breath.

**When space is short** (§5), decided in a layout effect by measuring the pill at each level against the room the
header gives it (a `ResizeObserver` on the slot):

| Level | Drawn |
|---|---|
| 0 | everything |
| 1 | no talking name (the line under the name) |
| 2 | Watch and Listen keep their icons (Watch gains the eye glyph), labels go |
| 3 | faces (two) and Join, or Leave |

**The talking name and the row.** `screens/01`, `02`, `03` draw no talking name in the compact row, so on the row
level 1 looks like level 0; the expanded row and the phone's first row draw it and give it up first. This is my
reading of "drop the talking name"; if the owner wants a name beside the waveform on the compact row, it is one
element and the ladder already treats it as the first thing to go.

**Phone** (`layout="stacked"`, `screens/07`): faces, "Lounge" and the waveform, "Brendan is talking" under it; then
Listen, the 44px mute circle and Join filling the rest (Watch between when a stream exists and none is on stage).
It answers to its own width (a container query on the pill): Watch, then Listen, lose their labels below 305px and
282px so it fits at 320. It expands in place.

## Motion

Expanding and collapsing play a FLIP on the capsule (`pillMotion.ts`): the layout changes at once and the difference
plays back over 550ms with the prototype's spring (`cubic-bezier(.3, 1.25, .5, 1)`).

- The **surface** (fill, hairline, backdrop blur) scales from its top-right corner. Its `border-radius` rides the same
  curve, counter-scaled, so the first frame is exactly the old capsule and the ends stay round instead of squashing.
- The **glow** (the 50px shadow and the amber glow) is a layer of its own that only scales, so the expensive blur is
  never repainted per frame.
- The **faces and name** slide by the distance the capsule's left edge moved; the controls, at the right edge, stay put.
- The **roster** rises in 120ms late (`translateY` and opacity); the **line under the name** fades in after the faces
  have slid into place, so it never crosses the buttons. On collapse the words fade (120ms) and then the capsule shrinks.
- Reduced motion: no move; the roster crossfades in 150ms.

**The one exception to "only transform and opacity animate":** the surface's `border-radius` (§9 says "position, size
and radius animate together"). `test:motion-lint` does not flag it (its forbidden list is box-shadow, width, height,
filter, backdrop-filter, top, left). If the owner prefers the strict reading, delete the `borderRadius` keyframe pair in
`playPillResize`; the ends then squash for about 100ms.

## Files

New (`client/src/components/glass/pill/`):

| File | What it is |
|---|---|
| `CallPill.tsx` | The slot component, both layouts, phases, focus, collapse levels, the FLIP wiring. |
| `model.ts` | Pure: which channel, who is in it and doing what, the line, the collapse ladder. |
| `useCallPill.ts` | Reads the stores (by slice, so a message never re-renders the header) and feeds the model. |
| `pillActions.ts` | What each button calls, and the listen-in-off block. |
| `muteStore.ts` | The persisted mute preference. |
| `PillPreview.tsx`, `PillRoster.tsx` | The 256x144 preview and the roster. |
| `pillMotion.ts` | The FLIP. |
| `model.test.ts` (28), `CallPill.test.tsx` (48) | Unit tests. |

New: `client/src/styles/glass-pill.css` (imported in `styles/globals.css` right after `glass-conversation.css`,
unlayered), `client/e2e/glass-pill.spec.ts` + `glass-pill.config.ts` + `glass-pill-dev.mjs` (the mocked shots),
`client/e2e/glass-pill-live.mjs` (the live proof).

Changed: `pill/index.ts` (real export); `styles/globals.css` (one import line). Deleted:
`glass/shell/stubs/CallPillStub.tsx`. Nothing outside the brief's scope was edited.

## Commands

Run in `~/Documents/Paracord-glass/client`.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | pass: 395 files, 3,996 tests (the whole client, other packages' work in progress included) |
| `npx vitest run src/components/glass/pill` | pass: 2 files, 76 tests |
| `npm run test:tokens` | pass (798 files) |
| `npm run test:motion-lint` | pass |
| `npm run lint` | 0 errors, 253 warnings; none in my files (`npx eslint` on `pill/`, the four e2e files: 0 problems) |
| `npm run test:contrast` | pass (52,950 comparisons) |
| `npm run test:a11y:static` | pass |
| `PARACORD_E2E_GLASS_WP=g12 npx playwright test -c e2e/glass-pill.config.ts` | pass, 12/12 (own ports 4413/4415) |
| `node e2e/glass-pill-live.mjs` against a live instance | pass, 25/25 |

The default harness (`glass-review.spec.ts`) was not run: its ports are fixed (4173/4175) and other packages run
against the same ones. `PARACORD_E2E_GLASS_WP=g12` shots of `01`, `02`, `03`, `07` come from my own spec instead.

## Live proof (2026-09-30, Sean's client, a real relay)

Setup: `live-env.mjs --port 18620` on the release `paracord-server`, `glass-scene.mjs --hold` (Vincent sharing,
Brendan on camera and talking, Nick muted, all in their own Chromium on the embedded UI), and Sean's and Luke's
clients served from this checkout's Vite dev server proxied to the instance. Every button is pressed, and each claim
is read back from the store, the relay's own counters (`media-stats`), or Luke's client.

`e2e/glass-pill-live.mjs`, final run (the log is in the scratchpad; the shots are `live-*.png`):

- The pill shows the live Lounge with 3 faces, Listen, Watch, the mute preference (default muted) and Join.
- Watch opens the stage on Vincent (`mode: side`, right `serverId`/`guildId`/`channelId`/`streamerId`), Sean is **not** in
  the call, the pill is not drawn beside the stage, and it comes back when the stage closes.
- The moderator turns listening in off: Listen is refused with `LISTEN_IN_DISABLED`, no call is left behind, it never
  becomes a join, Listen is `aria-disabled` with the server's sentence as its tooltip, Join is still offered.
- Listen: connects in listen mode with `getUserMedia(audio)` called **0** times; the mute preference travels in; the
  button reads "Listening", pressed, amber; Luke's store shows Sean `mode: listen`; the roster lists Sean last as
  "Listening in" with the sentence under it.
- The preview draws Vincent's real frames (580 distinct colors, 53% lit) from the ambient view riding the call.
- Join while listening: the **same engine, 0 new WebTransport connections**, the microphone opens now (`getUserMedia` 1),
  Sean joined **muted** (the preference), the pill shows the microphone, Watch and Leave and no Join or Listen, Luke sees
  Sean joined, the roster says Sean is "Muted".
- Unmuting from the pill: audio datagrams at the relay 0 to 202 in 4s. The call microphone did not rewrite the join preference.
- Leave leaves; the pill goes back; Luke no longer sees Sean. A cold Join joins muted by default.
- No page errors in Sean's client.

The instance's `listen_in_enabled` is put back on, and the scene, instance and Vite were stopped afterwards.

**Found, not mine to fix (voiceStore, G6).** After a leave and then a *cold* join in the same session, the engine's
`onParticipantJoin` handler (`voiceStore.ts`, near line 3517: `known ? {...known, ...} : { user_id, ..., no name })`)
finds no `known` state, because `closeCall` emptied `participants`, and replaces each other person's voice state with
a nameless placeholder with `self_stream: false`. The pill then reads "Unknown user" and loses Watch; the places panel's
"Vincent is streaming" would go too, until the server sends a change. The fix is one line: fall back to
`channelParticipants.get(channelId)?.find((member) => member.user_id === userId)` before fabricating a state. The live
driver prints a NOTE for it rather than failing. (Listen, and a Join from listening, are not affected: they never lose
`participants`.)

## Screenshots (`output/design-reference/glass-build/g12/`)

Mocked harness, 1440x900 unless noted (the mocked call state is put into `voiceStore` from the page; the fixture
stream feeds the ambient view; a level is published for Brendan the way the engine does):

- `pill-01-compact-desktop.png` against `screens/01-conversation.png`
- `pill-02-cross-server-desktop.png` against `screens/02-quiet.png`
- `pill-03-expanded-listening-desktop.png` against `screens/03-listen.png`; `pill-03a-listening-compact-desktop.png`
- `pill-03b-joined-compact-desktop.png`, `pill-03b-joined-expanded-desktop.png`, `pill-04-expanded-idle-desktop.png`
- `pill-05-width-1024.png` (level 2), `pill-05-width-900.png` (level 3)
- `pill-07-phone.png`, `pill-07b-phone-expanded.png`, `pill-07c-phone-320.png` (390x844, 320x640) against `screens/07-phone.png`
- `pill-move-open-{000,060,130,260,550}.png` and `pill-move-close-{000,090,200,550}.png`: the spring held at fixed
  moments (all finite animations paused at the same time), for the open and the close
- `pill-reduced-motion-expanded.png`; `pill-rects.json`: measured boxes

Live (real instance): `live-01-compact.png`, `live-02-listen-off.png`, `live-03-expanded-listening.png`,
`live-04-expanded-joined-muted.png`, `live-05-joined-unmuted.png`, `live-06-joined-cold.png`.

## Against the references (measured)

| | Reference | Mine |
|---|---|---|
| `01` pill | x 795 to 1245, y 22 to 74 | x 793.2 to 1246, y 22 to 74; right edge on the column's right edge |
| `01` controls | Listen 979, Watch 1069, mute 1137 to 1173, Join 1181 to 1237 | 978.5, 1069, 1137.4 to 1173.4, 1181.4 to 1238 |
| `02` pill | ends 1245, "Game Night Lounge" | 706 to 1246 (6px wider: text metrics), same controls |
| `03` expanded | x 527 to 1245, y 22 to about 265 (244) | x 526 to 1246, y 22 to 266 (244); preview 542,80 256x144; roster rows 36px apart |
| Idle expanded | 222px | 222px, exactly the column (720) wide |
| `07` | pill 366 wide, rows of 44px | 350 wide (the header's phone wrapper pads 8px), rows of 44px, Join fills |

## Differences left

- **Faces are initials** where the reference has cartoon avatars: the mocked scene has no avatar pictures (the live
  shots show the real ones). Nothing is tuned to the placeholder art.
- **The preview's picture** in the mocked shots is the DEV fixture scene, not the prototype's art; live it is Vincent's stream.
- **The waveform** in a still is caught mid-loop.
- **`07`:** the stream above the pill is G20's; the pill is 16px narrower because `.glass-conversation__phone-pill`
  (G11) pads 8px inside the pane's 12px gutter; Watch shows in row 2 because no stage is open in the mocked shot.
- **`02`:** the room's cool tint is G8's.
- **The mic glyph** is lucide's `Mic` / `MicOff`, a hair different from the prototype's hand-drawn slash.
- **Not built (the brief did not ask; decisions are the owner's):** Deafen "in the mic menu"; "Open Lounge chat" in the
  expanded pill; a stage channel's "Request to speak" (plan §1.3 defaults). A DM call still has G11's header button
  beside the pill's Leave. The "popovers over text" of §5 have no user here: the pill's tooltips are native `title`s.

## For the next packages

- **G14 (stage)** owns the watch session. `Watch` only calls `openStage`, so the stage must `startWatch(stage)` when it
  opens and `stopWatch()` when it closes (`startWatch` is idempotent for the same target). Otherwise pressing Watch
  without a joined call shows the Lantern stub and nothing more. Watching a DM call's stream passes `guildId: 'dm'`.
- **G15** (shared element): the pill is unmounted while a stage is open on the row and remounts when it closes;
  `pillExpanded` is reset by `openStage`. Mark the pill's root with `data-motion-shared` when you build the shrink-back.
- **G20 (phone)**: `.glass-conversation__phone-pill` (G11, in `glass-conversation.css`) pads the stacked pill 8px;
  the reference has it edge to edge in the pane.
- **G11**: `useDmCall.ts` and the header's DM call button can go once a DM call's controls are the pill's; today the
  button starts a call and the pill carries it.
- **G2 harness / G3 scene** (not my files): `glass-review.spec.ts` state `03-listen` can be driven the way
  `e2e/glass-pill.spec.ts` does (`holdCall`), because a mocked page has no relay; `glass-scene/ui.mjs` `CONTROLS` need the
  pill's names: `Join Lounge`, `Leave Lounge`, `Listen in to Lounge`, `Watch <name>'s screen`, `Microphone`, and
  `03-listen` in `shots.mjs` can press `Listen in to Lounge` then `Show who's in Lounge`.
- **G8**: the pill picks its channel and its stream the way `pickRoomStream` does, so its preview lines up with the
  ambient view. A cross-server pill (`screens/02`) has no ambient view (the room closes it on another server), so its
  preview shows the tint.
- **voiceStore** (G6): the placeholder-state finding above.
