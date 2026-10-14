# Checkpoint: stream fix V7, old and new apps together, and voice from the first second

Package V7, after the compatibility pass (`stream-compat.md`). Branch
`feat/index-ui` on `af21252d`, 2026-10-14. Four problems: Viewing quality
Source on an older relay, old apps decoding green on Low and Medium against the
new relay, Unmute undone right after joining, and the first voice after a join
silent in one direction.

Versions, as in the compat pass: OLD SERVER `477020c8`, OLD APP `7d40c31a`,
NEW = this commit. Machine: RTX 4080, KWin 6.7.5. Lab: `scripts/stream-audit`
plus the new `mixed/` (two audit-serves, :1493 new and :1492 old dist; the
instance on :18830; graphs `v7-pwA`/`v7-pwB`; nested KWin only;
`~/.config/kwinoutputconfig.json` `e6df1573…` before and after every run).
Speech (espeak-ng) is played into each app's microphone stream only, and each
app's output level is recorded every 50 ms. The owner's old local server and
installed app were not touched.

## Verdict

| # | Problem | Before | After |
|---|---|---|---|
| 1 | Source on the old relay (new viewer) | 1280x360 of a 3840x1080 share (compat #1) | **3840x1080, 56.6 to 60.0 decoded/s**. The first Source request of a connection shows the lowest layer for about a second while the relay is asked again; later ones go straight to the top |
| 2 | Old apps on the new relay, Low/Medium | Green and magenta for as long as they are selected (compat #3b) | **No green at any quality**, new → old and old → old. Old apps stay on the largest layer they have shown; Low/Medium are refused and logged |
| 3 | Unmute pressed while joining is undone | Undone in old and new apps (compat); the new unit tests fail on the old code | **New app: kept, 0 of 72 joins undone**. Old app: undone 20 of 20 (its own bug) |
| 4a | First voice silent into a new app that joined | 2 of 16 joins silent for the whole check (new → new) | **0 of 56** (new ↔ new on the new and old relays, old → new) |
| 4b | A new app's voice silent to an old app already in the call | 3 of 10 joins silent, 3 more 3 to 18 s late | **0 of 10**, heard 1.06 to 2.03 s after the join click |
| 4c | A new app's voice after a short mute, to an old app | Silent after every 0.3, 1 and 2 s mute, until a 5 s pause | **Back within the first second** after 0.3, 1, 2, 3 and 4.5 s mutes |
| 4d | An old app that joins, hearing a new app | 2 of 10 silent | 2 of 10 silent: the old app's own receive path. Needs the old app updated |

New ↔ new voice arrives 0.73 to 1.77 s after the join click, in the same half
second as the joiner's media connection (the relay sees it 1.0 to 1.7 s after
the click, sampled every 0.5 s): the media connection is the wait, not the
voice.

## 1. Viewing quality Source on an older relay

A new client asks for `requested_layer: 255` (`SOURCE_LAYER`). The old relay
resolves a requested layer by exact id, matches nothing and forwards the
lowest layer; its `SubscriptionAck` echoes 255 (a current relay names the top
layer it will forward).

Client only, no wire change (`native_media/events.rs`,
`stream_registry.rs`, `commands.rs`):

- An acknowledgement of 255, for a Source subscription to a track whose
  layers this side knows, means the relay predates Source
  (`source_request_for_older_relay`). The client subscribes again with the
  track's top layer id and remembers it for the connection
  (`StreamRegistry::note_relay_lacks_source_layer`). Logged: "the relay
  predates Viewing quality Source (it echoed layer 255); asking it for the
  top layer by number".
- From then on `media_register_track_subscription` sends Source to that relay
  as the top layer's number (`requested_layer_for_relay`), so a tile resize or
  a later Source goes straight to the top.
- A current relay never echoes 255 for a track it has, so nothing changes
  there. An unknown track (the relay also echoes the request then) is left
  alone.

Old server, new → new, 1080p60, viewer 5120x1412 (decoded size per step, from
the probe):

| Step | Decoded |
|---|---|
| Auto | 3840x1080, 60.1/s |
| Source (first of the connection) | 3840x1080, 56.6/s (1280x360 for ~1 s first) |
| Low | 1280x360, 48.4/s (the old relay's own selection) |
| Source | 3840x1080, 60.0/s |
| High | 3840x1080, 56.7/s |

Low and Medium on the old relay still drift back up on that relay's own
selection (compat #1); not changed.

## 2. Old apps on the new relay: no green

The old app's decoder keeps the picture size of the largest layer it has
been given: a larger layer still decodes, a smaller one decodes green. The new
relay switched old viewers down on Low and Medium (and for bandwidth); the old
relay never did.

- **Capability**: `SessionJoin` gains `layer_switch_resets_decoder: bool`
  (`#[serde(default)]`, not written when false, so an old app's join is
  byte-identical; serde ignores it on an old relay, which has no
  `deny_unknown_fields`). The desktop app (both slots) and the browser engine
  send `true`: both start a fresh decode chain at the new layer's keyframe.
- **Relay** (`relay.rs`): a viewer without it has a `decoder_floor`, the
  largest layer it has been given (set when its subscription commits a layer,
  raised on every larger commit). Requests and selection may move it up, never
  below the floor. A request for a smaller layer is refused, acknowledged with
  the layer it keeps, and logged: "viewer asked for a smaller layer, but its
  app predates decoder resets on a layer switch and would show it green;
  keeping it on its layer (it needs to update Paracord to lower video
  quality)". The join itself is logged once per connection. Only when the
  publisher stops sending the floor layer (V6 uplink adaptation) does the
  viewer move below it (a picture that may be corrupt rather than none, logged
  as a warning), and it goes back to the floor as soon as the layer returns
  (`decoder_floor_target`).
- **The signal "Update Paracord to change video quality"**: an old app renders
  no new UI and fails on unknown control messages, so nothing new is sent to
  it. The server logs say it per viewer. (The roster could later tell a new
  sharer which viewers are out of date; not done.)

New server, 1080p60, viewer 5120x1412:

| Step | new → old: decoded | old → old: decoded |
|---|---|---|
| Auto | 3840x1080, 48.1/s (the relay moved it up from 2560x720: clean) | 1920x540, 34.0/s |
| Low | 3840x1080, 60.0/s, refused | 1920x540, 33.9/s, refused |
| Medium | 3840x1080, 59.6/s, refused | 1920x540, 34.2/s, refused |
| High / Source | 3840x1080, 60.1/s | 1920x540, 34.3 / 33.5/s |
| Low, Medium again | 3840x1080, 59.9 / 59.7/s | 1920x540, 34.6 / 33.5/s |

Screenshots at every step show a clean picture (the old sender's top layer is
1920x540, its own cap). Before, Low and Medium were green for as long as
selected (compat #3b). New → new on the new relay is unchanged: Low stages
layer 0, Medium 1, High 2, Auto back to 1 at this window, at keyframes.

## 3. Unmute right after joining

The mic button is live from the moment a join starts. `toggleMute` set
`selfMute` while the call was joining (no engine yet), and `performCallJoin`
then committed the mute captured when the join began, undoing it.

`voiceStore.ts`: the join reads the mute and deafen the person wants when the
call commits (`wanted()`), not when the join started, for the native and the
LiveKit paths. Tests: `voiceStore.nativeBrowserJoin.test.ts` "keeps an Unmute
pressed while the call is joining" and "keeps a Mute pressed …" (both fail on
the old code).

Lab: the driver presses Unmute the moment the button exists, during the join.
New app: kept in 72 of 72 joins. Old app: undone in 20 of 20 (it needs the
update).

## 4. The first voice after a join

Three causes, two of them in old apps' receive path, which the new sender now
works around where it can.

**a. The new app's own receive path (fixed).** On every join the app opens the
default output and 0.1 s later the renderer re-applies the saved output device
(`voice_switch_output_device`), rebuilding the mixer with the voice sources it
can see. The first datagram of a voice registers its mixer source and records
it in two steps; when the switch fell between them, the new source stayed on
the old, stopped mixer and that voice was silent for as long as it kept
sending (the reaper only drops a source after 5 s without packets). The reaper
had the same window (a source removed from the mixer after a returning SSRC
re-registered it). Now every change to which mixer source an SSRC feeds runs
under one lock (`NativeMediaSession::audio_sources`): the datagram task's
registration, the output switch and the reaper (which never waits for it; it
retries next tick).

**b. Old receivers run their playout clock past a silent sender (worked around
by the sender).** The old jitter buffer moves its playout point on every
frame missing at its 20 ms tick and drops anything that arrives behind it
(fixed in new receivers by V4). The voice sequence number stopped while the
sender sent nothing, so after any silence their clock was ahead of every
packet that followed, and the sender stayed silent to them until a 5 s pause
reset them. That silence happens on every join: the renderer also re-applies
the saved microphone 0.1 s in, and the capture reopens with 2 to 4 frames
lost (57 to 91 ms in the lab). And after any mute shorter than 5 s.

Now the voice sequence and timestamp follow the audio clock (`VoiceClock`,
`audio_pipeline.rs`), as RTP does: a muted frame passes its slot, a frame that
fails to encode or encrypt passes its slot, and the capture forwarder marks a
restart (an empty frame, in order with the others) so the next frame passes
the slots the restart cost, rounded up (one slot too many costs an old
receiver one concealed frame; one too few silences it). At most 250 slots
pass in one silence: an old receiver resets after 5 s anyway, and it keeps
every jump far inside the rollover estimate's range. New receivers take a
packet two or more frames ahead of a playout point that has played everything
as the start of a talk spurt and play from it (`JitterBuffer::insert`), so the
jump adds no delay and conceals nothing.

**c. Old apps that join (not fixable here).** The old app has cause a's mixer
race and the old jitter start in its own receive path; when it is the one
joining, a new sender's voice is still silent to it in about 2 joins of 10
until that sender mutes for 5 s. Only updating the old app fixes it.

**Not the cause:** key exchange and subscription timing. The relay forwarded
the sender's audio to the joiner from its first second in every silent trial
(relay counters), and no decrypt alert fired (the new app repeats one every
2 s while a key is missing).

### Numbers

Join trials: one app in the call and talking, the other joins and presses
Unmute at once; 12 s of both voices. "Silent" means not heard for the whole
check.

| Server | Already in the call → joiner | Build | Silent | Heard after the join click |
|---|---|---|---|---|
| new | new → new | before (no lock, no clock) | **2 of 16** | 0.78 to 1.67 s (the others) |
| new | new → new | after | 0 of 16, then 0 of 10 | 0.76 to 1.57 s |
| old | new → new | after | 0 of 10 | 0.73 to 1.00 s |
| new | old → new (old app in call) | lock only / after | 0 of 10 / 0 of 10 | 0.79 to 1.84 s |
| new | **new joiner → old app in call** | lock only (no clock) | **3 of 10**, 3 late (3.0, 3.4, 17.9 s) | |
| new | **new joiner → old app in call** | after | **0 of 10** | 1.06 to 2.03 s |
| new | new → old joiner | before / after | 2 of 10 / 2 of 10 | old app's receive path (c) |

Mute gaps (a talker in the call mutes, then unmutes; voice active per second
after unmuting, 1.0 = all of it):

| Talker → listener | Build | 0.3 s | 1 s | 2 s | 3 s | 4.5 s |
|---|---|---|---|---|---|---|
| new → old | lock only | 0.1, then 0.0 | 0.0 | 0.0 | | |
| new → old | after | 0.4, 0.9, 0.8 | 0.4, 0.8, 1.0 | 0.7, 0.9, 1.0 | 0.8, 0.7, 0.8 | 0.7, 0.6, 0.8 |
| new → new (new server) | after | 0.7, 1.0, 0.7 | 0.9, 1.0, 0.8 | 0.9, 0.8, 1.0 | | |
| new → new (old server) | after | 0.7, 1.0, 0.7 | 0.9, 1.0, 0.8 | 0.9, 0.8, 0.8 | | |

(Speech has pauses; 0.6 to 1.0 is continuous talk.)

## Tests and gates

- `paracord-transport`: the new field is additive (absent reads false, false
  is not written, an unknown field is ignored).
- `paracord-relay`: an old app keeps its layer on Low, on a congested
  downlink, moves below only when the layer is unpublished and comes back;
  an old app may move up and then not back down; `decoder_floor_target`.
- `paracord-codec`: a talk spurt after a skip plays at once; one frame ahead
  into an empty buffer stays a lost frame; no jump while frames are buffered.
- `paracord-desktop`: the voice clock (mute, capture restart with a 90 ms gap,
  cap, no-gap restart); reaping under the source lock; the forwarder's
  restart marker; Source on an older relay (ack 255, remembered per
  connection, untouched for a current relay or an unknown track).
- Client: the two join-mute tests.

`cargo fmt --check`; `cargo clippy --workspace -D warnings`; `cargo clippy -p
paracord-desktop --all-targets -D warnings`; Windows cross clippy (`-p
paracord-desktop`, only the pre-existing `windows_h264.rs` and
`screen_capture.rs` warnings); tests of transport, relay (160), codec and
desktop (273); client typecheck, unit (4927), lint of the touched files.

## Wire and behavior changes to know about

- `SessionJoin.layer_switch_resets_decoder` (additive).
- The voice track's sequence numbers skip the slots the sender did not send
  (up to 250). Any receiver that treated a gap as loss and concealed it frame
  by frame would add the gap's length to its delay; the current one plays the
  talk spurt at once, the old one is realigned by it.
- Old apps on the new relay never go below the largest layer they have shown:
  on a congested downlink they stutter instead of stepping down (the
  alternative is a green picture).

## What is left

- An old app that joins can still miss a new talker's voice (c) until the
  talker mutes for 5 s; and its own Unmute right after joining is undone; and
  it freezes after a re-share (compat #3). All need the old app updated.
- The renderer re-applies the saved microphone and output on every join,
  reopening both devices 0.1 s after they opened. Harmless now on the new app,
  but wasted work: opening the chosen devices first would remove it.
- The first Source request on an older relay shows the lowest layer for about
  a second before the top.
- Mixed-version calls with the browser client were not run.

## Cleanup

Lab processes, graphs and run data removed; temporary worktrees
`~/Documents/Paracord-compat-oldsrv` (`477020c8`) and
`~/Documents/Paracord-compat-oldcli` (`7d40c31a`) removed. The shared
`CARGO_TARGET_DIR` last built this tree.
