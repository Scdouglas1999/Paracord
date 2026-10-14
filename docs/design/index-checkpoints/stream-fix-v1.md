# Checkpoint: stream fix V1, resilience (loss recovery, keyframes, layer switching, viewing quality, mid-stream changes)

Scope: stream audit B3 (1440p, 4K and Movie 50 viewers frozen 5 to 8 s at a
time), B4 (a layer switch turns the picture green), the viewing-quality part
of B5 (Low gets medium, Medium gets top, High and Source are one setting, Movie
100 viewers get 1280x360), the mid-stream rows of the audit (3 to 6 s freezes,
a corrupted picture, a viewer left with nothing), and the audit's "no
diagnostics for B3 or B4". Sender capture, encode loop and bitrates are V3's;
V1 owns only the keyframe/recovery parts of the encoder config.

Machine: RTX 4080, the stream-audit lab (`scripts/stream-audit`), run inside a
private user + network namespace (`unshare -rn`, entered with `nsenter`) so
`tc netem` could drop packets on the lab's own loopback without root and
without touching the host network. Loss was applied to UDP leaving the relay's
media port (relay to sender and relay to viewer), with a `prio` qdisc and a
`u32` filter on the source port. Private graphs (`v1-pwA`/`v1-pwB`) and nested
KWin sessions only; `~/.config/kwinoutputconfig.json` was checked unchanged on
every stop (`e6df1573…`).

## Verdict

| Target | Before | After |
|---|---|---|
| No freeze longer than ~300 ms at ≤5% loss | 0% loss: 5.5 to 6.5 s freezes at 1440p60, 4K60, Movie 100; Movie 50 frozen for the whole 10 s phase. 1%: 4.9 to 7.3 s. 5%: **frozen for the whole phase** at 1440p60, 4K60 and Movie 50 | 1%: 72 to 378 ms. 5%: 79 to 377 ms. 10%: 74 to 375 ms. No frame lost for good, no keyframe wait, no transport stall ≥ 200 ms in any of these phases |
| No green frames | Low and Auto at a 1920 window: green, 0.9 readable frames/s | 0 unreadable frames in every run (layer switches up and down, all qualities, mid-stream changes) |
| Viewing quality mapping | Low→medium, Medium→top, High = Source | Low→1280x360, Medium→2560x720, High→3840x1080, Source→3840x1080 (the top layer, pinned), Auto→top at 5120x1412 and medium at 1920x1080 |
| Mid-stream changes | 720p30→1080p60→4K60→Movie 100→1440p60→720p30: frozen 3.2/4.3/3.4 s, Movie 100 corrupted, 1440p60 nothing | Every step plays; after each change the largest gap was 151 to 838 ms (1.6 s once, during a source gap), with one unexplained 6.4 s gap on the sequence's first step in one of two runs, and in one run the lab's synthetic source stopped at the 1440p60 step; Movie 100 viewers get the 5120x1440 top layer |
| Frozen picture labeled live | Silent | "Reconnecting video…" after 1 s without a frame (1.2 s into a 3 s total outage in the lab), cleared at the next frame; the reason goes to `client-voice.log` |

