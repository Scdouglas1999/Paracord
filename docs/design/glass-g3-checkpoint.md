# WP-G3 checkpoint: live scene driver

`client/scripts/glass-scene.mjs` builds the Glass reference scene on a real
Paracord instance through the product's own API and UI. It keeps a real Lounge
call running (a screen share, a camera, a talker and a muted member) and
captures Sean's view as named states. Nothing is mocked. Frames go through the
app's own media engine, the relay and a second browser's decoder.

## How to run it

```bash
cd client && npm run build
touch crates/paracord-server/src/embedded_ui.rs          # otherwise the embedded UI is stale
~/Documents/Paracord-wt/tools/pc-cargo.sh build --release --bin paracord-server
node scripts/live-env.mjs                                  # instance on :18420, data in .live-env/
# confirm the served bundle is the one just built:
curl -s http://127.0.0.1:18420/ | grep -o 'assets/index-[^"]*\.js'; ls client/dist/assets | grep '^index-.*\.js$'

node client/scripts/glass-scene.mjs                  # seed (or reuse) + call, hold; status every 30s
node client/scripts/glass-scene.mjs --shot all       # seed + fresh call, shoot every reachable state, exit
node client/scripts/glass-scene.mjs --shot all --hold  # the same, then keep holding
node client/scripts/glass-scene.mjs --shot 01-conversation   # against a call another process holds
```

| Option | Meaning |
|---|---|
| `--base <url>` | Instance to target (default `http://127.0.0.1:$PARACORD_LIVE_PORT` or `:18420`; works with `pc-lab.sh up <port>`) |
| `--shot <names\|all>` | Capture Sean's view to `output/design-reference/glass-build/live/<state>.png` (comma list allowed) |
| `--hold` | Keep the scene up after the shots and print status every 30s (the default when no `--shot` is given) |
| `--no-call` | Never start the call |
| `--reseed` | Owners delete the scene's servers, then the scene is built again |
| `--seed-only` | Find or build the scene, write `scene.json`, exit |
| `--tag <suffix>` | Account suffix (`sean<suffix>`) when the plain names are taken on an instance |
| `--no-typing` | Do not keep Eric typing in General |
| `--headed` | Show the browsers |
| `--out <dir>` | Where shots go |

Ctrl-C (SIGINT) leaves the call through the UI and through
`POST /api/v2/voice/{id}/leave`, then checks the relay until the room is empty,
closes every browser and exits. `kill -USR2 <pid>` (the holder prints its pid)
makes the cast rejoin in fresh browsers. This is currently refused by the product (finding 1).

A second process that finds the call live (all three connected and video still
arriving, checked over 2.5s) does not start its own call. So one terminal can
hold the scene while another shoots against it. Every run writes
`output/design-reference/glass-build/live/scene.json` (ids, and the cast's
sign-ins for this local instance, for example to sign Sean into `tauri dev`).
It also writes `shots.json` (the result of each state).

### Adding a state

States are objects in `client/scripts/glass-scene/shots.mjs`:

```js
'05-theater': {
  reference: '05-theater.png',
  viewport: { width: 1440, height: 900 },
  unread: true,                        // put Sean's unread marks back first (optional)
  async run({ page, go, session, log, api, people, ids }) { /* navigate, wait */ },
  async after({ page, api, people, ids }) { /* undo anything that would leak */ },
},
```

`run` leaves the page showing the state, and the driver takes the screenshot
after waiting for a fresh frame. `run` can instead return `{ png }`, a frame it
has already checked. `go(serverKey, channelKey)` navigates.
Control names live in one place (`CONTROLS` in `glass-scene/ui.mjs`). When a
Glass package renames a control, add the new accessible name there.
`03-listen`, `05-theater` and `06-browse` are listed as `pending` with the
package that makes them reachable, and `--shot all` skips them.

## What it creates

- **Cast** (display names; usernames are lowercase, password in `glass-scene/scene.mjs`):
  Sean (the viewer, all shots are his browser), Vincent, Brendan, Nick, Jeremy, Luke, Eric.
  Each account gets the reference's illustrated face as its avatar. The SVGs are
  lifted from `GlassV14.dc.html` and rendered to PNG in Chromium.
