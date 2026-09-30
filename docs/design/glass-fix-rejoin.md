# Glass fix: rejoining a running call, and the watched share that closed itself

The two product bugs the live scene driver found (`glass-g3-checkpoint.md`,
findings 1 and 2). Both are fixed. The evidence below comes from real instances,
real browsers and the real relay. Nothing was mocked.

## Bug 1: a rejoin into a running call was refused

### Symptom

Hold the Lounge call (Vincent sharing, Brendan on camera, Nick muted). Sean's
first join works. Every later join by the same account into the same call fails
at once with "Media encryption could not verify a participant: Someone in this
call has not published a media key, so their audio cannot be encrypted." This
also happened after waiting, in a fresh page, and when Vincent rejoined while the
others stayed.

### Root cause (server: a stored key replayed before the rejoiner's roster)

The relay stores every wrapped track key a publisher announces, keyed by
recipient **user id** (`MediaParticipant::published_track_keys`), so that it can
hand one to a subscriber later. Each envelope is sealed to the recipient's
**call key**, which is minted fresh for every join (`MediaKeyring.create()`).

When a media connection came up, `crates/paracord-server/src/main.rs` (both the
QUIC and the WebTransport accept paths) spawned
`relay.send_initial_track_state(&handle)` right away. At that moment the new
connection has not sent `SessionJoin`, so its call key is not yet published and
its roster has not been sent. For each published track, that call sent
`TrackPublish` and, if a key was stored for this user id, a `StreamKeyDeliver`.

- **First join:** nothing is stored for the account, so no key goes out. The
  relay sends `RequestStreamKey` to the publisher, which ignores it because it
  does not know the newcomer yet.
- **Every later join:** the envelopes from the previous join are still stored,
  sealed to the call key that the account's previous page destroyed. They reach
  the rejoining page **before its own `session_join` and before `session_state`**.
  The page has no peer keys yet, so `MediaKeyring.unwrapSenderKey` threw from
  `requirePeer`, and `failKeyExchange` ended the call. Even with the roster in
  place, the envelope could not have opened. It was sealed to a call key this
  page never had.

The relay's `SessionJoin` handler already did the right thing:
`forget_track_keys_for_recipient` and then `send_initial_track_state`. The
connect-time call raced ahead of it with stale envelopes. The failure repeated
forever because each refused attempt got as far as `session_join`, so the
publishers wrapped fresh keys to that attempt's call key and the relay stored
them. The next attempt, with yet another call key, then got those.

This is the wire log of Sean's second join on the pre-fix build, taken from the
page's parsed and sent media control messages (`rejoin-probe.mjs`, below). Times
are from page load.

```
round 2 (rejoin into the same call):
  +1409ms in track_publish by Brendan
  +1411ms in stream_key_deliver from Brendan epoch 3      <- before this page has even sent session_join
  => "Media encryption could not verify a participant: Someone in this call has not published a media key…"
round 1 (first join), for comparison:
  +2031ms in track_publish by Brendan / +2033ms by Vincent  (no key: nothing stored yet)
  +2034ms out session_join my key 82222e37
  +2066ms in session_state …
```

Vincent's rejoin after `kill -USR2` fails for the same reason: Brendan's camera
key for Vincent was stored under Vincent's user id.

### Fix

1. **Server** (`crates/paracord-server/src/main.rs`): the connect-time
   `send_initial_track_state` is removed from both accept paths. The relay sends
   track state only from the `SessionJoin` handler, after it has published the
   new call key, sent the roster and dropped the envelopes sealed to earlier call
   keys. This loses nothing. Before `SessionJoin`, no stored envelope can be
   sealed to the connection's current call key, because that key has not been
   published yet. So the connect-time delivery was always empty or stale, and
   its `TrackPublish` is sent again after `SessionJoin`. Both the browser engine
   and the native desktop session send `SessionJoin` as their first control
   message. A G5 view session is allowed to send it (`viewer_may_send`) and has to,
   because its publisher wraps the stream key to the call key that `SessionJoin`
   publishes.

