# WP-G6b checkpoint: viewer keys, the roster marker, close reasons

Status: done in scope, not committed. Branch `design/glass`. This package closes
G6's gaps 1 to 3 and G5's "a view is not re-checked" gap. A viewer is now never
given a key that opens the voices. Viewers never rotate the voice key, in the
browser or on the desktop. The relay marks every roster entry `member` or
`viewer`. A browser can now tell a superseded view from an ended one, and from a
revoked one. The browser work was proven live from Sean's and Luke's clients
against the held Lounge call. The desktop app was not run (see "Not done").

## What changed, in one paragraph each

**Separate keys per track (browser).** `BrowserMediaEngine` used one sender key
for the microphone, the camera, the screen and the screen's audio. A viewer
handed "the screen key" held the voice key's bytes. Each published track now has
its own `SenderKeyManager` (`trackSenders`, keyed `streamId:trackId`) with its own
key and its own epoch counter. `senderKeys` is now the voice key only, plus the
decrypt side for every peer. A track gets a fresh key when it starts capturing
(`freshLocalTrackKey`). A frame for a track without a key is refused, never sent
under another key. The desktop app already had separate keys per track.

**Who a key may reach (both engines).** `engineShared.keyRecipients`: the voice
key goes to members only. A track key goes to members, and to viewers only for
the viewable stream (`stream:<publisher>:screen`, video and its own audio). This
mirrors the relay's `ViewTarget::allows`. The camera never reaches a viewer. The
relay's own filter stays in place as a second layer.

**Rotation (both engines).**

| Roster change | Voice key | Camera key | Screen video + screen audio keys |
|---|---|---|---|
| A member arrives or leaves | rotates | rotates | rotates |
| A member turns into a viewer (left the call, now only watches) | rotates | rotates | rotates |
| A viewer leaves | kept | kept | rotates |
| A viewer arrives (or its view session is replaced by the same account's newer one) | kept | kept | kept; the viewer is sent the current keys |

"Leaving rotates what the leaver could open" holds for everyone. A viewer's
arrival does not rotate the stream key. That is a deliberate relaxation compared
with a member's arrival. The viewer's receipt already entitles it to that stream
as it is now, and G8's room light opens and closes ambient views as people move
between servers. Rotating on every arrival would freeze every watcher's picture
each time. The desktop now rotates each track under its own epoch
(`next_key_epoch`). Before, a track key was re-minted at the voice epoch, and a
track could not rotate without the voice.

**The roster marker (relay, transport, both engines).**
`SessionParticipant.kind: "member" | "viewer"` is set by the relay from the view
target it admitted (`roster_kind`), both in `session_state` and in
`session_participant_join`. Both engines read it. `setPeerRoleResolver`, the
store's inference from voice states and `CallSession.seenMembers` are gone.

**Desktop announcements.** The native session now decides what each roster
change rotates and what must be announced (`plan_session_state`, `plan_join`,
`plan_leave`). It rotates first. Then it emits the join or leave (now carrying
`kind`), followed by a new event, `media_announce_sender_keys { voice, tracks,
recipients }`, which the renderer wraps and sends. This also fixes an older
desktop bug: on a member's arrival the native side rotated every key, but the
renderer announced only to the newcomer. The other members were never sent the
desktop publisher's new keys, and its media stopped decrypting for them until
the next roster change.

**Close reasons (relay, transport, both clients).** `MediaCloseReason`:

| Reason | Code | Words (on the wire; clients match them) | When |
|---|---|---|---|
| Superseded | 4001 | `superseded by a newer media connection` | A newer connection took the slot, or `POST /view` replaced this account's view |
| Ended | 4002 | `view session ended` | Stopped, retired after its deadline, or carried over into a call |
| Revoked | 4003 | `media access revoked` | Kicked or banned (was `evicted`), or no longer allowed to view the channel |

A raw QUIC connection is closed with that code and those words. A WebTransport
session is now closed with a `CLOSE_WEBTRANSPORT_SESSION` capsule on its CONNECT
stream, and `WebTransport.closed` resolves with the code and the words. The
relay then waits up to 2 s for the browser to end its side before it closes the
connection (`WebTransportStreams::close_session`,
`WebTransportSession::closed`). The store's `MediaViewEndReason` gains
`revoked`. `parseRelayCloseReason` reads the code first, then the words. The
desktop session reports "Closed by the relay: <words>".

**Losing access mid-view (API).** The view sweep that already runs every 5 s
(`ensure_view_housekeeping`) now also calls `revoke_views_without_access`. It
recomputes the viewer's permissions through the permission cache, which every
role, overwrite and member change already invalidates. A view that has lost
VIEW_CHANNEL (either kind), lost CONNECT (a watch), or whose channel is gone is
ended, and its connection is closed as revoked. A database error leaves that
view for the next sweep rather than ending views on a passing fault. Worst-case
delay: one sweep. Live runs measured 0.2 to 5.1 s.

**An unchanged republish is now a no-op (both engines).** The relay repeats a
track's `TrackPublish` after every key announce for it. Each repeat made every
subscriber re-subscribe, so the relay replayed the stored key, and reset its
decoder, so the picture froze until the next keyframe. Viewer churn now causes
announces, so this got much more frequent. `samePublishedTrack` (`engineShared`)
leaves an identical repeat alone. This cut the longest frame gap Luke saw
across a rotation from 1513 ms to 104–668 ms.

**Smaller fixes.** `SenderKeyManager.currentKey()` reads the bytes and the epoch
together. The old announce read them on either side of an `await`, so a rotation
in between labeled one epoch's key with the next epoch's number.

**Coordinator's extra item (WP-G12's finding).** After a leave and a cold join,
the engine reports everyone before the call commits. The store's call
participants are empty at that point, so `bindEngine` seated nameless
placeholders over the server's voice states ("Unknown user", no Watch). It now
falls back to `channelParticipants` for the channel before it builds a
placeholder.