"Before" is the tree V1 started from (`b6c57f91` plus early sibling work),
measured in the same lab and namespace with the same loss; the "after" numbers
are the final build (V2, V3 and V4 committed underneath). The freeze is the
longest interval between two new frames handed to the viewer's video surface
(the probe's `UP` stage), in normal view at 5120x1412, 10 s per phase.

## What changed

### 1. Every native video frame rides a reliable stream (B3's root cause)

Deltas went as datagram fragments and keyframes (and deltas over 48 fragments)
on QUIC uni streams. Two failures followed, both silent:

- A datagram frame is all or nothing. At 1% packet loss a 45-fragment 4K delta
  arrives whole only 64% of the time, at 5% only 10%.
- The keyframe on its stream was overtaken by the deltas that followed it on
  datagrams. The receiver dropped those deltas (they had no keyframe yet), then
  decoded the keyframe, then decoded the next deltas on top of the missing
  ones. NVDEC (AV1) does that without an error and shows the same picture until
  the next keyframe, 8 s later.

Now `run_screen_frame`/`run_camera_frame` send every frame with
`send_encoded_video_frame_stream` (one frame per uni stream; the datagram
send path for native video is gone). A lost packet is retransmitted, so a frame
arrives late instead of never. The receiver path for datagram video stays for
browser publishers.

The relay side (`paracord-relay/src/relay.rs`):

- `MAX_CONCURRENT_UNI_STREAM_READS` 4 → 16 per publisher (180 streams a second
  at three layers and 60 fps; a frame waiting on a retransmission holds its
  read).
- Stream frames are charged to the sender's packet budget
  (`stream_frame_packet_cost`), so moving video off datagrams does not move it
  out from under the per-sender rate limit.
- Egress to each viewer is tracked per SSRC for raw QUIC and bridged viewers
  alike (`InflightStreamFrames`, replacing the bridged-only keyframe queue): a
  frame is in flight until the viewer acknowledged all of it; a keyframe aborts
  what is still in flight before it on its SSRC (superseded); past 64 frames
  (about a second) the oldest is shed and logged, and the viewer recovers with a
  keyframe. A slow downlink gets a gap, not seconds of queued latency.

The viewer: `MAX_CONCURRENT_UNI_STREAM_READS` 4 → 32 (four frames waiting on
retransmissions stopped the client from accepting the frames behind them), and
the decode channel 2 → 96 frames (a retransmission releases a burst; a fresh
hardware decoder can take up to ~1 s over its first keyframe on a loaded
machine).

### 2. Receiver-driven recovery (`video_pipeline.rs`, `TrackRecovery`)

- The reorder stage holds a frame up to 120 ms for a missing predecessor
  (was 50 ms / 2 frames). On streams a missing frame is normally a
  retransmission in progress.
- A delta delivered past a gap is a broken reference: the worker stops
  decoding deltas, asks the publisher for a keyframe at once (through the relay),
  and asks again every 300 ms until one decodes. Each step is logged:
  `video-recovery: frames 429..=441 never arrived (frame 442 waited 121 ms);
  dropping deltas and asking for a keyframe`, `… no keyframe 362 ms into the
  wait; asking again (request 2)`, `keyframe 462 decoded 395 ms after …`.
- An undecodable frame takes the same path (the old code requested once and
  waited for the periodic keyframe if that request was coalesced away).
- Diagnostics for what is not the network: a pause of ≥ 200 ms between
  arriving frames (beyond 3× the track's own cadence, so a still screen at
  1 fps is not logged every second), a decode or a hand-off to the surface that
  holds the worker ≥ 100 ms.

Reference-frame-aware decoding: the AV1/VP9 encoders here run without temporal
layers (every frame is a reference), so there is no non-reference frame to skip;
a gap is always a broken reference and is treated as one.

The relay coalesces keyframe requests per `(publisher, stream, track, layer)`
for 250 ms (was per track for 500 ms, and a coalesced request was dropped with
nothing behind it). Per layer, so a layer switch's request is never swallowed by
a recovery request for the old layer; 250 ms is under the viewer's 300 ms
re-ask, so a re-ask always goes through. Every forwarded request is logged at
info, every coalesced one at debug. V2's "key landed, ask for a keyframe, ask
again 350 ms later" fits this window.

The sender logs each keyframe request it receives and forces a keyframe on
every simulcast layer's next frame (per-layer forcing would touch V3's encoder
API; the relay's coalescing bounds the cost).

### 3. Periodic keyframes in real time (`screen_keyframe_interval`)

The periodic keyframe was a frame count, `fps × 4` at the preset's rate (240
frames: 8 s at the ~30 fps the 60 fps presets encoded). It is now a wall-clock
timer in `begin_screen_frame`: 2 s, 3 s for film content (the Movie presets),
restarted by any requested or reconfiguration keyframe; the codec GOP stays
only as a 10 s backstop. Recovery does not wait for it (section 2).

### 4. Layer switches: at a keyframe of the target layer, on a fresh decoder (B4)

- Viewer: a keyframe of another simulcast layer recreates the track's decoder
  instance before it is decoded, and so does the first keyframe after the
  track's announced resolution changed (the old code dropped the instance the
  moment `TrackLayers` arrived, under the frames already in flight). Logged:
  `native-decode: decoder recreated at keyframe 2195 (layer 1 -> 2)`. The Linux
  surface already reallocates its textures when the frame size changes.
