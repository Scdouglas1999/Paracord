# Glass fix: screen share and voice state in DM calls

Closes the two server gaps WP-G22 reported (`glass-g22-checkpoint.md` §4, evidence in
`output/design-reference/glass-build/g22/live-calls/dm-stream-refusal.json`). Branch `design/glass`, not
committed.

1. **Screen share in a DM call was refused.** `POST /api/v1/voice/{dm}/stream` and
   `POST /api/v2/voice/{dm}/view` answered `400 Not a voice channel`.
2. **Voice state updates in a DM call were dropped.** The gateway's `OP_VOICE_STATE_UPDATE` returned when the
   channel had no guild, so nobody saw the other person's mute or camera.

A third problem turned up while fixing the second: **DM call leaves were announced to everyone.** An event
dispatched with no guild and no target users is a global event (`EventBus::publish`), and four places
announced a DM call's leave that way: the gateway's explicit leave, the gateway's disconnect sweep, the
SSE `voice_state_update` command's leave and `voice_cleanup` (the relay-retire sweep). Every connected
session was told that user X left DM call Y. They now go to the DM's recipients only.

## The rule

A DM or group DM call (channel type 1 or 3, no guild) belongs to its recipients.

| What | Who may | Notes |
|---|---|---|
| Start a share (`POST /api/v1/voice/{dm}/stream`) | a recipient in the call, with its receipt | The same rule as a DM call's join: never across a block in a 1:1 DM (`ensure_channel_permissions` with CONNECT + STREAM). Not a recipient: 403. |
| Stop a share | a recipient | Never refused for a block, so a share always ends. |
| Watch (`POST /api/v2/voice/{dm}/view`, `watch`) | a recipient | In the call: rides the call (`via_membership`). Not in the call (a group DM recipient who did not join, or a 1:1 recipient who left): a view session in the DM's relay room `0:{dm}`. Never across a block. |
| Ambient view | nobody | `400 The room light is for server channels; a DM call has none`. |
| Watcher counts (`GET .../watchers`, `VOICE_WATCHERS_UPDATE`) | recipients | `guild_id: null`. |
| Voice state updates (mute, deafen, camera) | a recipient already in this DM's call | Both transports. A status update never creates a DM membership (joining is `POST /api/v1/dms/{id}/voice/join`). A stale receipt is refused (SSE 409; the gateway ignores it). |
| `VOICE_STATE_UPDATE` / `VOICE_WATCHERS_UPDATE` for a DM call | delivered to the DM's recipients only | Never to a guild, never global. |
| READY | each recipient gets the people in its ongoing DM calls | New top-level `dm_voice_states` (both transports), the `VoiceStateSnapshot` shape with `guild_id: null`. Its own row is skipped by the client, as for servers. |

A view of a DM call is re-checked by the existing 5 s sweep (`revoke_views_without_access`): a viewer removed
from the group DM, or blocked in a 1:1 DM, is ended as revoked (4003).

E2EE and the G6b key rules are unchanged. A DM call's relay room is the same kind of room as a server
call's; the relay marks a view-session viewer `viewer`, the engines send it the screen keys only, and members
get every key. Nothing in the relay, the transport or the engines needed DM awareness: the room key is
`0:{channel}` and the view admission reads the room from the view record.

## What changed

### Server

- `crates/paracord-core/src/voice_events.rs` (new): the one fan-out for call events.
  `dispatch_call_event` sends to the guild for a server channel and to `get_dm_recipient_ids` for a DM
  call (guild `None` or `0`); a failed recipient read returns the error and sends nothing (never widened to a
  global dispatch). Also `is_dm_call_channel`, `call_voice_state_payload` (the stored row as a
  `VoiceStateSnapshot`; `voice::voice_state_payload` now delegates to it and gains `display_name`),
  `ready_dm_voice_state`, and `update_dm_call_flags`, the DM branch both realtime transports share
  (recipient, in this call, receipt, keep the stored stream flag, write, announce).
- `crates/paracord-api/src/routes/voice.rs`: `start_stream` / `stop_stream` take a DM call (`call_guild_of`);
  federation is skipped for DMs; the LiveKit path keys a DM under guild 0 as `join_dm_voice` does.
  `record_stream_flag` takes `Option<guild>`. Announcements go through `announce_call_voice_state`.
  View routes resolve a `ViewPlace` (`Server { guild_id, perms }` or `Direct`); the relay key is
  `room_guild()` (0 for a DM). `view_still_allowed` handles DM views. The watcher housekeeping dispatches
  through `dispatch_call_event`.
- `crates/paracord-api/src/routes/realtime.rs`: the SSE `voice_state_update` command's DM branch
  (`update_dm_call_flags`; a `guild_id` with a DM channel is 400), its leave through the fan-out, and READY's
  `dm_voice_states`.