## Protocol and compatibility

- **`SessionParticipant.kind`**: a new field, always serialized. An older relay
  sends none, which reads as `member` (correct: it has no view sessions). Older
  clients ignore the field. An unknown value is refused, never read as a member:
  the browser drops that roster entry with a warning. On the desktop, serde
  rejects the whole control message, which is fail-closed but blunt. A future
  kind needs a version bump or a tolerant reader there.
- **Close codes**: relay-initiated closes used QUIC code 1. They now use
  4001–4003. The kick/ban words changed from `evicted` to
  `media access revoked`. Nothing in the tree matched `evicted`.
- **Per-track keys**: no wire change. `stream_key_announce` was already per
  track, and receivers always filed keys by `(ssrc, epoch)`, so mixed old and
  new publishers and receivers interoperate. Track epochs no longer follow the
  voice epoch.
- **Desktop IPC** (same bundle, no new commands, `lib.rs` untouched):
  `media_participant_join` is now `{ userId, kind }` (was a bare id);
  `media_participant_leave` and `media_participant_join_details` add `kind`;
  `media_list_session_participant_capabilities` entries add `kind`. The new
  event is `media_announce_sender_keys`.
- **API**: nothing new on the wire. `RelayForwarder` gains
  `supersede_view_connection`, `revoke_view_connection`,
  `ConnectionHandle::close_with` and `relay_close_reason`.
  `routes::voice::revoke_views_without_access` is public, for tests.
- `docs/encryption.md` ("Voice and video") now understates what happens. It is
  outside this package's files. Suggested text: "Each person in a call makes one
  sender key for their voice and one for each video or stream-audio track, and
  sends each to the people entitled to it: the voice key to people in the call,
  a screen share's keys also to people watching it without joining. A sender
  makes new keys when someone in the call joins or leaves, and new screen-share
  keys when someone watching it stops."

## Evidence

### Unit tests (fail before, pass after)

The seven new browser tests in `browserMediaEngine.roles.test.ts` were run
against HEAD (G6, commit `591d0c26`) in a scratch worktree. All seven fail
there. Log: `output/design-reference/glass-build/g6b/before-roles.log`. The key
failures:

```
the voice key reached a viewer: expected [ '300', '400' ] to not include '400'
(viewer arrival) expected [ '300', '400' ] to deeply equal [ '300' ]        ← reported to the call, voice rotated
(member → viewer) expected [] to deeply equal [ '300' ]                      ← never treated as leaving the call
(unknown kind) expected [ '300', '700' ] to deeply equal [ '300' ]          ← taken for a member
(per-track keys) TypeError …trackSenders                                     ← one key for everything
```

The member-leave test fails on HEAD only because it inspects `trackSenders`.
The property it checks, that a member's departure rotates the voice key, held
before and still holds.

New tests, all passing:

- Browser: the viewer is never wrapped the voice key, and the screen key it can
  open is not the voice key. The viewer is not reported to the call. Its arrival
  and departure leave the voice key's epoch and bytes unchanged, and its
  departure rotates the screen key to the member only. A member leaving rotates
  voice and camera and sends nothing to the departed member. A member joining
  rotates. A member turning viewer counts as leaving. An unmarked entry is a
  member, and an unknown kind is refused. Four distinct keys exist, and a
  keyless track is refused. An unchanged republish does not resubscribe or
  reset the decoder. `readSessionParticipantWire` reads `kind`. The shared
  helpers are tested (`keyRecipients`, `readRosterKind`, `parseRelayCloseReason`).
  The WebTransport close code alone yields superseded, ended or revoked, with no
  redial. The store sets `endReason: 'revoked'`. The store keeps names and
  sharing through a leave and a cold join.
- Desktop JS (`tauriMediaEngine.roles.test.ts`): viewers are not reported, and a
  member turning viewer is reported as leaving. `media_announce_sender_keys`
  wraps the voice key to members only, the screen and screen-audio keys to the
  viewer too, and the camera to members only. A voice announce aimed at a viewer
  sends nothing.
- Rust, desktop (`events.rs`): the plans for a viewer's join, a viewer's leave, a
  member's join and leave, a member turning viewer, a replaced view session and
  roster snapshots. An execution test shows that rotating for a viewer's
  departure bumps only the screen and screen-audio epochs, and leaves the voice
  state and the camera untouched, while a member's departure changes all of
  them. The relay's close words are reported.
- Rust, relay: `the_roster_marks_viewers_and_members` reads a real QUIC client's
  `session_state` and `session_participant_join`.
  `the_relay_says_why_it_closed_a_connection` covers 4001 for both a connection
  replacement and `supersede_view_connection`, 4002 and 4003, with words, over
  real QUIC.
- Rust, transport: the kind's wire round trip (and refusal of unknown values),
  distinct close reasons, the capsule's layout and length limit, an ownerless
  close closing the connection with the code and words, and a held session
  handing the close to its owner.
- API: `losing_access_mid_view_ends_the_view` covers VIEW_CHANNEL lost (ended),
  CONNECT lost on a watch (ended), CONNECT lost on ambient (kept) and an
  untouched view (kept), on SQLite.

### Commands

| Command | Result |
|---|---|
| `npx vitest run src/lib/media src/stores/voice src/stores/voiceStore src/lib/crypto src/gateway` | 47 files, 546 tests, pass (three consecutive runs) |
| `npx tsc --noEmit` | clean |
| `npx eslint` on every touched source and test file | 0 errors |
| `pc-cargo.sh test -p paracord-transport -p paracord-relay -p paracord-api -p paracord-server` | 90 test binaries, 1123 tests, pass. Relay `--lib` (139) and `voice_listen_view` (10) re-run after the last relay/API change: pass |
| `pc-cargo.sh check --workspace --tests` | pass |
| `pc-cargo.sh clippy -p paracord-{transport,relay,api,server,media-dev} --tests -- -D warnings` | clean |
| `pc-cargo.sh test --manifest-path client/src-tauri/Cargo.toml --all-targets` (vpx on) | 127 passed, 2 ignored |
| `pc-cargo.sh clippy --manifest-path client/src-tauri/Cargo.toml --all-targets -- -D warnings` (vpx on) | clean |
| `cargo fmt` | all my files clean. `cargo fmt --all --check` still flags `paracord-server/src/main.rs` and `paracord-api/tests/voice_listen_view_sse.rs`, both unformatted before this package and not touched by it |

