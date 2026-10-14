# Checkpoint: mixed versions, old and new apps on old and new servers

A compatibility pass before the new desktop build is installed. Branch
`feat/index-ui` at `21b09f3b` (the stream fix round V1 to V6), 2026-10-14. No
product code changed.

| Name | Commit | What it is |
|---|---|---|
| OLD SERVER | `477020c8` (2026-10-05) | what the owner's LAN server runs |
| OLD CLIENT | `7d40c31a` (2026-10-13) | the installed desktop app, and what friends may run |
| NEW | `21b09f3b` | server and desktop after the stream fix round |

Between the old server and the old client there is no media change (relay,
transport, codec and `native_media` are identical); the old client already has
the one-password and setup work. All media differences below come from the
stream fix round.

## How it ran

The stream-audit lab (`scripts/stream-audit`), extended in a scratch copy
only: two audit-serve origins (the new and old `vite build`s on two ports, each
desktop test build pointing at its own), one throwaway instance on loopback
(the old or the new `paracord-server`, data wiped between them), the synthetic
5120x1440 screen at 60 fps with tone bursts, the sender at 1600x900 and the
viewer at 5120x1412 / 240 Hz in nested KWin sessions, private PipeWire graphs,
the probe preloaded. `~/.config/kwinoutputconfig.json` unchanged on every stop.

Accounts: on the old server, legacy accounts (`/auth/register`); the apps sign
in through their own pages (the new client's first-run form hands an older
server to its `/login` page, which works). On the new server, one-password
accounts.

Per pairing, both apps in the voice room with the call view open:

1. Voice both ways: a 10 s speech sample fed into one app's microphone stream,
   the other app's output level recorded (seconds above 0.1 RMS of 12).
2. A fresh share at **720p30**, the viewer just rejoined: normal view 10 s,
   full screen 10 s, then Viewing quality Low, Medium, High, Source, Auto
   (3 s to settle, 8 s measured each), then a **re-share** (stop, 2.5 s, share)
   with the viewer untouched.
3. The same at **1080p60**.
4. Voice both ways again while sharing.
5. Separately: channel chat and an encrypted DM both ways, old and new app.

"Live" means frames reach the viewer's decoder (the probe) and the stream says
live. When a picture did not come back by itself in 15 s, the driver pressed
Watch / Watch again once, then toggled full screen once, and recorded which
one brought it back. Received layer, decoded/s and A/V offset are
`analyze.py`'s; layer switch times are from the viewer's upload sizes.

## Compatibility matrix

| # | Server | Sharer → viewer | Video | Re-share | Viewing quality | Voice | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | old | **new → new** | 720p30: 2560x720, 30.0/s. 1080p60: 3840x1080, 51 to 59/s (full screen 51). Live in 3.0 s | Back in 3.0 s, both presets | **Source gives the lowest layer** (1280x360). Low holds for 3.5 to 7.5 s, then the relay climbs back. Medium at 1080p60 climbs to the top after 6.5 s. Gaps up to 1.1 s on a change | Both ways, idle and sharing | Works. One silent bug: Source |
| 2a | old | new → **old** | 720p30: 2560x720, 30/s. 1080p60: 3840x1080, 53 to 60/s. A/V +106 to +142 ms | **Frozen**, never back (old-client bug, same as old → old) | No effect (stays top), no corruption | Both ways | Same as today's old → old, with the new sender's better frame rate |
| 2b | old | **old** → new | Old sender: 1280x360 at 24 to 26/s (720p30), 1920x540 at 33 to 38/s (1080p60). A/V +54 to +102 ms | Back in 3.1 s | **Source gives the lowest layer** (640x180). Low and Medium climb back after ~7 s | Both ways (see voice note) | Works. Same Source bug as #1 |
| 3a | new | **old** → new | Same old-sender numbers: 1280x360 at 25/s, 1920x540 at 30 to 36/s. A/V +42 to +105 ms | Back in 3.1 s | Works: Low 640x180, Medium 1280x360, High/Source top | Both ways (see voice note) | Works |
| 3b | new | new → **old** | 720p30: 2560x720, 30/s. 1080p60: 3840x1080, 52 to 60/s | **Frozen**, never back (old-client bug) | **Low and Medium turn the picture green and magenta** for as long as they are selected; High/Source/Auto fine | Both ways | Plays, but a new silent corruption on Low/Medium |
| ref | old | old → old (today) | 1280x360 at 24/s, 1920x540 at 24 to 39/s, a 6.8 s and a 3.1 s freeze | Frozen, never back | No effect | Both ways | The owner's current state |
| ref | new | old → old | As above | Frozen | **Green on Low/Medium** (as 3b) | Both ways | |
| ref | new | new → new | 720p30: 2560x720, 30/s. 1080p60: 3840x1080, 51 to 58/s. A/V +0 to +25 ms | Back in 3.0 s | Low 1280x360, Medium 1280x360 (720p, two rungs) / 2560x720, High/Source top, switches in 0.4 to 1.2 s | Both ways | The fix round's numbers |

