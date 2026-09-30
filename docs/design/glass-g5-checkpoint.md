# WP-G5 checkpoint: listen and view sessions

Status: done in scope, not committed. Branch `design/glass`. Three small
changes the package needs live **outside its file list** and are delivered as a
verified patch, not applied: see "Outside the scope" below. Until that patch is
applied, view-session media connections are refused at admission and the SSE
transport's READY / mute events lack the two new fields.

## Endpoints

| Route | What |
|---|---|
| `GET /api/v1/voice/{id}/join?mode=` · `POST /api/v2/voice/{id}/join?mode=` · `POST /api/v2/voice/recover?mode=` | `mode` = `joined` (default when absent) or `listen`; anything else 400. Response gains `"mode"`. |
| `POST /api/v2/voice/{id}/mode` | Body `UpdateVoiceModeRequest {mode, session_id?}` → `VoiceModeResponse {channel_id, session_id, mode, can_publish}`. In place: same receipt, same media connection. |
| `POST /api/v2/voice/{id}/view` | Body `StartVoiceViewRequest {kind: "watch" \| "ambient", user_id: streamer}` → `VoiceViewSession`. |
| `DELETE /api/v2/voice/{id}/view[?session_id=]` | 204, idempotent. |
| `GET /api/v2/voice/{id}/watchers` | `VoiceWatchers` (same shape as the event). VIEW_CHANNEL. |
| `PATCH/GET /api/v1/channels/{id}/features` | New field `listen_in_enabled` (default true; voice channels only, 400 on others; MANAGE_CHANNELS to change). |

Errors worth knowing for WP-G6:

- Listen join / recover / switch to listen in a channel with listen-in off:
  **403 `{"code": "LISTEN_IN_DISABLED", ...}`** (same body shape as every API
  error). The brief wrote `listen_in_disabled`; the codes in this API are all
  upper snake case, so it follows them. `ApiError` has no variant for a custom
  code and `error.rs` is outside the scope, so the voice routes use a local
  `VoiceRouteError`; the v1/v2 join and recover **routes now point at
  `routes::voice::join_voice_with_mode` / `recover_voice_with_mode`** (route
  lines in `lib.rs`). `voice_v2::join_voice_v2` / `recover_voice_v2` still
  compile but are no longer routed (a plain 403 if called); deleting them is a
  one-line follow-up outside this package's files.
- Listen is voice channels only (400 for stage). Listen on a federated
  (remote-mapped) channel: 409 (the remote server would issue a publishing
  credential).
- `/mode`: 409 when not in the channel or `session_id` is stale; 409 when the
  call has neither a native relay membership nor LiveKit. Same mode again: 200,
  no event.
- `/view`: 503 (`NotConfigured`) without native media; 403 without
  VIEW_CHANNEL (both kinds) or CONNECT (`watch` only); 409 when the named user is
  not streaming in that channel; 400 for your own stream; 409 when the room has
  200 viewers (`MAX_VIEWERS_PER_ROOM`).
- Stream start now needs a voice state in that channel (409 otherwise; it used
  to announce a phantom member) and refuses listeners (409). Stream stop by
  someone not in the channel is a silent 204 (it used to announce a phantom).

## Event and wire shapes

`VOICE_STATE_UPDATE` (non-leave) and READY `guilds[].voice_states[]` carry:

```ts
mode: 'joined' | 'listen';
self_stream_started_at: string | null; // RFC 3339, non-null exactly while self_stream
```

Contract type: `VoiceStateSnapshot` (generated). Leaves (`channel_id: null`,
`prior_channel_id`) are unchanged and do not carry them.

New event **`VOICE_WATCHERS_UPDATE`** (guild-scoped with `channel_id`, so both
transports deliver it only to sessions with VIEW_CHANNEL; intent
`GUILD_VOICE_STATES`):

```ts
{ guild_id: string; channel_id: string; streams: { user_id: string; watchers: number }[] }
```

A complete snapshot per channel; an absent streamer has 0. Sent when the counts
change (coalesced 250 ms), however they changed.

