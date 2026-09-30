# WP-G6 checkpoint: client media sessions

Status: done in scope, not committed. Branch `design/glass`. Everything the pill
(G12), room light (G8) and stage (G14) need from media is in `voiceStore`, both
engines and the desktop app's native session layer. It was proven live from
Sean's client against the real Lounge call: 25 of 25 checks passed. The gaps
are listed at the end, and none of them is hidden behind a fallback.

## The API other packages call

Everything is on `useVoiceStore` (`client/src/stores/voiceStore.ts`) unless a
path is named.

### State

| Field | Meaning |
|---|---|
| `callMode: 'joined' \| 'listen' \| null` | How this client takes part in its call. Null when there is no call. |
| `modeSwitching: boolean` | True while `joinFromListen` is switching the call in place. |
| `modeError: string \| null` | Why the last listen-to-joined switch failed. The call stays as it was. |
| `connectionErrorCode: 'LISTEN_IN_DISABLED' \| null` | Set beside `connectionError` when a listen is refused because the channel turned listening in off. |
| `watchView: MediaViewState \| null` | The watched stream. Null when nothing is being watched. |
| `ambientView: MediaViewState \| null` | The room light's view. Null when none was asked for. |
| `watchers` | Watcher counts, kept per account and channel. Read them with `selectWatcherCount`. |
| `participants` / `channelParticipants` | Voice states now carry `mode` and `self_stream_started_at` exactly as the server sent them. |
| `selfMute` | While listening, this is the mute **preference** the upgrade will apply (the pill's mute circle). The engine sends nothing either way. |

`MediaViewState` (`stores/voice/viewSessions.ts`):

```ts
{ id; kind: 'watch' | 'ambient'; scope: AccountScope; guildId; channelId; streamerId;
  route: 'session' | 'call' | 'watch' | null;   // own connection, the call, (ambient) the watch
  phase: 'starting' | 'connecting' | 'live' | 'paused' | 'blocked' | 'ended' | 'failed';
  engine: MediaEngine | null;                    // what carries it NOW: subscribe to this one
  sessionId: string | null;                      // the view session's receipt
  endReason: 'superseded' | 'ended' | 'deadline' | 'failed' | null;
  pauseReason: 'hidden' | 'server-not-current' | null;
  error: string | null }                         // the server's or the transport's own words
```

### Actions

| Action | Behavior |
|---|---|
| `listen(channelId, guildId)` | Joins receive-only (`?mode=listen`). Never opens the microphone and never sends. Everyone sees "Listening in". A DM is refused. So is LiveKit: listening in exists only on the native relay. On 403 `LISTEN_IN_DISABLED` the call closes with that code and the server's sentence, and the listen is **never** turned into a join. |
| `joinFromListen()` | The in-place upgrade: `POST /mode joined` on the same receipt, then `engine.startMicrophone()` on the same connection (no reconnect). The mute preference applies. If the microphone cannot open, the server is switched back to `listen` and `modeError` explains. `joinChannel` on the channel being listened to does the same thing. |
| `leaveChannel()` | Unchanged. It works for listen too. |
| `startWatch({ serverId?, guildId, channelId, streamerId })` | Watch = the stream's video **and its own audio**, never the voices, and it is counted. Outside that call it is a separate view session on its own connection, beside any call. Inside it, the watch rides the call. It resolves when live and rejects on failure. The same target again returns the running watch. Another target replaces it. |
| `stopWatch()` | Scoped `DELETE /view?session_id=`, which is the view's own receipt or the call's. It never leaves the call. |
| `startAmbient(target)` / `stopAmbient()` | Layer 0, keyframes, at most 1 fps, no audio, never counted. One per client. The same target again is a no-op. It is closed while the window is hidden or its instance and guild are not the current ones, and a fresh view reopens when that changes back. |
| `setWatchVolume(gain)` | Gain (0..2) for the watched stream's own audio. |
| `fetchWatchers({ serverId?, channelId })` | Loads the counts now (call it when a stage opens). `VOICE_WATCHERS_UPDATE` keeps them current after that. |
| `handleWatchersUpdate(payload, scope)` | The gateway entry point (dispatch calls it). |

`serverId` is the instance (`AccountScope.serverId`). When it is omitted, the view
uses the instance active at call time. See "StageTarget" below.

### Selectors and helpers

- `selectWatcherCount(state, scope, channelId, streamerId)`, exported from `voiceStore`, gives "2 watching".
- `stores/voice/selectors.ts`: `isListeningIn(vs)`, `streamStartedAt(vs)`, `liveMinutes(vs, nowMs)` ("LIVE 42 MIN"), and `listenersOf(members)`. Every value comes from the server. None is inferred.
- `stores/voice/viewFrames.ts`: `subscribeViewFrames('watch' | 'ambient', onFrame, { fps?, onRoute? })` delivers `ImageBitmap`s, which the subscriber must close. The rate is capped at **1 Hz for ambient** and **4 Hz for watch**. The tap follows the view across engines: when the call is joined or left, the watch moves between the session and the call, and the tap moves with it.
- `lib/media/roomFrameTap.ts`: `tapEngineFrames(engine, userId, 'screen' | 'camera', onFrame, fps)` is the same sampler for any engine, for example a call's camera. `MAX_VIEW_SAMPLE_FPS = 4` and `AMBIENT_SAMPLE_MAX_FPS = 1`.
- `VIEW_CONNECT_DEADLINE_MS = 20_000`.

### How to use it

- **G12 (pill).** Not joined: Listen = `listen`, Join = `joinChannel` (which upgrades in place when listening), Watch = `glassStore.openStage` plus `startWatch`. Show `connectionErrorCode === 'LISTEN_IN_DISABLED'` as it is. The mute circle is `toggleMute`, which works before and during a listen as a preference. Build the roster from `participants` plus `isListeningIn`. The 256×144 preview is a surface on `ambientView.engine` or `watchView.engine`, or `subscribeViewFrames`.
- **G14 (stage).** Render with `watchView.engine.subscribeVideo(streamerId, canvas, onFrame, { preferredTrackId: 'screen' })`, and subscribe again whenever `watchView.engine` changes. Do **not** subscribe the stream's audio: the store owns it (`setWatchVolume` for the volume). Treat `phase: 'connecting'` as "not yet". Never clear a watch on a timer while it connects: the Lantern stage's Bug 2 cause 2 (`glass-fix-rejoin.md`) must not come back. Show `ended` and `failed` with their reason and offer Watch again, because the store never retries. Use `fetchWatchers` on open, then `selectWatcherCount`.
- **G8 (room light).** Call `startAmbient(busiest live stream of the current server)`, `stopAmbient()` on Home, DMs, or a server with nothing live, and `subscribeViewFrames('ambient', …)`. `ambientView.phase` says why no frames are arriving: `paused`, `blocked` (a watch of another stream holds the account's one view), `ended`, or `failed`. On the desktop app's native-surface route the tap reports `onRoute('native-surface')` and delivers nothing. G8's Rust sampler is the answer there.

### StageTarget (G7's open question): resolved

Snowflakes are per instance, so a view needs the instance that carries it: its
API, its relay, its account. The view API takes `serverId` for that reason. The
exact change the orchestrator should make (glassStore is outside my scope, so
it is not edited):

```diff
 // client/src/stores/glassStore.ts
 export interface StageTarget {
+  /** The instance (AccountScope.serverId) whose stream this is. */
+  serverId: string;
   guildId: string;
   channelId: string;
   streamerId: string;
 }
```

In `client/src/components/glass/places/PlacesPanel.tsx:330`, pass the current
instance id, which is `activeServerId ?? LOCAL_SERVER_ID` (the same value
`captureOperationContext` uses). Update the tests that build `LOUNGE` targets
(`glassStore.test.ts`, `AppShell.test.tsx`). G14 then passes `stage` straight to
`startWatch`. Until then, an omitted `serverId` means "the active instance", and
that is deterministic.

## The rules, and where each is enforced

- **One view per account** (server). Watch wins over ambient. Ambient then rides the watch (same stream), rides the call (in that channel, with no request), or is `blocked`. When the watch stops, ambient reopens by itself: that is a precedence change, not a retry.
- **A view in a channel whose call this client holds rides the call.** A watch still `POST`s, because the server counts it through the membership (`via_membership`). An ambient view does not `POST`.
- **Joining the watched call** moves the watch onto the call (the relay carries it over and then ends the view session, which the store treats as expected). **Leaving** moves it back onto a session of its own, but only once the leave request has been answered. Before that, the server would still say `via_membership`. Watching never joins and stopping never leaves.
- **No automatic retry.** A view the relay superseded or ended, one past the 20 s deadline, one the server refused, or one that dropped stays down with `endReason` and `error` set. The only exception is a network drop, which the transport dials back inside its 15 s window, inside the relay's 20 s grace. Details:
  - Chromium does not surface the relay's close reason for a QUIC close (it reports "Connection lost."). The browser view transport therefore treats **a refused readmission** as terminal: the connection opens, the auth is never acknowledged, and the relay no longer admits that view (`setTerminalCloseReasons(…, authRefusalReason)`). Measured live: a replaced watch settles as `ended` in 0.4 s. Before this, the transport spent its whole window being refused once a second. `superseded` is reported only when a close reason does arrive (native QUIC and tests). A browser client sees `ended` for both.
- **Render route per track**, decided once when the track's subscription starts. On the browser it is always `frames`. On the desktop it is `frames` (WebCodecs passthrough) or `native-surface`. It never switches mid-stream. Taps ride the existing subscription. With no surface they run a headless one on the lowest layer and never change a surface's layer.
- **Peer roles** (publisher side). The relay roster has no viewer marker (G5). The store resolves each peer: a peer with a voice state in the call's channel is a member, and one never seen with one is a viewer. `CallSession.seenMembers` only grows, so "member" wins, because a member's leave must rotate the voice key. Viewers are never reported as participants, and a viewer joining or leaving does not rotate the voice key. A viewer is wrapped the stream key, and the voice key too, which the relay withholds from viewers. That second wrap keeps a member whose voice state arrives late from being left unable to hear. DM calls have no viewers.

## Files

Client (all in scope):

- `src/stores/voiceStore.ts`: modes, `startCall` and `upgradeFromListen`, the view host, the watcher state, listen gating (share, camera and microphone switch), the peer-role resolver, and `LISTEN_IN_DISABLED`.
- `src/stores/voice/viewSessions.ts` (new): watch and ambient lifecycles, reconcile, deadline, call carry-over.
- `src/stores/voice/{watchers,selectors,viewFrames,errors}.ts` (new). `src/stores/voice/callSession.ts` gains `mode`, `seenMembers` and `membershipReleased`.
- `src/lib/media/mediaEngine.ts`: adds `MediaSessionRole` (`call` / `listen` / `view` in `MediaSessionContext.role`), `PeerRole`, `startMicrophone`, `setPeerRoleResolver`, `tapVideoFrames`, and `VideoTapRoute`.
- `src/lib/media/browserMediaEngine.ts`: roles (a listener never calls `getUserMedia`; a view holds no voices and announces nothing), `startMicrophone`, viewer peers, frame-tap sinks (no canvas), and a `track_publish` registration for taps only.
- `src/lib/media/tauriMediaEngine.ts`: passes `role` to `start_voice_session`, adds `startMicrophone` (through `voice_switch_input_device` on the same native session), viewer filtering, and taps (on the existing subscription, or a headless one), with a tap hook in `startPulledEncodedVideoSubscription`.
- `src/lib/media/transport/webTransport.ts`: keeps the close reason, and adds terminal close reasons and terminal refused readmission.
- `src/lib/media/engineShared.ts`: `parseViewKindFromToken` and `isTerminalViewCloseReason`.
- `src/lib/media/roomFrameTap.ts`: `tapEngineFrames`. The existing `createRoomFrameTap` is unchanged.
- `src/api/voice.ts`: `join(…, mode)` sends the mode on every guild join, plus `setMode`, `startView`, `stopView` (always scoped), `watchers`, `voiceApi.getListenIn` / `setListenIn`, and the error helpers.
- `src/gateway/events.ts` and `dispatch.ts`: `VOICE_WATCHERS_UPDATE` (strictly parsed; a malformed one is dropped with a warning).
- `src/types/voice.types.ts`: `VoiceMode`, `mode` and `self_stream_started_at`.
- `src/components/guild/ChannelManager.tsx`: one "Listening in" switch on voice rows. It is read from the server and stays disabled until the value arrives, a failed change reverts with a toast, and it says so when the value cannot be read.
- Tests: `stores/voiceStore.media.test.ts` (29), `stores/voice/{watchers,selectors,viewFrames}.test.ts`, `lib/media/browserMediaEngine.roles.test.ts` (9), `lib/media/tauriMediaEngine.roles.test.ts` (6), plus additions to `lib/media/transport/webTransport.lifecycle.test.ts`, `lib/media/roomFrameTap.test.ts`, `gateway/dispatch.test.ts` (3) and `components/guild/ChannelManager.test.tsx` (3), and a fixture fix in `stores/voiceStore.nativeBrowserJoin.test.ts`.

Desktop (`client/src-tauri/src/native_media/`, session plumbing only, **no new commands**, so `lib.rs` is untouched):

- `mod.rs`: `MediaState.view`, a second slot beside the call with its own ownership and transition lock; `slot_for(owner)`.
- `session.rs`: `SessionRole` (Call, Listen, Watch, Ambient), resolved against the token's `view` claim. A mismatch is refused. The microphone is captured only for `Call`, and nothing plays for `Ambient`. `mic_capture_generation`. Per-session `video_track_keys` and `release_video_state`, so ending one session no longer clears the other's decoders and surfaces.
- `commands.rs`: `start_voice_session(…, role)` sends a view to the view slot (receive tasks only). `stop_voice_session` is slot-aware and cancels in both slots when a stop overtakes its start. The receive-side commands (subscriptions, keys, keyframes, visibility, tracks, diagnostics, volume) resolve the owner's slot. `voice_switch_input_device` on a `Listen` session is the upgrade.
- `events.rs`: records the track keys the session knows. The microphone-silence check runs only against a capture that exists, and starts again for each new capture.
- `video_pipeline.rs`: `clear_stream_video_state_for_tracks`. `call_owner.rs`: `knows`. `native_render/mod.rs`: attach resolves the slot.
- Rust tests: role resolution, capture and playback per role, slot ownership, and scoped teardown.

Scripts: `client/scripts/glass-scene/{ui,shots}.mjs` and `glass-scene.mjs` drop the
rejoin workarounds (the retry loop, the 15 s pause, the three-attempt 04 and the
"refused" notes). A refused join is now reported and fails the run.
`client/scripts/glass-scene/media-probe.mjs` (new) is the live proof below.

## Commands

| Command | Result |
|---|---|
| `npx vitest run src/lib/media src/stores src/lib/crypto src/gateway src/hooks src/components/guild/ChannelManager.test.tsx` | 96 files, 1034 tests, all pass (baseline before this package: 41 files and 471 tests in media/voice/crypto/gateway, all still passing) |
| `npx vitest run --exclude '**/DailyWordView.test.tsx'` (whole client) | 384 of 385 files pass. The one failure is `pages/FriendsPage.test.tsx` (2 tests, "who is here" presence), which belongs to WP-G19's work in progress and touches nothing here. An earlier run during this package failed TopBar, ConversationPane and GuildHomePage tests from other packages' WIP, and those passed again later without changes from me. |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm run test:tokens`, `npm run test:motion-lint` | pass |
| `npx eslint` on every touched source and test file | 0 errors. The 2 warnings left in `ChannelManager.tsx` (followers effects) are older than this package; mine was fixed. |
| `pc-cargo.sh check --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on) | pass |
| `pc-cargo.sh clippy --manifest-path client/src-tauri/Cargo.toml --all-targets -- -D warnings` | pass |
| `pc-cargo.sh test --manifest-path client/src-tauri/Cargo.toml --all-targets` | 114 passed, 2 ignored |
| `cargo fmt -- --check` (client/src-tauri) | pass |

## Live proof (2026-09-30, from Sean's client)

Setup: `npm run build`, `touch embedded_ui.rs`, a release `paracord-server` built
with `pc-cargo.sh` (vpx untouched), and the served `assets/index-CkzEvpDe.js`
matched `client/dist`. Then `live-env.mjs --port 18520` with its data in the
scratchpad, and `glass-scene.mjs --shot all --hold` (01, 02, 04 and 07 were shot;
04 joined on its first attempt, with no retry loop any more). The cast ran the
embedded build, so Vincent as publisher ran this package's code. Sean and Luke
ran the app from a Vite dev server proxied to the instance, because no Glass
control for listen or watch exists yet. The probe imports the very store module
the app runs, and checks the store, the engine and the relay's own counters.

`node client/scripts/glass-scene/media-probe.mjs --base http://127.0.0.1:18520 --scene …/scene.json`,
final run: **25 of 25 passed** (log in `output/design-reference/glass-build/g6/media-probe.log`):

- **Listen.** It connects in listen mode with `getUserMedia(audio)` called 0 times. It hears Brendan: his audio arrives and is decoded, and he shows as speaking. The relay counted 0 audio and 0 video datagrams from Sean. Luke's store shows Sean with `mode: listen`.
- **Upgrade.** The engine object is the same and there are 0 new WebTransport connections. `getUserMedia` was called once, only now. The relay then counted 201 audio datagrams from Sean in 4 s, on the same receipt (one connection). Luke sees `joined`.
- **Watch without joining.** The watch is `live` on `route: session`, not in the call, on one new connection. Vincent's frames decode (20 sampled frames in 6 s at ≤4 Hz, 320×180: a tap alone takes the lowest layer). There were 0 voice decoders and 0 voice packets. `GET /watchers` shows 1, and Luke's store shows 1 through `VOICE_WATCHERS_UPDATE`. Sean does not appear in the call's relay rows.
- **Ambient.** It is live on a session of its own. 7 frames arrived in 12 s, at **0.51 fps** with a smallest gap of 1.8 s (the relay sends keyframes only). It is never counted (`streams: []`). Hiding the window moves it to `paused/hidden` with no engine.
- **Superseded.** A second "device" of Sean's (`POST /view` from Node) replaced the watch. The watch settled as `ended` in 0.4 s, with 0 new connections in the next 8 s.
- **Carry-over.** Sean watched, then joined Lounge. The watch moved onto the call (`route: call`, the call's engine), with frames before (10 in 3 s) and during (13 in 4 s), still counted once. After Leave it went back to `route: session` (13 frames in 4 s, count 1).

The held call stayed healthy through seven probe runs of viewers joining and
leaving Vincent's roster, at about 200 video packets per second per publisher,
with 3 connected and no key failures. `ChannelManager` in server settings shows
the "Listening in" switch on the Lounge row (screenshots
`channel-manager-listen-in*.png`). Turning it off and on again round-trips to the
server. All of it was stopped afterwards: the holder by SIGINT (it left the call),
then live-env, and no Vite, browser or server of mine is left running.

Two of the seven probe runs were cut short when the Vite dev server reloaded the
test pages partway through (the harness, not the product). The run that added
navigation logging had no reload, and the final two runs passed completely.

## Not done, gaps, and follow-ups

1. **Native publisher key rotation on viewers.** The desktop app's Rust session rotates its audio and track keys on every roster change (`events.rs`), including a viewer's join and leave. The JS side filters viewers out of the call, but it cannot tell Rust not to rotate without a new command. Fix options: a `viewer` marker on `SessionParticipant` in `paracord-transport/src/control.rs` (G5's crate, the cleanest), or a `media_set_peer_roles` command, which needs one `lib.rs` line. The browser publisher is correct.
2. **The browser engine uses one sender key for the voice and every track** (pre-existing). A viewer that receives the stream key therefore holds key material that would open the publisher's voice if a relay forwarded it. The relay never does. Per-track keys, as the native side already has, would close this.
3. **Relay close reason for WebTransport.** `ConnectionHandle::close` closes the QUIC connection, and Chromium reports only "Connection lost.". Closing the WebTransport session with its reason would let a browser tell `superseded` from `ended`. The refused-readmission rule covers the behavior; only the label is coarser.
4. **The desktop app is not verified live.** No Tauri or WebKitGTK run was made; that is WP-G23. The native changes are compiled, clippy-clean and unit-tested. A tap on a track the desktop app shows on the native-surface route reports `native-surface` and delivers no frames (by design; G8's Rust sampler).
5. **One subscription per track on the desktop app** (pre-existing). A second `subscribeVideo` for the same track replaces the first. Taps survive it, but two surfaces still fight: for example the stage and a pill preview of the same stream.
6. **"Current server" for ambient** uses `guildStore.selectedGuild`, which is not cleared on Home. G8 should call `stopAmbient()` on Home and DMs.
7. `glassStore.StageTarget` needs `serverId` (the diff above). This is for the orchestrator.
8. The glass-scene `03-listen` shot is still pending G12 (no control to press). The probe covers the behavior.
9. The Lantern stage (`VoiceStageChannel`) still watches only inside a joined call through `setWatchedStreamer`. G14 replaces it with `startWatch`.
10. `client/dist` and the embedded server were built before the last client change (the refused-readmission rule in `webTransport.ts`). The probe served Sean's client from source, so that rule is what the live run exercised. Rebuild before the next live run.