2. **Client, key exchange hardening** (the same class of problem, found while
   fixing this). Every media control message travels on its own QUIC stream, so
   the page can read them in a different order from the one the relay sent.
   - `MediaKeyring.unwrapSenderKey` now **waits for the roster to introduce the
     sender** (at most `PEER_INTRODUCTION_TIMEOUT_MS`, 10s, with at most 256 keys
     waiting at once), instead of failing at once. Two orders are affected: a
     newcomer's `key_deliver` read before its `session_participant_join`, and a
     rejoining peer's new key read between its old call's leave and its new
     call's join. A key from someone the roster never introduces is refused
     loudly when the wait runs out. A key from someone who left and did not come
     back resolves to `null` ("nothing to apply"). Someone introduced without a
     call key is refused at once. Disposing the call ends any wait.
   - `BrowserMediaEngine.buildEncryptedSenderKeyPayloads` wraps only for
     recipients who are **still on the roster** when the wrapping starts. Before
     this, if a leave landed while an announce was in flight, the whole call
     failed: the departed peer's key had already been removed, and wrapping for
     them threw. Anyone still in the call who has no call key still fails loudly.
   - The browser's voice-key path (`applyDeliveredAudioKey`) used to swallow an
     unwrap failure (`.catch(() => {})`), which left that person silent with no
     error. It now ends the call through `failKeyExchange`, as the stream-key
     path and the Tauri engine already did.
   - An envelope that fails authentication now says so: "A media key sent to this
     device could not be opened: it was not sealed to this call's keys." Before,
     it surfaced as WebCrypto's generic `OperationError`.

### Why the scheme is not weakened

- Nothing is accepted without verification. A waiting key is opened later, under
  the same AES-GCM envelope and against the sender's call key as introduced by
  the roster. A key sealed to any other key pair still fails authentication. The
  tests cover a key sealed to the rejoiner's previous call key and an
  introduction that names a different call key.
- Keys still go only to roster members. The relay still refuses to announce to
  non-members. The client wraps only for peers that are on the roster and have a
  call key, and one that has no key still fails the call.
- A stored envelope is never replayed to a call key that cannot open it. The
  relay's `SessionJoin` path drops the stale envelopes, and the rejoiner gets
  fresh ones: the publishers rotate on `session_participant_join` and announce to
  the rejoiner's new key, and `RequestStreamKey` covers the rest.
- A `null` result for a departed sender drops a key for someone who is no longer
  in the call, so there is nothing of theirs to decrypt. It is not a way around a
  refusal.

### Tests

- `client/src/lib/media/mediaKeyring.test.ts`, 8 new tests: a rejoiner cannot
  open a key sealed to its previous call key; a key arriving before its
  sender's introduction is opened once the sender is introduced; a rejoining
  peer's key that overtakes its leave is opened; a sender never introduced is
  refused after the wait; a departed sender's key resolves to `null`; an
  introduction without a key is refused; a mismatched introduction fails
  authentication; dispose ends waiting keys.
- `client/src/lib/media/browserMediaEngine.keyExchange.test.ts` (new): the engine
  receives control messages in the orders a join and a rejoin produce. A
  newcomer's key read before its join is applied. A rejoiner's key read between
  leave and join is applied. A rejoiner's join that overtakes its old leave keeps
  the new call (this already passed before the fix and stays as a guard). A leave
  during an announce does not fail the call. A key sealed to a call key the page
  does not hold still fails the call loudly.
- Against the original sources, 11 of the 13 new tests fail. The two that pass
  are that guard and "refused at once when introduced without a key", which the
  old code also did. With the fix, all 13 pass.
- The primary cause is server ordering on a live connection, and the accept
  loop in `main.rs` has no unit seam. Its before and after evidence is the live
  run below. A relay-level regression test belongs to G5's crate (see
  "For G5").