`VoiceViewSession`:

```ts
{ guild_id, channel_id, kind: 'watch'|'ambient', user_id /* streamer */,
  via_membership: boolean, session_id: string | null,
  media: { media_endpoint, media_endpoint_candidates, media_token, cert_hash, room_name } | null }
```

Contracts added (`crates/paracord-contracts/src/voice.rs`): `VoiceStateSnapshot`,
`UpdateVoiceModeRequest`, `VoiceModeResponse`, `StartVoiceViewRequest`,
`VoiceViewSession`, `VoiceWatchers`.

## Migrations (both engines, identical statements)

`20260929000001_voice_listen_mode.sql` in `migrations/` and `migrations_pg/`:

- `voice_states.mode TEXT NOT NULL DEFAULT 'joined' CHECK (mode IN ('joined','listen'))`
  (constant default is also the backfill).
- `voice_states.self_stream_started_at TEXT NULL`, then
  `UPDATE … SET self_stream_started_at = datetime('now') WHERE self_stream = TRUE`
  (PostgreSQL uses the existing `datetime()` shim).
- `channel_feature_settings.listen_in_enabled BOOLEAN NOT NULL DEFAULT TRUE`.

DB layer: every voice-state read selects `mode` and the start time (bools still
via `CASE`, `request_to_speak_at` still `CAST … AS TEXT`); booleans are bound as
`bool`. `update_voice_state` now returns the stored row (`RETURNING`) and stamps
the start time in SQL: set when `self_stream` goes false→true, kept while it
stays true, cleared when false; so the gateway's and realtime's mute paths keep
it without changes. New: `set_voice_mode` (receipt-scoped; entering `listen`
clears stream/camera), `begin_voice_state_transition_with_mode`,
`channel_features::listen_in_enabled`. `upsert_voice_state` (legacy joins) keeps
the mode in the same channel, `joined` elsewhere.

## How listen / watch / ambient map onto the relay

- **Listen** = a normal call member with `can_publish = false` (the existing
  receive-only participant). It receives the voices (auto-subscribed like any
  member), is in the relay roster, and its media is dropped before fan-out.
  `/mode` flips `can_publish` on the same participant under its receipt
  (`update_participant_publish_permission_if_session`); DB write after, relay
  reverted if the write fails.
- **View session** = a room participant with `view: Some(ViewTarget {kind,
  publisher_user_id})`, no voice state. Receive-only, holds no participant-level
  (voice) subscriptions, and may subscribe only to the watched publisher's
  screen stream (`stream_id` ending `:screen`: the `screen` video and, for
  watch, `screen-audio`). Enforced in the room (`subscribe_track` refuses
  anything else) and again in fan-out (`should_relay_packet_to`). A viewer's
  publish, key-announce and voice-subscribe control messages are ignored; key
  announces to a viewer are delivered only for the watched stream; the voice key
  never reaches a viewer.
- **Roster scoping**: a viewer sees only its publisher in `SessionState` /
  join / leave; a member sees members plus the viewers watching *its own*
  stream (it must wrap its stream key to them); nobody else sees viewers.
- **Ambient**: subscription pinned to the track's lowest layer (layer 0) whatever
  it asks; excluded from datagram fan-out (no deltas); receives **keyframes
  only**, at most one per second (`AMBIENT_FRAME_INTERVAL`); a per-connection
  task asks the publisher for a lowest-layer keyframe when none reached the
  viewer for a second (throttled per stream to one a second across all ambient
  viewers); receiver reports ignored; never in layer selection; never counted.
- **One view per account**: a new view replaces the old anywhere (the relay
  closes the old view connection). A user in a channel's call watches through
  the call instead (`via_membership`, recorded as `watching` on the member, no
  new connection). A viewer who joins the call keeps watching (carried over).
- **Two connections per account**: the relay keys connections, announced
  sessions, downlink estimates and layer selection by `(user_id, slot)` with
  `slot = Call | View` (resolved at registration from the room membership the
  receipt names). A view never supersedes the call or resets its sender-side
  state; fan-out only uses a connection registered for that room.
