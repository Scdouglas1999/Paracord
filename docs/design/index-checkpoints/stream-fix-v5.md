# Checkpoint: stream fix V5, follow-ups (layer pricing, presets, quiet notifications, camera encoder, window stalls, a test)

Package V5 of the stream fix round, after V1 to V4 (`stream-fix-v1.md` …
`stream-fix-v4.md`). Branch `feat/stream-fix`, 2026-10-13.

Machine: RTX 4080, driver 615.71.09, KWin 6.7.5, the stream-audit lab
(`scripts/stream-audit`) inside a private user + network namespace (`unshare
-rn`), so `tc netem` shaped only the lab's own loopback. Private graphs
`v5-pwA`/`v5-pwB`, nested KWin sessions only; `~/.config/kwinoutputconfig.json`
was `e6df1573…` before and after every run. The box was quiet (load average
2 to 7: other agents idle) except where a run says otherwise.

## Verdict

| Item | Result |
|---|---|
| 1. Layer pricing | Viewers stay on the top layer at 1% and 5% real loss, on the relay's egress and on every leg at once, and go down only under a real rate limit (25 and 15 Mb/s): to the layer that fits, then back up once the limit is gone. Needed two changes: the relay prices layers on frames that arrive late, and every media connection now runs a congestion controller that does not read random loss as congestion. |
| 2. Presets | Movie: "Movie (up to 50 Mbps)" / "(up to 100 Mbps)", the stated bitrate on any screen. A preset that sends the same picture as a smaller one on a screen uses that one's settings, and the menu says "Same as 1440p on this screen". |
| 3. Notifications while sharing with sound | Silent (Linux: `suppress-sound`; already silent on Windows and macOS); the popup stays; the sound is back when the share ends or has no sound. |
| 4. Camera encoder | One upload for all layers (the screen's shared encoder), a bitrate change retargets the running encoder: 0.001 ms on the encode thread, where the old route rebuilt the GPU pipeline in 268 to 297 ms. |
| 5. Window stops painting | **Not our code.** An independent 160x160 EGL client in the same nested KWin stalls at the same instants for the same time (29 of 30 stalls matched); a nested KWin with nothing but that client stalls too (130 to 170 ms quiet, up to 290 ms under CPU load). |
| 6. `CallSheet` "a short drag springs back" | The release speed came from jsdom's `Date.now()` event stamps: a 60 px drag read as a 60 px/ms flick whenever a millisecond boundary fell between press and move. The test now sets its own pace; a flick test was added. |

## 1. Layer pricing

### What was wrong

**The relay's loss reading.** Layers were priced on the viewer connection's
QUIC loss (`lost_packets / sent_packets` over 5 s): over 2% stepped a viewer
down at once, and any loss over 0.5% blocked the way back. Every native video
frame rides a reliable stream (V1), so a lost packet is retransmitted and its
frame arrives a little late, and QUIC's count reads high. Before (relay at HEAD
`cfb3cb24`), 1440p60 from a 5120x1440 screen, viewer at 5120x1412 in normal
view, 15 ms one-way delay on what the relay sends:

| Relay egress | Layer the viewer got | Decoded/s | Longest gap |
|---|---|---|---|
| clean | 5120x1440 | 60.0 | 360 ms |
| 1% loss | 2560x720 within 5 s | 57.9 | 1213 ms |
| 5% loss | 1280x360 | 58.3 | 706 ms |
| 25 Mb/s rate limit | 1280 → 2560 → 5120 (back up into the limit at the end) | 47.1 | 2670 ms |
| clean again | 2560 → 1280 → 5120, ~20 s | 57.4 | 915 ms |

**The transport under it.** With pricing fixed (first version below) the
viewer still lost the top layer at 1% loss: its frames really were late.
quinn's default congestion controller is Cubic, which halves on loss; at 1%
random loss and a 30 ms round trip it carries ~8 Mb/s, whatever the path
holds. The relay correctly saw frames queue behind it. On the uplink the same
thing was worse: with 1% loss on every leg the 44 Mb/s three-layer share
reached viewers at **3.9 frames a second** (5%: **0.1**, one frame in 10 s).