- `crates/paracord-ws/src/handler.rs`: the opcode's DM branch, the explicit leave and the disconnect sweep
  through the fan-out, READY's `dm_voice_states` (a failed read closes 1011 like the guild snapshot).
- `crates/paracord-core/src/voice_cleanup.rs`: its leave through the fan-out.
- `crates/paracord-db/src/voice_states.rs`: `get_dm_call_voice_states_for_recipient` (one query; joins
  `dm_recipients`; `COALESCE(space_id, 0) = 0`; no new columns, both engines).
- `crates/paracord-api/src/routes/dms.rs`: the DM join's `VOICE_STATE_UPDATE` now carries `mode` and
  `self_stream_started_at`, so it matches `VoiceStateSnapshot`.
- Contracts: `VoiceViewSession.guild_id` and `VoiceWatchers.guild_id` are `string | null` (null for a DM
  call). Regenerated `contracts/api-contracts.json` and `client/src/api/generated/*`.

Outside the brief's crate list: `paracord-db` (the READY query) and `paracord-contracts` (the nullable
guild). Both were needed for the brief's own requirements.

### Client

- `components/glass/stage/StageControls.tsx`: the Share button and More's "Share quality" are back for DM
  calls (the `!model.dm` gates are gone). `CallStage.tsx`'s comment says so.
- `stores/voiceStore.ts`: `loadDmVoiceStates(states, scope)`, authoritative for that account's DM calls. A
  DM voice state has no guild, so the store remembers which DM call channels each account reported
  (`dmCallChannelsByScope`, from READY and live updates) and replaces only those: a call that ended while
  the client was away disappears, another account's DM calls are untouched, and this client's own live DM
  call keeps its local row.
- `gateway/dispatch.ts`: READY's `dm_voice_states` goes to `loadDmVoiceStates` (a non-array is a logged
  parse failure; absent, from an older server, changes nothing). Live DM `VOICE_STATE_UPDATE`s already went
  through `handleVoiceStateUpdate`.
- `stores/voice/watchers.ts`: `isVoiceWatchersUpdate` accepts `guild_id: null` (an empty or missing one is
  still refused).
- The DM stage watches the other person's share with no further change: `useStageWatch` already passed the
  call's `'dm'` key through `voiceGuildOf(null)`, and the server answer's `guild_id` is never read.

## Verification

### Rust

| Command | Result |
|---|---|
| `pc-cargo.sh test -p paracord-api --test dm_call_streams` (new, 6 tests) | pass, SQLite and PostgreSQL |
| `pc-cargo.sh test -p paracord-ws --test gateway_integration dm_call` (2 new) | pass |
| `pc-cargo.sh test -p paracord-core -p paracord-db -p paracord-ws -p paracord-api -p paracord-contracts` | 100 binaries, 1,403 tests, pass (SQLite) |
| `PARACORD_TEST_POSTGRES_URL=… pc-cargo.sh test -p paracord-api --test dm_call_streams --test voice_listen_view --test voice_listen_view_sse --test voice_routes --test voice_session_ownership --test realtime_voice_receipts --test contract_wire_shapes --test postgres_route_smoke --test realtime_channel_visibility --test stream_reactions` | 58 tests, pass |
| same, `--test realtime_sse_resume --test realtime_presence --test realtime_guild_scope_growth --test conversation_capabilities` (every READY now runs the DM query) | 25 tests, pass |
| `pc-cargo.sh clippy -p paracord-{core,db,ws,api,contracts} --tests -- -D warnings` | clean |
| `pc-cargo.sh check --workspace --tests` | pass |
| `cargo fmt --all -- --check` | only `paracord-server/src/main.rs` and `paracord-api/tests/voice_listen_view_sse.rs`, both unformatted before this package and not touched |

PostgreSQL: a throwaway `postgres:16-alpine` container (`--rm`, port 55437), confirmed used (the test
template database appeared in it), stopped and removed afterwards.

New tests:

- `dm_call_streams.rs`: a recipient in the call shares (announced to exactly the two recipients, no guild,
  a `VoiceStateSnapshot`), an outsider's share and stop are 403, a stale receipt is 409, the stop is
  announced to the recipients; a block refuses a share in a 1:1 DM; a recipient in the call watches through
  it (`via_membership`, `guild_id` null, the counts event to the recipients only, counts readable by a
  recipient and 403 for an outsider, the stop scoped to the call's receipt); in a group DM an outsider's
  watch is 403, ambient is 400, a non-streamer is 409, a recipient outside the call gets a view session in
  `0:{dm}` that the relay admits as a viewer and that never shows them in the call, and removing them from
  the group DM ends it on the next sweep; the SSE command's mute and camera are stored and announced to the
  recipients only, a mute while sharing keeps the share, a stale receipt / an outsider / a recipient not in
  the call / a mismatched guild are refused and unannounced, the leave goes to the recipients only; SSE
  READY lists the DM call for a recipient and nothing for an outsider.
- `gateway_integration.rs`: over real `run_session`s, Jeremy's opcode 4 reaches Sean's session with
  `guild_id` null, a stale receipt changes nothing, an outsider cannot announce themselves into the DM's
  call, the leave reaches Sean, and the outsider's session hears none of it; READY over a real WebSocket
  lists the DM call for Sean and `[]` for the outsider.

### Client

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run contracts:check` | 37 types verified |
| `npx vitest run src/components/glass/stage src/gateway src/stores/voice src/stores/voiceStore src/api` | 32 files, 345 tests, pass |
| `npx vitest run` (whole suite) | 4,189 of 4,190; the one failure is `PlanCard.test.tsx` "Tonight at", a time-of-day test that fails after about 21:00 local (the event rolls into tomorrow); unrelated |
| `npx eslint` on every touched client file | 0 errors |

New or changed unit tests: the DM stage offers Share and its quality (no invite or soundboard), a click on
Jeremy's share opens his stream with `guildId: null`, and its watch goes out under the `'dm'` key
(`Stage.test.tsx`); live DM updates, READY replacing only this account's DM calls and skipping its own row,
another account's READY leaving them alone (`voiceStore.media.test.ts`); READY's `dm_voice_states` and a
DM `VOICE_WATCHERS_UPDATE` through the dispatcher (`dispatch.test.ts`); the watcher guard
(`watchers.test.ts`).

### Live (the embedded build, a real relay)

`npm run build`, `touch crates/paracord-server/src/embedded_ui.rs`, `pc-cargo.sh build --release --bin
paracord-server`; the served `assets/index-CHyo1xDG.js` matched `client/dist`. `live-env.mjs --port 18860`
with its data in the session scratchpad. A scratch driver (`dm-calls-live.mjs`, in the scratchpad; built on
`client/scripts/glass-scene`) ran Sean and Jeremy in their own Chromium through the app's controls, and
held Luke (not a recipient) on both an SSE stream and a WebSocket gateway session. **18 of 18**
(`output/design-reference/glass-build/fix-dm-calls/run.log`, `results.json`):

- Jeremy starts the DM call from the header, Sean joins the same way; both open "Show the call".
- Jeremy's DM stage offers **Share your screen** (`01-jeremy-dm-stage.png`).
- Jeremy turns his camera on and mutes: Sean's stage draws Jeremy's camera tile with his picture (491
  colors) and reads "Jeremy, Muted, camera on" (`02-sean-sees-jeremy-camera-muted.png`; G22's failure).
- Jeremy unmutes and turns the camera off: the tile goes and Sean's list reads "Jeremy, Mic on"
  (`02b-…png`).
- A fresh READY on Sean's account lists Jeremy in the DM call with `guild_id: null`.
- Jeremy shares from the DM stage (`03-jeremy-sharing.png`); Sean presses "Watch Jeremy's screen" and the
  share's scene is on his Glass stage (teal 4,862 px, amber 7,252 px; `04-sean-watches-jeremy-share.png`).
  The counts read `{"guild_id":null,…,"watchers":1}`.
- Luke: stream, watch, ambient and watchers all 403; Sean's ambient view is 400. Luke heard **no** DM
  voice or watcher event on either transport, and his READY lists no DM call.
- Jeremy stops sharing; both leave; no page errors.

One run failed a check of my own driver (it looked for a chip class that the camera-less call view does not
use); the state itself was right, as the screenshot and the people list showed. The locator was fixed and
the run repeated clean.

Everything started was stopped: the live-env and its server, the browsers, the PostgreSQL container. The
owner's own `paracord-server` (pid 1203) was not touched.

## Not done / left

- **Stream reactions and Clip in a DM stream.** The stream's stage shows the reaction buttons and Clip for a
  DM share; reactions are disabled there (`StreamReactionsLayer` says a DM has none, and
  `POST /api/v2/voice/{dm}/stream-reactions` still requires a server voice channel). Whether DMs should have
  reactions is an owner call; `StreamReactionsLayer` belonged to the concurrent polish package, so it was
  not touched. Clip in a DM was not exercised.
- **Listening in** stays a server-channel feature (`/mode` and `?mode=listen` still refuse a DM).
- **The desktop app** was not run; the change is server-side plus the shared stage and store, and the
  desktop engine's key rules were not touched.
- `docs/encryption.md` does not mention DM calls; the rules there apply to them unchanged (members and
  viewers, one key per track). A sentence could say that in a DM call only the DM's recipients can be
  members or viewers.
- `dm-calls-live.mjs` lives in the session scratchpad. If it should be kept, it belongs in
  `client/scripts/glass-scene/` beside `stage-live.mjs`.