Chat and DMs:

| Server | Old ↔ new app | Result |
|---|---|---|
| old | channel chat | Both ways, live |
| old | encrypted DM | Both ways once **both** accounts set up "local identity" (`/setup?migrate=1`, Settings › Set up local identity). Before that the DM says "Encryption needs setup: Set up encryption before sending in this conversation" with only **Check again**, no way to the setup page. Same in both versions (an older-server flow, not a mix problem) |
| new | channel chat | Both ways, live |
| new | encrypted DM | Both ways, at once (one-password accounts carry their identity) |

No crash, panic or disconnect in any run. Nothing failed with an error the
person sees: every problem below is silent.

## What breaks, why, and the smallest fix

### 1. Viewing quality "Source" on an old server gives the lowest layer (#1, #2b)

Seen: Source → 1280x360 of a 3840x1080 share (new sharer), 640x180 (old
sharer), held for the whole phase. The person asked for the best picture and
gets the worst, with no message.

Cause: the new client asks for `requested_layer: 255` (`SOURCE_LAYER`,
`StreamSound.tsx:25`, `paracord-transport/src/stream.rs:142`; it was 2 before
V1). The old relay resolves a requested layer only by an exact id match
(`TrackSubscription::resolved_layer_id` at `477020c8`), so 255 matches nothing
and `matches_layer_ssrc` falls back to the lowest published layer.

Smallest fix, client only, no protocol change: the relay's `SubscriptionAck`
already tells the two relays apart. A new relay acks a Source request with the
real top layer id; an old relay echoes `255` (`resolved_ack_layer` falls
through to `requested_layer`). In `native_media/events.rs` (the
`SubscriptionAck` arm, which today stores the echoed 255 as `active_layer`), an
ack of `Some(SOURCE_LAYER)` means "this relay predates Source": subscribe again
with the highest `layer_id` of the track's announced layers, and keep doing so
for that connection. Log the decision. On a new relay nothing changes.

Low and Medium climbing back on the old relay is that relay's own behavior (its
layer choice is not a ceiling); the client cannot make it hold short of asking
again. Not worth a fix; the old client never showed the choice taking effect
at all in a call.

### 2. Old viewers on the new server: Low and Medium decode green (#3b, and old → old on the new server)

Seen: the new relay logs `viewer asked for another layer; switching at its next
keyframe ... to=0`, the old viewer's decoder keeps its 2560x720 / 3840x1080
picture size, and the screen shows a green and magenta smear until a larger
quality is chosen again (screenshots in the run). On the old server the same
old client's choice never switches the layer, so it never shows.

Cause: two halves. The new relay honors an old client's requested layer as a
ceiling and switches it at the target's keyframe (`room.rs` staging,
stream-fix V1); the old client does not reset its decoder when the layer's
resolution changes (audit B4, fixed client side in V1 and `4b4bbba6`). Each is
right on its own; together they corrupt.