Suites: `src/lib/media`, `src/stores/voice*`, `src/lib/crypto`, 40 files and 415
tests, all pass. Whole client: 349 of 354 files pass. The 5 that fail are
`AppShell`, `DMPage`, `home`, `TextRoom` and `TextChannelView`, which belong to
the shell and theme work in progress (`bg-light-white` and similar class
expectations). They fail the same way with my changes reverted. `tsc --noEmit`
is clean for the whole project. ESLint is clean on every file I changed.
`cargo clippy -p paracord-server -- -D warnings` is clean.
`cargo test -p paracord-server` passes (69 tests). `rustfmt --check` on `main.rs`
passes.

### Live evidence

Setup: a separate instance on `:18520` with its data in the scratchpad (the
`live-env` environment, a different port and data directory), the scene seeded
fresh, and the call held by `glass-scene.mjs --out <scratch>`. Final run:
client built, `embedded_ui.rs` touched, release server built with `pc-cargo.sh`
(vpx untouched), and the served bundle hash checked against `client/dist`. It
ran **on top of G5's server changes in the tree plus
`output/g5/g5-out-of-scope.patch`, applied in a scratch copy** (`git apply
--check` passes alongside this `main.rs` change).

- Before the fix (the G3 binary, same scene): round 1 PASS, round 2 FAIL with
  the message above. See the wire log.
- After the fix, all against **one** held call:
  - `node client/scripts/glass-scene.mjs --shot 04-side-by-side`, twice: both
    runs join, and both find Vincent's scene on screen (2465 px teal and
    12600 px amber, then 2395 px teal and 3736 px amber). The "…and 3s later it
    is gone again" line no longer appears (Bug 2).
  - `rejoin-probe.mjs`: Sean joins through the lobby's Watch, the check requires
    Vincent's scene on screen and the call still connected 8s later, and then he
    leaves. Four modes, 3 rounds each, 12 of 12 pass. The modes are the same page,
    a fresh page each round, a tab closed mid-call without leaving and then an
    immediate rejoin from a new page (the relay still holds the old seat), and
    Leave followed immediately by Join.
  - `kill -USR2` on the holder: Vincent, Brendan and Nick each leave and rejoin
    in fresh browsers, while the others stay in the call. Every join succeeds on
    its first attempt, and the relay then shows about 200 video packets/s from
    Vincent and 194/s from Brendan. Sean then joins twice more and sees
    Vincent's re-published share (2 of 2 pass).
  - In total, Sean joined the same running call 17 times with no refusal (2
    driver runs, 12 probe rounds, 2 after the recycle and the watch probe). The
    peers stayed connected throughout. With the audio-key change, a peer that
    could not open Sean's key would have dropped out of the call.

Local evidence (gitignored), in `output/design-reference/glass-build/fix-rejoin/`:
`before-rejoin-probe.log`, `final-04-twice.log`, `final-rejoin-probes.log`,
`final-cast-recycle.log`, `final-after-recycle.log`, `04-rejoin-run{1,2}.png`,
and the probe scripts (`rejoin-probe.mjs`, `watch-probe.mjs`).

## Bug 2: a share opened through the lobby's Watch closed about 1s later

### Cause 1, in the voice store (fixed here, because the Glass stage reuses it)

`bindEngine` in `client/src/stores/voiceStore.ts` turned every media-engine
`onParticipantJoin` into a synthesized voice state with `self_stream: false`,
`self_video: false`, `self_mute: false`, no `session_id` and no `username`. It
then wrote that over whatever the gateway had said about the person. When you
join a call, your engine reports **everyone already in it** as joining
(`session_state`), so right after the join:

- `participants.get(vincent).self_stream` became `false`. On the native media
  path, `VoiceStageChannel` derives `activeStreamers` from `self_stream`, so
  Vincent stopped counting as streaming. The stage's 1.2 s auto-clear then
  called `setWatchedStreamer(null)`, the view fell back to the tile grid, and
  the tile's Watch disappeared with it.
- The username was lost, so the viewer read "Someone's screen".
- Nick's mute flag was cleared, so his tile stopped saying "muted". This is
  visible in the probe frames before the fix.

Fix: an engine join keeps the known voice state (it only makes sure of the
channel) and synthesizes a placeholder only for someone the gateway has not
reported yet. The next gateway update replaces the placeholder as before.
Tests in `client/src/stores/voiceStore.nativeBrowserJoin.test.ts`: the member's
gateway state (sharing, camera, mute, name, receipt) survives an engine join and
the watch stays set, which fails on the original store; an unknown member is
seated with a placeholder.