quinn's BBR (`BbrConfig`, a port of quiche's BBRv1) fixed loss on one leg at a
time but not on all legs at once: on any loss it enters "packet conservation"
(window = what is in flight) and leaves only after a loss-free round trip.
Random loss on both directions keeps it there, and a media sender is
app-limited, so the window shrank to ~3.5 Mb/s and a keyframe could not get
through for seconds (two runs: a 5.1 s freeze, then ~25 s on the lowest layer).

### What changed

**`paracord-relay/src/delivery.rs` (new): does this viewer get its frames in
time?** Per viewer connection, from the relay's own send tasks:
- each frame's time from hand-off to the viewer's acknowledgement of all of it
  (`SendStream::stopped` → `Ok(None)`), against the fastest delivery in the last
  10 s (the path's floor);
- frames dropped in flight: shed past the in-flight cap, or superseded by a
  keyframe after waiting more than 200 ms;
- the age of the oldest frame still in flight;
- the rate the viewer actually took frames at.

Congested over the last 2 s when any frame was dropped in flight, when 10% or
more of the frames (at least 10) were acknowledged more than **200 ms** after
the floor, or when a frame has been in flight more than 400 ms past it. A
retransmission costs about one round trip, well inside that.

**`compute_target_layer` (relay.rs):**
- **Down** only on that congestion, never on loss or on the cwnd/RTT estimate
  alone (an app-limited or lossy path reads low while delivering every frame):
  one rung, or further when the rate the viewer took frames at fits only a
  lower layer (cost ≤ 85% of it). Then 3 s to settle (the step lands at the
  lower layer's keyframe and the old layer's backlog drains), keeping the staged
  step.
- **Back up**: the layer left is backed off 10 s, doubling (to 80 s) each time
  a probe of it fails within 20 s. After a step down the relay *probes* once
  the backoff is over and frames have arrived in time for 5 s: after the step
  the connection carries only the lower layer, and the estimate of an
  app-limited path reads what it carries, so on a lossy path with a real round
  trip it never showed room for the layer left. A viewer that never met
  congestion still goes up by the estimate (≥125% of the target's cost for 5 s).
- Each decision logs the evidence (`frames`, `late`, `unsent`,
  `delivered_kbps`, `floor_ms`, the reason); a congested window logs at info
  (`relay: this viewer's frames are not arriving in time: …`). QUIC loss is
  still logged, as information.

**Relay egress (relay.rs `InflightStreamFrames`, `send_stream_frame`):**
- A keyframe no longer aborts a *younger* keyframe in flight on its SSRC
  (`KEYFRAME_SUPERSEDE_AFTER`, 1 s): on a lossy path the viewer asks for a
  keyframe every 300 ms and a 5120x1440 keyframe took about that long to land,
  so each new one aborted the one about to fix the picture. Deltas are still
  superseded.
- Frame streams get descending QUIC priorities (each one below the last, all
  below control streams): a backlog drains oldest first instead of quinn
  round-robining every frame in it.

**`paracord-transport/src/congestion.rs` (new): `MediaCongestion`**, used by
the relay's endpoint and by every client endpoint (`endpoint.rs`): quinn's BBR
with loss events withheld. BBR's model (bottleneck bandwidth from the delivery
rate, round-trip floor, window = gain × BDP, pacing at the measured rate)
without the conservation window. Lost packets are still detected and
retransmitted; only the controller's reaction is removed. A real bottleneck
still caps it (rate-limit rows below).

### After

Same lab, final build. "Every leg" = 15 ms delay and loss on what the relay
sends **and** on what reaches it (the sender's uplink and the viewer's acks).

| Network | Layer the viewer got | Decoded/s | Unique on screen/s | Longest gap |
|---|---|---|---|---|
| clean | 5120x1440 | 59.9 | 52.6 | 710 ms¹ |
| 1% loss, every leg | **5120x1440** all 40 s | 59.5 | 45.1 | 6371 ms¹ |
| 5% loss, every leg | **5120x1440** all 40 s | 45.0 | 39.3 | 435 ms (p99 342) |
| clean again | 5120x1440 | 60.0 | 57.3 | 159 ms |
| 25 Mb/s on the relay's egress | 2560x720 within 2 s; H probed after 10 s, failed, then 20 s | 53.9 | 49.3 | 2225 ms² |
| 15 Mb/s | 2560x720 | 53.5 | 48.9 | 3370 ms² |
| clean | back to 5120x1440 after ~15 s | 58.8 | 55.0 | 870 ms |
| 1% loss + 25 Mb/s | 2560x720 | 50.6 | 45.8 | 2511 ms² |
| clean | 5120x1440 after ~10 s | 58.8 | 55.3 | 931 ms |

Egress-only loss with the relay on stock BBR (before the loss-blind wrapper):
1%: 5120x1440, 60.0/s, 363 ms; 5%: 5120x1440, 60.0/s. Uplink-only and
viewer-ack-only loss at 1% and 5%: 5120x1440, 60/s, 170 to 810 ms.

¹ The viewer's window, not the stream: the 6.4 s gap is one frame callback the
compositor answered 6368 ms late (`[frame] answer … asked …`) while 382 frames
decoded (section 5). ² At the step itself: the lab's netem queue holds 4000
packets (~2.5 s at 15 Mb/s) of bufferbloat, plus the failed probe of H.

**What is left.**
- At 5% loss on every leg the top layer holds, but a frame retransmitted twice
  (loss on the data and on its ack) misses the viewer's 120 ms reorder hold
  (V1's `video_pipeline.rs`): 35 keyframe recoveries in 40 s, 45 decoded and
  39 unique frames a second. A hold of ~250 ms would cover it, at that much
  more latency on a gap; V1's call.
- The publisher's bitrate does not follow a limited **uplink**: the relay's
  uplink estimate only falls on sequence gaps, which reliable frames do not
  leave (V3 retargets only on a falling estimate). A share sent through a
  narrow uplink queues at the sender. Not measured here.
- A probe of a layer the downlink cannot carry costs a keyframe and ~0.5 to
  2 s of late frames, every 10/20/40/80 s while the limit lasts.
- `MediaCongestion` wraps quinn's experimental BBR. On a shallow-buffer
  bottleneck a loss-blind sender loses more packets than Cubic would; the
  relay's frame-lateness pricing then moves the viewer down.

## 2. Presets (owner decisions)

- **Movie keeps its stated bitrate on any screen** (`resolve_screen_preset`,
  `paracord-codec/src/video/mod.rs`): no pixel scaling for the Film hint. 50 Mb/s
  on a 5120x1440, a 3840x2160 and a 1920x1080 screen alike (unit-tested). The
  menu reads **"Movie (up to 50 Mbps)"** and **"Movie (up to 100 Mbps)"**: the
  encoder runs CBR at the target and spends less on a picture that holds less
  (V3: 68 of 88.9 on sparse 32:9 content).
- **A preset that collapses onto a smaller one uses its settings.** For the
  four standard presets (`STANDARD_SCREEN_PRESETS`, mirrored by the client's
  `STANDARD_SHARE_SIZES`): when a smaller standard preset sends the same size
  at the same frame rate on this source, the request takes that preset's
  bitrate and content hint. On 5120x1440, "4K" = "1440p" (36 Mb/s, detail, not
  24.9 Mb/s motion); on 1920x1080, "1440p" and "4K" = "1080p" (12 Mb/s); 720p30
  stays its own (30 fps); a 3840x2160 screen has no collapses. The codec's size
  limit counts (H.264 sends 4096x1152 for both on 5120x1440). The encoder log
  says so ("the same picture as 1440p on this source, so 1440p's settings").
- **The menu says it.** Under a collapsing row: "Same as 1440p on this screen"
  (the display the app is on, before a share) or "… on the shared screen" (the
  size the encoder was configured for, from a new `media_screen_share_source`
  event; `lib/media/shareSource.ts`). One line, only on rows that collapse. The
  menu's note: "Each size is a height: a wider screen keeps its shape, and a
  screen with fewer lines sends its own size. The bitrate follows the picture,
  except Movie, which keeps its own."

## 3. Quiet notifications while sharing with sound

V4 kept the app's own sounds out of the stream; an OS notification's sound is
played by the desktop's notification service, outside the app's process tree,
so it was captured with everything else.

- `lib/features/notifications.ts`: while `selfStream && systemAudioCaptureActive`,
  a notification goes to the new `notification_show_quiet` command; otherwise
  through the notification plugin as before (so its sound is back as soon as
  the share ends or has no sound). A failure is logged, never replaced by a
  notification with sound. In a browser: `new Notification(…, { silent: true })`.
- `src-tauri/src/quiet_notify.rs`:
  - **Linux**: the plugin sets no sound hint, so the notification server plays
    its default. This sends the same freedesktop notification through
    notify-rust (the plugin's own dependency; `Cargo.toml` adds nothing to the
    graph) with `suppress-sound`.
  - **Windows and macOS**: through the plugin unchanged. Both are already
    silent: a Windows toast without a sound is sent with `<audio
    silent="true"/>` (tauri-winrt-notification), and a macOS notification
    without a sound name plays none (mac-notification-sys).
- Tests: `notifications.test.ts` (the routing, the restore, no fallback, the
  browser path), `quiet_notify.rs` (the hint, no sound name).
- Not checked on a live notification server: GNOME Shell honors
  `suppress-sound`; Plasma's server plays no sound for plain freedesktop
  notifications at all.

## 4. Camera encoder

- `video_pipeline.rs`: `build_simulcast_encoder` now builds both the camera's
  and the screen's encoder; on Linux H.264/AV1 that is V3's
  `LavcSimulcastEncoder` (one upload, split and scaled on the GPU, a thread per
  layer). The camera had one `LavcEncoder` per layer.
- A bitrate change retargets the running encoder: NVENC in place
  (`retarget_nvenc_in_place`, shared by the simulcast encoder and the
  single-layer `LavcEncoder`, whose `set_bitrate` used to rebuild the whole GPU
  pipeline, hardware device included, on every change: the path V2 saw crash
  inside `av_hwdevice_ctx_create`). VAAPI/QSV reopen that layer's codec context
  only (shared encoder); the single-layer `LavcEncoder` keeps its throttled
  rebuild there.
- The camera ladder's low rung runs at the source frame rate (was 15): every
  layer is fed every frame, and a layer's frame ids must stay consecutive for
  the viewer's gap detection, so a rung configured for 15 fps and fed 30 spent
  700 of its 350 kb/s. Same reasoning V3 applied to the screen's rungs.

`examples/camera_encode_bench.rs` (new; AV1 NVENC, a 1920x1080 30 fps synthetic
camera, 360 frames, the top layer's bitrate switched every 2 s between 2.5 and
1.0 Mb/s, every top-layer frame decoded again):

| | Encode thread per frame | A bitrate change | Top layer Mb/s per 2 s | Decoded again |
|---|---|---|---|---|
| Per-layer uploads (the camera before) | 10.39 ms avg, 16.11 max | **268 to 297 ms** (a new pipeline for the layer) | follows | 360 of 360, 0 errors |
| Shared upload (now) | **4.67 ms** avg, 5.26 max | **0.001 ms** | 3.9, 1.2, 3.37, 1.2, 3.37, 1.2 | 360 of 360, 1920x1080, 0 errors |

Not measured with a real camera: the lab has no video device (v4l2loopback
needs root, the real camera is off limits). The camera now runs the encoder
the screen share runs in every lab pass. The camera's top layer overshoots its
2.5 Mb/s ceiling (3.37 Mb/s in constant-quality mode, before and after); the
camera still has no relay feedback (its target never changes in a call today).

## 5. The viewer window stops painting

V1 and V3 saw the viewer window stop for ~1.5 s at a time under load
(`[frame] … frozen=true`). Measured with `PARACORD_FRAME_TRACE` and a new
probe client (`wlprobe`, scratchpad: a 160x160 EGL window that redraws every
compositor frame and logs each commit's `wp_presentation` latency):

- **The stall is the commit's presentation, not our paint.** Every long wait is
  a commit the compositor put on screen late (`commit … present +370 ms`); the
  paint before it took ≤ 60 ms (max over a 10 min run).
- **An independent client stalls at the same instants.** `wlprobe` in the
  viewer's nested KWin during a 5.5 min stream run: 33 probe stalls over 100 ms,
  30 app stalls over 100 ms, **29 of 30 at the same instant** (within 0.3 s),
  same lengths (app 781/720/373 ms, probe 782/715/373 ms).
- **Without Paracord.** A nested KWin (5120x1412 at 240 Hz, NVIDIA, as the lab
  makes them) with nothing but `wlprobe`, 60 s: stalls of 172 and 129 ms, and
  60 to 95 ms worst-case presentation in a normal 5 s window. With 22 busy
  loops on the 24 cores: up to 288 ms. With the stream stopped but the app
  open: 243 and 163 ms. With a stream playing: 150 to 375 ms (and the one 6.4 s
  wait above).

So the stalls come from the nested compositor on the GPU it shares with the
owner's session; Paracord's load (decode, upload, two KWins at 240 Hz) makes
them longer, as CPU load does. GTK 3's blend cost (B8) shows in the paint
times (≤ 60 ms) and in dropped frames during UI motion, not in these stalls. A
nested `kwin_wayland --virtual` is the only display the lab may use; whether a
real DRM output stalls the same way is not measured.

## 6. `CallSheet.test.tsx` "a short drag springs back"

`CallSheet` computes the release speed from the pointer events' `timeStamp`,
which jsdom fills from `Date.now()` (whole milliseconds). The test fired the
press and the move back to back: in the same millisecond the speed was 0
(spring back, pass); one millisecond apart it was 60 px/ms (a flick, dismiss,
fail). Load made the boundary likely, so the test "failed every time" while
other packages built. The code is right (a 60 px move in 1 ms is a flick); the
test now fakes `Date` and sets the drag's pace (60 px in 300 ms), and a new
test checks the flick (60 px in 40 ms dismisses). 3 of 3 runs pass, and the
full suite.

## Lab tooling

- `campaign.mjs --plan netsteps`: one share, the viewer at rest while
  `--net-cmd` reshapes the network before each of `--steps`, each held
  `--hold` s (README). The Movie labels, and option matching by prefix (a row
  can carry a "Same as" line).
- The shaping scripts and the frame/probe analysis used here are in the
  package's scratchpad (`netstep*.sh`, `netan.py`, `wlprobe/`).
- `env.sh down` leaves the instance's server running when it was started
  inside a namespace (its `pgrep` pattern starts with `-c`); it was stopped by
  hand each time.

## Gates

`cargo fmt --all --check`; `cargo clippy --workspace -D warnings`; `-p
paracord-desktop --all-targets -D warnings`; `-p paracord-codec --features
lavc,vpx --all-targets -D warnings`; Windows cross clippy `-p paracord-desktop`
(only the pre-existing `windows_h264.rs` and `screen_capture.rs` warnings);
tests: `paracord-relay` 156, `paracord-transport` 119 + 26, `paracord-media`,
`paracord-codec` 178, `paracord-desktop` lib 262; client `npm test`
(typecheck, 4925 unit tests, token and motion audits); eslint of the touched
files.