Smallest fix: needs a capability, the relay cannot tell an old client from a
new one today. Add one additive field to `SessionJoin` (for example
`layer_switch_resets_decoder: bool`, `#[serde(default)]`, sent `true` by new
clients; old relays ignore it). For a subscriber without it, the new relay
keeps the layer it first gave that viewer and does not stage requested-layer
or bandwidth switches under it (what the old relay effectively did for in-call
viewers), and logs why. The same flag would let the server tell the sharer or
the viewer "this app is out of date" instead of nothing. If friends are
expected to update soon, shipping without it is defensible: the old client was
already green after Auto switches at small windows (audit B4).

### 3. Old viewers freeze after any re-share, on both servers (pre-existing)

Not a mix problem: old → old freezes the same way on the old server. The
viewer's stream stays marked live over the last picture, with no notice; Watch
and a full screen toggle do not bring it back within 30 s. A share after the
viewer rejoins the call can need Watch / Watch again or a layout change before
the first frame (seen in old → old as well). With a new sharer, the moment the
old viewer's picture resumes after such a freeze, its NVDEC AV1 decoder once
failed a keyframe (`CUDA_ERROR_INVALID_VALUE`, "keyframe failed to decode (1x);
decoder instance dropped") and recovered. Fixed for new viewers by V2 and
`4b4bbba6`; only updating the viewer's app fixes it.

### 4. Things that are fine

- The wire format, ALPN, transport parameters and control messages are
  byte-identical across the three versions, so there is no deserialize error,
  disconnect or refused join in any mix.
- A new sharer on the old relay: every frame on its own stream (V1) goes
  through the old relay at full rate on loopback (30.0 and 51 to 60 decoded/s).
  The old relay reads only 4 streams per publisher at once and gives raw-QUIC
  viewers no shedding, so under real loss or a slow viewer expect more stutter
  and latency than on the new relay. Not measured here (no loss shaping).
- A new viewer of an old sharer (either relay): re-shares come back in 3.1 s,
  qualities work on the new relay, A/V within +42 to +105 ms (the old sender's
  audio clock is not the share's clock; `av_sync` stays bounded). The old
  sharer's own limits (24 to 38 fps, 32:9 layers capped at 1280x360 /
  1920x540) are the pre-fix sender and need the sharer to update.
- Capture to screen on the old relay was 155 to 209 ms in the 720p30 quality
  phases for a new viewer (100 to 110 ms on the new relay), back to ~100 ms
  after.

### Voice note (pre-existing, both versions)

Voice works both ways in every pairing. Two lab observations, both seen in
old → old on the old server too, so not caused by mixing: an Unmute pressed in
the first seconds after joining is reverted by the app (old and new clients),
and in 4 of 8 pairings the first voice check after joining was silent in one
direction (a fifth was half silent), always into an old client, then worked
from the next check on.
Worth a separate look.

## For the owner

- **Install only the new desktop app now (old server):** sharing, viewing,
  re-shares, voice, chat and DMs work, and your shares go out at 30 and 60 fps
  instead of 24 and 35. One silent bug: Viewing quality **Source** shows the
  lowest layer; leave it on Auto until fix 1 lands.
- **Friends on the old app, either server:** they can watch your share and you
  can watch theirs. They still freeze after you stop and share again (their
  app's bug); they need to leave and rejoin, or update.
- **After updating the server while friends have not:** everything above holds,
  plus old apps that pick Low or Medium see a green picture (fix 2, or ask them
  to update).

## Cleanup

Lab processes, graphs, sessions and data were removed; the temporary worktrees
for `477020c8` and `7d40c31a` were deleted. The shared
`CARGO_TARGET_DIR` (`Paracord-glass/target`) last built `paracord-server` at
`477020c8` and `paracord-desktop` at `7d40c31a`; the next build of the current
tree rebuilds them.