- **Counts**: `MediaRoom::watcher_counts` = watch views + members watching
  through the call. Every mutation that can change them marks the room dirty;
  a per-server task (started on the first `/view`) drains that set and
  broadcasts, and every 5 s retires views without a live connection for 20 s
  (never connected, or dropped), closing view connections whose view is gone.
  Removing a member from a server (kick/ban path) ends their view there.
- **Tokens**: a view token is the call token's claims plus
  `"view": "watch"|"ambient"`, 10-minute expiry. `paracord-transport` reads the
  claim (`MediaViewClaim`, `ConnectionMeta.view`); admission must route it to
  `MediaRoomManager::resolve_view_admission` (see the patch).

## Outside the scope (patch, verified, not applied)

`output/g5/g5-out-of-scope.patch` (gitignored; `git apply --check` passes on
the current tree; also at the session scratchpad). Applied to a copy of the
workspace it passes clippy `-D warnings` (`paracord-server`, `paracord-api`
with tests) and the tests listed below.

1. `crates/paracord-server/src/main.rs`: media admission (raw QUIC and
   WebTransport) routes tokens with a `view` claim to
   `relay.room_manager().resolve_view_admission(...)` and everything else to
   `resolve_active_media_room` as today; an unknown `view` value is refused.
   **Without it, a view session's connection is rejected** ("token no longer
   matches active voice state"). Note: another agent has uncommitted edits in
   this file (initial track state); the patch applies on top of them.
2. `crates/paracord-api/src/routes/realtime.rs`: SSE READY voice states and the
   realtime `voice_state_update` command event carry `mode` and
   `self_stream_started_at` (the SSE transport is the client's default, so
   without this goal 5 holds only on the WebSocket gateway).
3. `crates/paracord-api/src/routes/stage.rs`: stage promote/demote events carry
   the two fields.
4. New test `crates/paracord-api/tests/voice_listen_view_sse.rs` (SSE READY and
   the realtime mute event).

Also outside the file list and edited because the plan's
`routes/channel_features*` does not exist: the channel feature handlers live in
`routes/message_features.rs`; only `features_to_json`, the PATCH body and its
validation changed.

## Files

Server (in scope): `crates/paracord-models/src/{voice.rs, gateway.rs, intents.rs}`;
`crates/paracord-db/src/{voice_states.rs, channel_features.rs}`,
`crates/paracord-db/migrations{,_pg}/20260929000001_voice_listen_mode.sql`;
`crates/paracord-transport/src/connection.rs` (claim only);
`crates/paracord-relay/src/{participant.rs, room.rs, relay.rs, availability_bounds_tests.rs}`;
`crates/paracord-contracts/src/{voice.rs, lib.rs}`;
`crates/paracord-api/src/routes/voice.rs`, `routes/message_features.rs`
(features only), `src/lib.rs` (route lines);
`crates/paracord-ws/src/handler.rs` (READY fields, and the op-4 flag-update
event, which is a `VOICE_STATE_UPDATE` and so had to carry them);
`crates/paracord-api/tests/voice_listen_view.rs` (new).
Contracts/client: `contracts/api-contracts.json`,
`client/src/api/generated/{VoiceStateSnapshot, UpdateVoiceModeRequest,
VoiceModeResponse, StartVoiceViewRequest, VoiceViewSession, VoiceWatchers}.ts`
(new), `validators.js`, `validators.d.ts` (regenerated; no hand-written client code).

## Commands