Live, from `watch-probe.mjs`, which samples the stage every 100 ms after Watch:

```
before:  +2285ms label=Someone's screen   +3419ms label=null (share gone, back to the grid)
after:   +2235ms label=vincent's screen   … still there at +8.5s (end of the sample)
```

The driver's 04 no longer reports the share going away. The kept frame (see
`04-rejoin-run2.png`) shows the share, Brendan "speaking" and "Nick · muted".

### Cause 2, in the Lantern stage UI (not fixed, for G14)

`VoiceStageChannel` also clears the watch on a timer while the join is still in
progress:

- The Watch handler calls `setWatchedStreamer(userId)` and then
  `joinChannel(...)`.
- Until the call is connected, the `activeStreamers` effect takes the
  `!room || !inSelectedVoiceChannel` branch and sets `[]`. The branch that reads
  `self_stream` from voice states runs only when `mediaEngine && inSelectedVoiceChannel`.
- The auto-clear effect (`if (!activeStreamerSet.has(watchedStreamerId))`, then
  `setTimeout(…, 1200)`) therefore starts its 1.2 s timer at the Watch click. The
  timer restarts whenever `participants` changes, because the branch sets a new
  `[]` each time.

In the scene the join connects in about 0.7 s, so the timer is canceled in time.
On any network where a join takes longer than 1.2 s, the watch is dropped before
the call exists. The G14 stage should derive "who is sharing" from voice states
whether or not this client is in the call, and must not auto-clear a watch while
`joining` is true.

## Changed files

- `crates/paracord-server/src/main.rs`: two hunks, in `handle_raw_quic_connection`
  (about line 4278) and `handle_webtransport_connection` (about line 4801). Each
  removes the spawned `send_initial_track_state` block and adds a comment. There
  are no other changes under `crates/`. G5's changes are untouched.
- `client/src/lib/media/mediaKeyring.ts`: waiting for the sender's introduction,
  the departed set, `UnwrappedSenderKey | null`, and clearer errors.
- `client/src/lib/media/browserMediaEngine.ts`: the roster filter before wrapping,
  the loud failure on an unopenable audio key, and handling of the `null` result.
- `client/src/lib/media/tauriMediaEngine.ts`: handling of the `null` result.
- `client/src/stores/voiceStore.ts`: `bindEngine` keeps known voice states.
- Tests: `client/src/lib/media/mediaKeyring.test.ts`,
  `client/src/lib/media/browserMediaEngine.keyExchange.test.ts` (new) and
  `client/src/stores/voiceStore.nativeBrowserJoin.test.ts`.

## For G5 (relay; not edited here)

- The relay stores wrapped track keys by recipient **user id**. They are really
  sealed to a recipient **session** (a call key). Key them by the recipient's
  session receipt, or drop them when that session ends (leave, retire,
  supersede). The same stale-envelope problem could then not return through any
  other path. With G5's view sessions, one account can hold a call key and a view
  key, and the relay should not let them share a slot.
- The comment on the `StreamKeyAnnounce` handler in `relay.rs` ("so
  `send_initial_track_state` can hand it over on connect") describes the
  behavior that was removed. Delivery now happens after `SessionJoin`.
- A relay regression test belongs next to `availability_bounds_tests.rs`:
  `send_initial_track_state` for a handle that has not sent `SessionJoin` must
  not deliver a stored key sealed for that user.

## Left open

- The Tauri engine has the same leave-during-announce race as the browser. Its
  recipient list comes from the native side (`media_list_session_participants`),
  while the call keys come from renderer events, so filtering there could skip a
  real member without saying so. It is not changed here. The desktop path does
  not share Bug 1, which the server fix covers for every client.
- Bug 2's cause 2 is for G14 (see above).
- `glass-scene`'s join retry, its "rejoin is refused" comments, and the G3
  checkpoint's finding 1 and its limitation line can now be updated by their
  owner.