- Relay: a viewer that re-subscribes with another layer (Viewing quality, a
  resize) keeps receiving its current layer, and the new one is staged for its
  next keyframe and asked for (`subscribe_track` returns the staged layer; it
  used to flip `active_layer` mid-GOP). Relay-driven switches were already
  keyframe-gated.

### 5. Viewing quality (B5)

- `requested_layer` is the viewer's ceiling: Low = layer 0, Medium = 1,
  High = 2 (the top), resolved onto the ladder the publisher actually has. The
  relay's selection (`compute_target_layer`) caps at it instead of at the
  viewport (the viewer chose), and still steps below it for bandwidth or loss.
  Before, the relay ignored it after the first subscribe and climbed one rung
  at a time on its own, which is why Low showed medium and Medium showed top.
- Source is `SOURCE_LAYER` (255, `paracord-transport`): the top layer, pinned,
  no viewport or bandwidth cap. High is the top layer as a ceiling.
- The engine no longer sends its own viewport-derived layer as a request (that
  capped every Auto viewer at what the tile size suggested at subscribe time),
  except for a sampler (no tile: the lowest layer). The viewer's choice is
  remembered per track (`requestedLayers`), so a tile resize, which
  re-registers with the viewport only, no longer drops it back to Auto.
- A layer costs what the relay measures arriving on its SSRC (+25%), never more
  than its advertised cap (`LayerCosts`, `BandwidthEstimator::ssrc_ingress_kbps`).
  The cap of Movie 100's top layer is 100 Mb/s, which no estimate (clamped at
  100 Mb/s, 85% budget) ever fit, so every Movie 100 viewer got 1280x360.
- Upswitch hysteresis: a layer lost to loss comes back only after the 5 s
  headroom hold on a path under 0.5% loss (`UPSWITCH_MAX_LOSS_RATIO`). At 1%
  netem loss the relay's windowed loss read 2 to 15%, and the viewer
  oscillated 2→1→0→2 every few seconds, each switch a keyframe and a fresh
  decoder (0.5 to 1.5 s freezes, 5 recoveries in a 10 s phase). After: no
  oscillation, no recoveries.

### 6. Mid-stream changes

- Reconfiguration forces a keyframe (it already did) and viewers switch at it
  (section 4).
- A change that adds a simulcast layer (V3's ladders: 720p30 now has two
  rungs, 1080p60 three) left the new layer's SSRC without the track's key; the
  encode thread stopped on `NoKeyForEpoch` and every viewer got nothing. The
  track key is now installed on the new layers when the published track changes
  (`begin_screen_frame`/`begin_camera_frame`).

### 7. "Reconnecting video…"

The decode worker's watchdog (every 100 ms): a visible surface that has shown
its first frame and presented nothing for 1 s (or 3× the track's cadence, for a
still screen) emits `media_native_render_stalled` with the reason (waiting for
a keyframe, how long, how many requests; or no video from the relay; or frames
arrive but none present) and logs it; the next presented frame clears it. The
engine turns it into a `paracord:video-stall` event on the canvas, and
`StreamSurface` draws a quiet veil and "Reconnecting video…" over the frozen
frame (`data-video-stalled` on the box). V2's "stopped sharing" uses the same
box.

## Numbers

Final build, normal view, 5120x1412 viewer, synthetic 5120x1440 60 fps screen.
Freeze = longest interval between new frames on the viewer's surface. "Layer"
is what the viewer decoded.

| Preset | 0% loss | 1% | 5% | 10% |
|---|---|---|---|---|
| 1440p60 | 1653 ms¹ (2560x720) | source stopped² | 377 ms (1280x360) | 375 ms (1280x360) |
| 4K60 | 293 ms (2560x720) | 378 ms (2560x720) | 168 ms (1280x360) | 74 ms (1280x360) |
| Movie 50 | 988 ms¹ (2560x720) | 72 ms (2560x720) | 367 ms (1280x360) | 88 ms (1280x360) |
| Movie 100 | 77 ms (2560x720) | 362 ms (1280x360) | 79 ms (1280x360) | 161 ms (1280x360) |

Before (same lab, the starting tree): 0%: 6.5 s / 6.3 s / no picture / 5.5 s;
1%: 4.9 / 5.4 / 7.3 / 5.9 s; 5%: whole phase / whole phase / whole phase /
3.5 s.