| Command | Result |
|---|---|
| `pc-cargo.sh check --workspace --tests` | pass |
| `cargo fmt --all -- --check` | pass |
| `pc-cargo.sh clippy -p paracord-{api,db,ws,relay,transport,models,contracts} --tests -- -D warnings` | pass |
| `pc-cargo.sh clippy -p paracord-server -p paracord-core -p paracord-media-dev -- -D warnings` | pass |
| `pc-cargo.sh test -p paracord-{api,db,ws,relay,transport,models,contracts}` (SQLite, all suites incl. existing voice/relay) | 1331 passed, 0 failed |
| `… --test voice_listen_view` (SQLite) | 9/9 |
| relay unit tests (`--lib`) | 137/137, 19 new (10 room: view admission, counts, dirty signaling, one view per account, layer-0 pin, viewer cap, in-place publish flip; 2 participant; 7 relay: call+view slots, watch-only fan-out, ambient keyframes-only and 1 fps cap, frame gate, viewer control plane, roster scoping, idle sweep). Plus 1 new test each in transport (view claim), contracts, models |
| PostgreSQL 16 (throwaway `postgres:16-alpine`, `PARACORD_TEST_POSTGRES_URL`): `voice_listen_view` 9/9, `postgres_route_smoke` 2/2, `voice_routes` 11/11, `voice_session_ownership` 12/12, `coverage_gap_routes` 32/32, `realtime_voice_receipts` 2/2, `security_authz_scope_regressions` 7/7, `soundboard_routes` 12/12, `voice_speaking` 11/11, `voice_transport_diagnostics` 6/6, `contract_wire_shapes` 10/10 | pass (container removed) |
| patched copy: `voice_listen_view_sse` 1/1, `voice_listen_view`, `voice_session_ownership`, `voice_routes`, `realtime_voice_receipts`, server `media_room` tests 3/3 | pass |
| `export-contracts --check contracts/api-contracts.json` | pass |
| `npm run contracts:check` | pass (35 types) |

`cargo test --workspace` as a whole was not run (the touched crates' suites
were). No live run against a real instance: that needs the admission patch and
the client (WP-G6).

## For WP-G6

- Pass `mode` on every join **and recover** (absent means joined).
- A view token's connection is a separate media session (same endpoint, its own
  E2EE call key). The publisher learns a viewer from `session_participant_join`
  like any peer; tell viewers apart by the absence of a voice state in that
  channel (the relay roster has no marker; adding one needs
  `paracord-transport/src/control.rs`, outside this package). Do not rotate
  voice keys on a viewer's join/leave: the relay never gives viewers the voice
  key anyway.
- Watch: subscribe to the streamer's `screen` and `screen-audio` tracks only;
  ambient: `screen` only (the relay pins layer 0 and sends only keyframes, ≤1 fps).
- A superseded view connection closes with reason "superseded by a newer media
  connection"; an ended one with "view session ended". Do not auto-retry on
  either (a second device's view replaces the first's: one view per account).
- A new view must connect within ~20 s, and a dropped one reconnect within
  ~20 s, or it is retired (POST again).
- Going to `listen` via `/mode` clears the share and camera on the server; the
  client should unpublish them first.
- Fetch `GET …/watchers` when opening a stage; then follow `VOICE_WATCHERS_UPDATE`.

## Unresolved / known gaps

- The admission, SSE and stage changes above (patch).
- Soundboard (`routes/soundboard.rs`) still lets a listener play sounds, and
  `voice_speaking` accepts a listener's speaking edges; both only check the
  voice state's channel. Out of scope; listeners' clients never send either.
- `OP_MEDIA_CONNECT` (legacy WS opcode, unused by the client) still admits a
  publishing participant without checking SPEAK, stage suppression or listen
  mode (pre-existing).
- The WS op-4 event still hard-codes `suppress: false` (pre-existing).
- A view is not re-checked when the viewer loses VIEW_CHANNEL mid-view (same as
  calls today); kick/ban does end it.
- LiveKit: listen works through the join grant and `/mode` through
  `set_participant_can_publish`, but only native media has view sessions.
- Concurrency note: during this package other agents committed in the tree; one
  build ran on briefly reverted sources, and my Python edits had normalized
  three CRLF files (`paracord-models/src/{gateway,intents,voice}.rs`) to LF.
  Both were fixed (CRLF restored; sources touched and rebuilt).