- **Game Night** (owner Brendan, 7 members, reference icon): General (topic "Haz 5
  runs from 9. Bring snacks."), Lounge (voice), Clips, LFG, Patch notes. The role
  "Hosts" (Manage Server) is given to Sean so that he can host Movie night.
- **Basecamp** (owner Eric, 5 members, reference icon, and a generated cool dawn-ridge
  **banner**): Trips, General, Photos, Gear. The default voice channel is removed.
- **Sunday League** (owner Luke, reference icon): Matchday, with two mentions of Sean.
- **Posts** (24, from the reference): Nick's personal best with the **41:07 image**
  (rendered from the reference SVG) and reactions 🔥 5 (including Sean) and ❤️ 3.
  Jeremy's **"@Sean is movie night still on?"** (a real `<@id>` mention).
  Vincent's "already in `<#lounge>` streaming the warmup". In Clips, Brendan's 38:12
  revive image and Luke's **reply** to it. Trips has the four permit messages, Photos
  has four generated trail photos, and LFG has a **poll** ("What are we playing after
  the run?", 5 votes).
- **Read state**: Sean's marks are set so that the badges match the reference: a
  mention in General, 3 in Clips, 4 in Trips, and 2 mentions in Sunday League.
- **Events**: Haz 5 run (tonight 9:30 PM, or the next half hour if that has passed, in
  Lounge, by Brendan, 3 RSVPs); Movie night (next Friday 9 PM in Lounge, **created by
  Sean**, 6 going); Rim trail hike (next Saturday 7 AM, north lot, by Eric, 4 going).
- **Presence**: Jeremy, Luke and Eric stay online through a bare realtime stream
  (ticket, then SSE) and have no browser. Eric's typing is re-sent every 8s in Game
  Night › General.
- **The call**: three headless Chromium browsers, one per person, launched with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`. Each joins
  Lounge through the app's own Join control.
  - Vincent: `getDisplayMedia` is overridden to return a `canvas.captureStream()` of
    the reference stream scene. It shows a warm amber glow, teal crystals, a miner
    with a headlamp beam that sways, dust that drifts, and a "MORKITE n/250" counter
    that ticks. The scene is 1280×720 at 24 fps, and each frame differs from the last.
  - Brendan: camera on. `getUserMedia({video})` returns an animated portrait of his
    reference face, with headphones and a mouth that moves with his voice.
    `getUserMedia({audio})` returns a speech-like synth (a formant-filtered pulse train
    with syllable and phrase envelopes), so the app reports him as talking.
  - Nick: muted through the app's mute control.

  Seeding is idempotent. A complete scene is found and reused. A partial one, from a
  run killed partway, is deleted by its owners and rebuilt.

## Proof it worked (2026-09-29, `:18420`, release build of this branch at 20:29)

Final run, `node client/scripts/glass-scene.mjs --shot all --hold`, stopped with SIGINT:

```
Lounge call
  Vincent joined Lounge (sharing)
  Brendan joined Lounge (camera on, talking)
  Nick joined Lounge (muted)
  relay: 3 connected over webtransport
  01-conversation   …/live/01-conversation.png
  02-quiet          …/live/02-quiet.png
  03-listen         pending — G6 + G12 (listen-in and the call pill)
                    Vincent's scene on screen: 3054px teal, 20062px amber
  04-side-by-side   …/live/04-side-by-side.png
  07-phone          …/live/07-phone.png
[21:11:22] Lounge: Vincent (streaming, 200 video pkt/s), Brendan (camera, 194 video pkt/s), Nick (muted) · relay 3 connected · streaming yes · around: Luke, Eric, Jeremy
[21:11:52] Lounge: Vincent (streaming, 202 video pkt/s), Brendan (camera, talking, 198 video pkt/s), Nick (muted) · relay 3 connected · streaming yes · around: Luke, Eric, Jeremy
```

The status line is the server's view of the call. The names and "relay N connected"
come from `GET /api/v1/voice/{id}/media-stats` (the relay). The packet rates are the
change in the relay's `video_datagrams_received` counter. "streaming",
"camera" and "muted" come from `self_stream`, `self_video` and `self_mute` in the
voice states that Jeremy's realtime stream receives (READY, then
VOICE_STATE_UPDATE). "talking" comes from Brendan's synth level. A separate
holder ran for 10 minutes (20:46 to 20:56) at about 200 video packets per second
per publisher with no drops. After Ctrl-C, `voice_states` on the instance is empty at once.

Screenshots, all 1440×900 except the phone at 390×844. I read each one:

- `output/design-reference/glass-build/live/01-conversation.png`: Game Night ›
  General in the current (Lantern) shell. Sean's message is followed by Brendan,
  Vincent (marked "in Lounge"), Nick with the 41:07 image and the 🔥5 ❤️3 reactions,
  and Jeremy's @Sean mention, which is highlighted. The header shows the topic.
  All three servers are in the sidebar, and Sunday League's Matchday shows 2.
- `.../02-quiet.png`: Basecamp › Trips, with Sean's question, then Eric ×2, Luke and
  Eric, under a "Today" divider. Game Night shows its unread General.
- `.../04-side-by-side.png`: Sean has joined Lounge and **Vincent's scene is on his
  screen**, decoded from the relay. The teal crystals, the amber glow, the miner and
  the beam are visible, and the counter reads `MORKITE 218/250` (the seed value is
  212, so frames were arriving). Brendan's camera tile shows his portrait with
  "speaking". Nick, You and Vincent are in the strip. The check is not the DOM: the
  driver counts the scene's teal and amber pixels in a real screenshot, and it
  saves the frame it counted.
- `.../07-phone.png`: General at 390×844 with the mention, image and reactions.

Held against the references: these are the Lantern shell. The Glass frame,
places, bubbles and pill arrive with G7–G13, so the differences are the whole
look. The content matches the reference (names, text, image, reactions, mention,
badges, topic) except for the points under limitations.

## Findings (product, for the owning packages)

1. **Rejoining a call is refused ("Media encryption could not verify a
   participant: Someone in this call has not published a media key…")**. Steps:
   hold the call, then run `--shot 04-side-by-side` twice. The first join by Sean
   works. Every later join by Sean into the same call fails, and so do in-app
   "Try joining again", a fresh page, a 90s wait, and five retries 20s apart.
   Vincent hits the same failure when he rejoins after `kill -USR2` while Brendan
   and Nick stay in the call. With the same publishers still present, the first
   join per account succeeds and later ones fail (reproduced 3 times). The error
   is `MediaKeyring.requirePeer` (`client/src/lib/media/mediaKeyring.ts`), thrown
   on the rejoining client. This matters for G5, G6 and G14, because listening,
   watching and Leave-then-Join all depend on rejoining. The binary tested was built
   before G5's current relay edits.
2. **The current stage drops a watched share about 1s after joining through the
   lobby's Watch**. The share is decoded and painted: the driver saw it, and the
   saved 04 frame shows it. The stage then falls back to the tile grid, the viewer
   is labeled "Someone's screen", and Vincent's tile offers no Watch after that.
   This is Lantern `VoiceStageChannel`/`StreamViewer`, which G14 replaces. The G14
   stage should not repeat it. The driver's 04 logs "…and 3s later it is gone
   again" while this is still true.
3. `<#channelId>` is shown raw in the timeline ("already in <#3634…>"). Previews
   resolve it, but the message renderer does not. G13's inline live-channel chip
   is the fix. The scene uses the standard token on purpose.
4. The voice lobby and roster show **usernames** (lowercase "vincent") rather than
   display names. Voice states carry `username`. The G12 pill and the G14 roster
   should use display names.
5. An event in a voice channel gets an auto-created text channel
   (`event-haz-5-run`) as its start approaches. The reference has none. This is
   worth deciding on for G9.
6. The app ignores a session cookie obtained by `POST /auth/login` outside the
   page and still shows the login form, so the driver signs in through the login
   page. Separately, five refused register or login attempts from loopback lock
   the auth guard for a while. The driver orders its attempts so that a run costs
   at most one refusal.

## Known limitations

- Timestamps are real, so messages show the time of seeding (not 9:02 PM) and the
  catch-up divider will say "4 new", not "6 new". There is no backdating without
  touching the database.
- Unread state only moves forward on the instance, and opening General marks it
  read. States marked `unread: true` therefore first **take down and repost** the
  posts that came after Sean's read marks (same authors, text and images), so the
  badges and divider come back. This fires message events on every client each
  time.
- Not seeded: DMs (the reference's Home "2 unread" needs E2EE enrollment and
  unlock for each account), the Sunday League "live match", and the clip message
  ("0:30 from Vincent's screen", which G16 will post for real). The reply chip in
  Sean's composer ("Reply to Jeremy") is UI state for the Glass shots, not seeded
  data. The Haz 5 run plan card and the Movie night chip are real events, but the
  messages do not link them yet. G13 decides the link format, and the text is one
  line in `scene.mjs`.
- `04-side-by-side` currently works once per held call, because of finding 1. It
  always works in a single `--shot all` run, which starts a fresh call. The
  `heal()` rejoin (someone missing from the relay twice in a row) and SIGUSR2 are
  in place but blocked by the same finding.
- Headless Chromium only (the `chromium_headless_shell` build that Playwright
  1.63 uses by default). `--headed` exists but was not exercised here.
  The Tauri/WebKitGTK side is G23.
- `pc-lab.sh` was not exercised. `--base` is supported. `api.request` retries a
  429 up to five times, for stricter rate limits than `live-env` sets.
- If a holder is killed with SIGKILL it cannot leave. Its seats stay registered
  until the relay retires them (about 30–60s), and meanwhile a new run correctly
  refuses to treat that as a held call, because no video is arriving.

## Files

- `client/scripts/glass-scene.mjs`: the CLI (options, seed/reuse, presence,
  typing, call, shots, hold and status, cleanup).
- `client/scripts/glass-scene/scene.mjs`: the scene as data (cast, servers,
  channels, posts, read marks, events, images, call roles).
- `client/scripts/glass-scene/seed.mjs`: sign-in, find/delete/seed, the unread reset.
- `client/scripts/glass-scene/api.mjs`: REST client, sign-in ordering, uploads, realtime stream holder.
- `client/scripts/glass-scene/art.mjs`: SVGs for the faces, icons, banner and images,
  and the stream scene paths, from the reference.
- `client/scripts/glass-scene/assets.mjs`: SVG to PNG in Chromium.
- `client/scripts/glass-scene/media-init.mjs`: the in-page media sources
  (display scene, portrait camera, voice synth).
- `client/scripts/glass-scene/ui.mjs`: browser launch, sign-in, overlays,
  `CONTROLS`, join with reported retries, and the pixel checks (`sceneOnScreen`).
- `client/scripts/glass-scene/call.mjs`: the Lounge call (join, share, camera,
  mute, relay verification, heal, recycle, teardown).
- `client/scripts/glass-scene/shots.mjs`: the named states.