¹ No frame was missing and none arrived late: the viewer window itself stopped
painting for ~1.5 s (its frame clock, see "What is left"). ² The synthetic
source stopped (the lab's pattern generator does not survive some capture
renegotiations).

Viewing quality, 1080p60 shared, Auto at 5120x1412 then each choice:

| Quality | Decoded | Freeze |
|---|---|---|
| Auto | 3840x1080 (top) | 370 ms |
| Low | 1280x360 | 711 ms (the switch) |
| Medium | 2560x720 | 72 ms |
| High | 3840x1080 | 89 ms |
| Source | 3840x1080 | 367 ms |

Auto at a 1920x1080 viewer window: normal view 2560x720, 57 frames/s, 117 ms
(was green, 0 readable frames); theater switches up to the top layer with a
~1 s gap at the switch (0.24 to 0.37 s of it the top layer's keyframe in
transit, the rest the fresh decoder and the layout change); 0 unreadable.

Mid-stream (theater): 720p30 → 1080p60 → 4K60 → Movie 100: 838, 347,
1645 ms (the last with a 1.67 s source gap); Movie 100 → 1440p60 → 720p30 →
Movie 100: 545, 151, 806, 315 ms; Movie 100 delivered at 5120x1440. The
sequence's first step (720p30 picked again right after the share started) was
315 ms in one run and a 6.4 s gap in another; that run's logs were not kept, so
its cause (source, window or pipeline) is not established.

## What is left

- **Window frame clock stalls.** Under load the viewer window stops painting
  for 1.5 s at a time (`[frame] … frozen=true` in the app log) while frames keep
  decoding and arriving; these are the remaining >300 ms gaps at 0% loss and
  the theater numbers. Render side (B8 / Route C), not transport.
- **An upswitch to a large top layer costs ~1 s**: the keyframe is paced out
  under a congestion window sized for the smaller layer, and a fresh NVDEC
  session decodes its first keyframe slowly. Keeping one decoder per layer
  would remove the second half.
- **Loss downswitches to the low layer.** The relay's loss reading counts QUIC
  lost packets, so 1% netem loss reads 2 to 15% and the viewer goes to
  1280x360 (spec §4.2: "downswitch on loss >2%"). With reliable delivery a
  lossy path no longer needs that; the threshold, or a loss signal that counts
  only what retransmission could not cover, is a follow-up.
- **Congestion control.** quinn runs Cubic. The lab's loopback has no real
  bandwidth-delay product, so this pass could not show how Cubic behaves on a
  lossy WAN at media rates; BBR is the usual answer for media over QUIC.
- **Browser viewers** of a native share now receive deltas on WebTransport
  uni streams (the large-delta path they already handled). Not run here.
- **Camera** shares the send path and recovery; not measured (no camera in
  the lab).
- The sender forces a keyframe on every layer for each (coalesced) request;
  per-layer forcing would need V3's encoder API.

## Reproduce

```sh
scripts/stream-audit/build.sh /tmp/sa-build
unshare -rn sleep infinity & NS=$!                       # the lab's own network
in() { nsenter --preserve-credentials -t $NS -U -n -- "$@"; }
in ip link set lo up
in env SA_APP=… SA_SERVER_BIN=… SA_DIST=… SA_GRAPH_A=v1-pwA SA_GRAPH_B=v1-pwB \
  scripts/stream-audit/env.sh up /tmp/sa-run
# loss on what the relay sends (its UDP port is the server port + 1):
in tc qdisc add dev lo root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
in tc qdisc add dev lo parent 1:3 handle 30: netem loss 5%
in tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 17 0xff match ip sport 18761 0xffff flowid 1:3
in node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan quick --phases normal \
  --presets 1440p60,4k60,movie-50,movie-100 --graph-a v1-pwA --tag l5-
in node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan layers --presets 1080p60 --graph-a v1-pwA
in node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan midstream --graph-a v1-pwA
in env SA_GRAPH_A=v1-pwA SA_GRAPH_B=v1-pwB scripts/stream-audit/env.sh down /tmp/sa-run; kill $NS
```

`--phases` (new) picks the layouts of a `quick`/`full` plan. The full
`analyze.py` is slow on hour-long probe logs on a loaded machine; the numbers
above come from the probe's `UP`, `DIN`/`DOUT` and `CAP` lines and the
pipeline's own `video-transport`/`video-recovery` lines in the app log.