PostgreSQL was not run. This package adds no SQL: the re-check reads through
existing queries.

### Live (2026-09-30)

Setup: `npm run build`, `touch embedded_ui.rs`, and a release `paracord-server`
built with `pc-cargo.sh` (vpx untouched). The served `assets/index--nsLo3TX.js`
matched `client/dist`, and the bundle contains the new close words. Then
`live-env.mjs --port 18820` (data in the scratchpad) and `glass-scene.mjs
--hold`. The cast (Vincent sharing, Brendan on camera, Nick muted) ran the
embedded build, so Vincent published with separate keys per track, and the
call held 3 connected at about 180–200 video packets/s each throughout. Sean and
Luke ran from a Vite dev server with HMR off, because other packages edit the
tree during the run.

`node client/scripts/glass-scene/g6b-probe.mjs` (new) reads Sean's and Luke's
stores and engines and **every media control message their engines received**.
Final two runs: **19/19 and 19/19**. Logs: `probe-run6.log` and `probe-run7.log`
in `output/design-reference/glass-build/g6b/`.

- Luke joins Lounge (a member) and decodes Vincent's screen.
- G8's room light was running an ambient view of Vincent for Sean. When Sean
  went Home it ended, and Luke was sent only Vincent's screen key at its next
  epoch (e37, then e45 in the second run). No voice key moved.
- **Sean watches Vincent without joining.** 13 and 20 sampled frames (at most
  4 Hz) decode in 6 s. His view
  session received **0 `key_deliver`** and only Vincent's `stream_key_deliver`
  for `stream:…:screen`. His view roster is Vincent alone, marked `member` by
  the relay.
- **Nothing rotates for anybody.** Luke (in the call) received no key message at
  all from Vincent, Brendan or Nick while Sean's view started, not even a
  replayed one. Nobody in the call was told about Sean.
- **Sean stops.** Luke received no voice key. Only Vincent's screen key moved to
  the next epoch, nothing from Brendan (camera) or Nick. Luke's picture of the
  screen kept coming: 97 and 116 frames in 5 s, longest gaps 659 and 118 ms.
- **Superseded.** A `POST /view` for Sean from Node replaced his watch. The
  browser reported `endReason: "superseded"` at once, where G6 could only say
  `ended`, and made 0 new connections in 6 s.
- **Revoked.** Brendan (the owner) denied Sean VIEW_CHANNEL on Lounge while he
  watched. The watch ended `revoked` 3.7 s and 0.2 s later (between 0.2 and
  5.1 s across all runs, within one 5 s sweep) and stopped being counted. The
  overwrite was then removed.

Earlier runs are kept because they found things. Run 2 (before the republish
no-op) showed six replays of Luke's stored key and a 1513 ms gap. Runs 3–5
counted the room light's ambient reopening as a redial and its departure as the
watch's arrival. The probe was split to tell those apart. Run 4 was cut short by
a Vite reload, the reason HMR is now off.

Regressions: G6's `media-probe.mjs` against the same call passed **25/25**,
including listen, the upgrade in place, watch, ambient at 0.69 fps, carry-over
and supersede (now `superseded`). WP-G12's `e2e/glass-pill-live.mjs` passed
**25/25**. Its "nameless placeholders after a leave and a cold join" line now
counts **0**. The line is printed unconditionally, so it still appears.

Everything was stopped afterwards: the holder by SIGINT (it left the call), then
live-env. No Vite, browser or server of mine is running. The scratch worktree
used for the "before" run was removed.

## Files

- Transport: `crates/paracord-transport/src/control.rs` (`SessionParticipantKind`,
  `kind`, `MediaCloseReason`, tests), `src/webtransport.rs` (close requests,
  capsule, `closed()`, tests), `tests/availability_bounds.rs` (struct literals).
- Relay: `crates/paracord-relay/src/relay.rs` (`roster_kind`, `close_with`,
  `relay_close_reason`, `supersede_view_connection`, `revoke_view_connection`,
  every close site, tests).
- API: `crates/paracord-api/src/routes/voice.rs` (`revoke_views_without_access`,
  `view_still_allowed`, supersede on replacement), `tests/voice_listen_view.rs`.
- Browser: `client/src/lib/media/browserMediaEngine.ts`, `engineShared.ts`,
  `senderKeys.ts` (`hasLocalKey`, `currentKey`), `mediaEngine.ts` (the resolver
  is removed), `transport/webTransport.ts`.
- Desktop: `client/src/lib/media/tauriMediaEngine.ts`;
  `client/src-tauri/src/native_media/events.rs` (plans, `KeyState`, per-track
  epochs, emitters, `describe_connection_close`, tests), `session.rs`
  (`RemoteSessionParticipant.kind`, `from_wire`), `commands.rs` (`kind` in the
  capability listing). `native_render/**` and `lib.rs` are not touched.
- Store: `client/src/stores/voiceStore.ts` (the resolver is gone, and the cold
  join keeps server voice states), `stores/voice/callSession.ts` (`seenMembers`
  removed), `stores/voice/viewSessions.ts` (`revoked`, `parseRelayCloseReason`).
- Tests: `browserMediaEngine.{roles,keyExchange,test}.ts`,
  `tauriMediaEngine.roles.test.ts`, `engineShared.test.ts`,
  `transport/webTransport.lifecycle.test.ts`, `stores/voiceStore.media.test.ts`,
  `stores/voiceStore.nativeBrowserJoin.test.ts`.
- Script: `client/scripts/glass-scene/g6b-probe.mjs` (new).

Two existing tests changed their expectations, with reasons given in comments.
`keyExchange`'s "leave during announce" and "rejoin overtakes leave" read the
roster's announce as it now happens. It is wrapped when the roster arrives, to
the call keys named in that roster. The rotation that follows is what the
departed or rejoined peer must see, and that is now what the tests assert.

## Not done, and risks

1. **The desktop app is not verified live.** It has no Tauri run (that is
   WP-G23). The native plans, the per-track rotation and the renderer side of
   `media_announce_sender_keys` are unit-tested, compiled with vpx and
   clippy-clean. The older desktop bug fixed on the way (members not sent a
   desktop publisher's rotated keys after a join) is inferred from the code and
   covered by the plan tests, not observed live.
2. **A viewer's departure costs other watchers a short stall.** The publisher
   switches to the new screen key as it announces it. Frames that arrive before
   the key are dropped until a keyframe. Measured longest gap across the
   rotation: 104–668 ms (before the republish no-op: 1513 ms). The room light's
   ambient views depart whenever somebody leaves a server, so this recurs.
   Announcing first and switching a moment later would remove it. That change
   touches both engines' send paths and is left as a follow-up.
3. **A viewer's arrival does not rotate the stream key.** This is by design (see
   Rotation), but it is weaker than a member's arrival: a new viewer can open
   stream packets from earlier in the current epoch if it recorded them with
   the relay's help.
4. **Ambient viewers get the screen-audio key.** The marker says `viewer`, not
   which kind of view. The publisher wraps the screen-audio key to ambient
   viewers too, and the relay drops it (`ViewTarget::allows`). Adding the view
   kind to the marker would move that filter to the publisher.
5. **Calls are still not re-checked** when a member loses VIEW_CHANNEL or
   CONNECT. Only views are. That is outside this brief, the same as in G5.
6. **An unknown roster `kind` drops the whole control message on the desktop**
   (strict serde). See Protocol.
7. **Rejoin-era envelope race (existing, not widened).** An announce wrapped for
   a peer's previous call key, reaching that peer's new connection, still ends
   the peer's call ("could not be opened"). It needs the announcer to learn of
   the rejoin between reading the roster and sending, and the relay to deliver
   after the new connection registers. It was not seen live. Keying the
   relay's delivery by receipt would close it (glass-fix-rejoin "For G5").
8. The relay still repeats `TrackPublish` after every announce. It was kept
   because it covers a key that arrives before its track; clients now ignore an
   unchanged repeat.
9. `docs/encryption.md` needs the update suggested above.
10. WP-G12's driver prints its NOTE even at 0; making it conditional is theirs.
