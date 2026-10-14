# Checkpoint: stream fix V6, transport safety, uplink adaptation, reorder window, final audit

Package V6 of the stream fix round, after V1 to V5 (`stream-fix-v1.md` …
`stream-fix-v5.md`). Branch `feat/stream-fix`, code commits `d78f5631` (items
1 to 3) and `4b4bbba6` (a re-share decoder fix the final audit found), on V5
`07304315`, 2026-10-14.

Machine: RTX 4080, driver 615.71.09, KWin 6.7.5. Every network test ran in a
private user + network namespace (`unshare -rn`): `tc` shaped only the lab's
own links, never the host. App runs: the stream-audit lab (private graphs
`v6-pwA`/`v6-pwB`, nested KWin only, `~/.config/kwinoutputconfig.json`
`e6df1573…` before and after every run). No other agent was active; the load
average before each run is in the run logs (0.5 to 7; 4 to 7 only right after
a build).

## Verdict

| Item | Result |
|---|---|
| 1. Congestion control | V5's controller (quinn's BBR with every loss withheld) was **not** a good citizen: a competing TCP flow got **0.6 of 20 Mb/s** behind a 100 ms queue and **0.7 of 50 Mb/s** behind a 20 ms queue, while the media flow lost 59 to 80% of its packets. V6 reads a loss as congestion only when a queue stands behind it and then cuts a Cubic-style cap: TCP keeps **7.6 of 20** and **29.2 of 50** (two runs each: 6.1 to 9.2 and 29.1 to 29.2; Cubic vs Cubic: 14.2 and 27.8), and 9.6 to 19.8 Mb/s on the other links; queueing delay is TCP's own (ping with both flows 121 / 128 ms p50 / p95, V5 119 / 122 by starving TCP), and 30 Mb/s of video still crosses **5% random loss** on both directions at 30.0 Mb/s. Not an even split everywhere: behind a 100 ms queue at 20 Mb/s the media flow takes 60%. |
| 2. Uplink adaptation | New send-side estimate from the share's own frame acknowledgements: a budget for all layers, the top layer gives up bitrate then is dropped (the relay moves its viewers down at once), a backlog sheds the top layer's queued frames, layers come back with headroom after a backoff. Through 10 / 20 / 50 Mb/s uplinks, Movie 50 and 1440p60 keep **54 to 60 decoded frames/s** with capture-to-screen p95 **164 to 463 ms**; V5 under the same limits showed **0.3 to 0.8 frames/s** with **2 to 10 s** of latency, and its 1440p60 did not recover in the 40 s after the limit lifted. V6 is back on the 5120x1440 layer within 5 to 25 s. |
| 3. Reorder window | 250 ms, widening to 400 ms when gaps take longer to fill. 5% loss on every leg (15 ms each way), 1440p60: **60.0 decoded, 54.1 unique on screen per second, 0 keyframe recoveries** in 40 s (V5 build in the same lab: 59.5, 52.0, 4 recoveries). At 0% loss the latency is unchanged (120 to 135 ms median both builds): the hold only waits while a frame is missing. |
| 4. Final audit | `stream-audit.md`, "After the fix round". The sender delivers every preset's size, frame rate and bitrate on 5120x1440, 1920x1080 and 3840x2160 screens; viewing qualities, mid-stream changes, re-shares (10 of 10, 0.5 to 1.0 s) and 0/1/5% loss on every leg all play. Still failing: theater and full screen at a 5120x1412 window (34 to 47 of 60 frames on screen: GTK 3, B8), Movie 100 to an Auto viewer on loopback (2560x720), the theater upswitch at a 1920 window (1.7 to 2.9 s), A/V offset +47 to +61 ms. Found and fixed: a re-share to a smaller preset was decoded green. |

## 1. Congestion control

### The lab (`scripts/stream-audit/cc`, new)

Three namespaces: the sender (A), a router (R) and the receiver (B). The
bottleneck is R's egress toward B: an HTB class at the link rate whose leaf is
a drop-tail netem queue of N ms at that rate; R's egress back to A carries the
round trip's delay. Segmentation offloads are off on every veth so the shaper
sees wire-sized packets (with them on, 64 KB TCP and UDP-GSO super-packets made
the queue limits meaningless; the first runs were discarded for it).

- `cc_lab` (`crates/paracord-transport/examples/cc_lab.rs`): a media-like
  QUIC sender, 60 frames a second at an offered rate (a keyframe 4x a delta
  every 2 s), one uni stream per frame as the app does, skipping frames while
  its oldest unacknowledged frame is over 500 ms old (a sender with no rate
  adaptation); `cubic`, `bbr` (quinn's), `blind` (V5) or `media` (what ships).
- `tcpbulk.py`: a Cubic bulk TCP flow (iperf3 is not installed).
- `ping -i 0.1` from A to B: the queueing delay every other packet sees.
- `scenario.sh`: TCP alone 10 s, then media with it 60 s, then media alone 15 s.
  `analyze.py` averages the 50 s with both flows.

The media flow offers more than the link (44 Mb/s into 20, 80 into 50), so
its share is the controller's alone to decide. Two runs per cell (one per
controller for the stock ones).

### What was wrong with V5

quinn's BBR (`BbrConfig`, the controller V5 wraps) has a bandwidth filter that
only ever grows (`max_filter.update_max` is called only for a sample larger
than the current maximum), so its window never shrinks to a competitor, and
quinn paces at window / RTT. Stock BBR still entered loss recovery; with every
loss withheld (V5) nothing bounded the window: 2 MB on a 20 Mb/s link, half
its packets dropped, the competing TCP flow starved.

### Design

`MediaCongestion` (`paracord-transport/src/congestion.rs`):

- **The model**: quinn's BBR with loss withheld, as in V5.
- **A cap that only congestion moves.** A drop-tail queue drops a packet
  when it is full, so a loss while the smoothed round trip (quinn's, the peer's
  acknowledgement delay taken out) stands more than `max(10 ms, floor / 4)`
  above the path's floor is congestion. It cuts a cap on the window to 0.7 of
  the window (0.9 when the loss event is a single packet), at most once per
  round trip; the cap grows back on Cubic's curve (RFC 9438, with its
  TCP-friendly floor and fast convergence) only while the window is in use, and
  is dropped once it no longer binds. A loss with the round trip at the floor
  is random: retransmitted, nothing else.
- **A longer path is not a queue.** The floor is quinn's minimum over the
  connection; a path whose round trip rose for good would read every random
  loss as congestion. When every second of the last 30 s had its least round
  trip above the floor by more than the threshold and those minima stayed
  within 5 ms (or a tenth) of each other, the floor rises to them. A
  competitor's queue fills and drains with its sawtooth and never qualifies
  (the lab's queue minima varied 57 to 99 ms over 10 s windows with TCP
  present).
- Every connection with losses logs, every 10 s, how many it read as
  congestion (with the queue it saw) and how many as random, and when the floor
  rises (`media congestion control: …`).

Tuning, at 20 Mb/s / 40 ms / 100 ms queue and 50 / 20 / 20 (TCP, media Mb/s):
cut 0.7 of what was in flight on every loss: 15.6 / 3.6 and 34.7 / 12.5;
0.8 or 0.85: no better (TCP 12 to 15 / media 4 to 7); cut from the window:
13.8 / 5.3; single-packet losses ignored: 7.8 / **11.1** and 15.6 / **30.8**
(now TCP is the one squeezed); single-packet losses at 0.9: 12.5 / 6.6 and
27.4 / 20.0. A paced sender's packets land in the last slot of a full
drop-tail queue more often than a bursty TCP flow's, which is why one cut per
loss left TCP two thirds.

The table rows are the shipped controller (`cc_lab` built from `d78f5631`,
two runs per link). The tuning runs above used an earlier queue measure (the
smallest raw round trip of the last round); with the smoothed round trip that
shipped, TCP's share moved from 11.9 to 7.6 of 20 Mb/s behind the 100 ms
queue and from 27.4 to 29.2 of 50 behind the 20 ms one.

Two first versions of the queue measure failed in the app lab and are not
what shipped: the largest raw round trip of the last round (a single delayed
acknowledgement at 5% loss read as a queue: the window collapsed to 6 to
13 kB) and the smallest (still raw); and the floor taken before the lab's
delay existed read every later loss as congestion, which the floor rise fixes
after 30 s.

### Numbers

TCP with media is the competing flow's rate while both run; "ping" is the
round trip of a 10 Hz ping through the same bottleneck.

**20 Mb/s, 40 ms round trip, 100 ms queue** (TCP alone: 19.1 Mb/s, ping 118.5 ms; idle 40 ms)

| Controller | TCP with media (Mb/s) | Media (Mb/s) | Ping with both, p50 / p95 (ms) | Ping, media alone (ms) | Media packet loss |
|---|---|---|---|---|---|
| quinn BBR | 4.2 | 14.4 | 121 / 125 | 101 | 0.5% |
| V5 (BBR, loss withheld) | **0.6** | 17.3 | 119 / 122 | 117 | **59.3%** |
| quinn Cubic | 14.2 | 4.9 | 132 / 139 | 84 | 0.1% |
| **V6** | **7.6** | 11.3 | 121 / 128 | **76** | 0.2% |

**50 Mb/s, 20 ms round trip, 20 ms queue** (TCP alone: 47.8 Mb/s, ping 34.8 ms; idle 20 ms)

| Controller | TCP with media (Mb/s) | Media (Mb/s) | Ping with both, p50 / p95 (ms) | Ping, media alone (ms) | Media packet loss |
|---|---|---|---|---|---|
| quinn BBR | 0.9 | 44.1 | 36 / 36 | 36 | 52.0% |
| V5 | **0.7** | 43.7 | 36 / 36 | 35 | **80.3%** |
| quinn Cubic | 27.8 | 19.9 | 36 / 39 | 30 | 0.1% |
| **V6** | **29.2** | 18.3 | 35 / 38 | 32 | 0.1% |

**50 Mb/s, 20 ms round trip, 100 ms queue** (TCP alone: 47.8 Mb/s, ping 99.9 ms)

| Controller | TCP with media | Media | Ping with both | Ping, media alone | Media loss |
|---|---|---|---|---|---|
| quinn BBR | 25.8 | 21.6 | 102 / 110 | 74 | 0.1% |
| V5 | 27.4 | 20.1 | 101 / 111 | 84 | 0.1% |
| quinn Cubic | 30.7 | 17.3 | 108 / 118 | 82 | 0.0% |
| **V6** | 19.8 | 27.4 | 100 / 108 | 82 | 0.0% |

**20 Mb/s, 30 ms round trip, 300 ms queue (bloated)** (TCP alone: 19.1 Mb/s, ping 274 ms)

| Controller | TCP with media | Media | Ping with both | Ping, media alone | Media loss |
|---|---|---|---|---|---|
| quinn BBR | 10.9 | 8.1 | 276 / 302 | 69 | 0.1% |
| V5 | 9.8 | 9.2 | 270 / 299 | 71 | 0.3% |
| quinn Cubic | 13.7 | 5.4 | 283 / 326 | 169 | 0.3% |
| **V6** | 9.6 | 9.2 | 272 / 296 | 72 | 0.1% |

With TCP present the queue is TCP's: no controller can keep the ping below
TCP-alone's (118 / 35 / 100 / 274 ms), and V6 adds 0 to 3 ms to it. Alone,
V6's own queue is under BBR's or near it: +36 ms on the 100 ms queue at
20 Mb/s (BBR +61, V5 +77), +62 at 50 Mb/s (BBR +54), +42 behind the 300 ms
queue (BBR +39), +12 behind the 20 ms one.

**Random loss** (50 Mb/s, 30 ms, 100 ms queue, 30 Mb/s of video offered, no
competing flow, loss on both directions):

| Controller | 0% | 1% | 5% |
|---|---|---|---|
| quinn BBR | 30.0 Mb/s, p95 16 ms | 30.0, 44 ms | 30.0, 77 ms |
| V5 | 30.0, 16 ms | 30.0, 42 ms | 30.0, 78 ms |
| quinn Cubic | 30.0, 16 ms | **4.5, 2.3 s** | **1.8**, frames stop |
| **V6** | 30.0, 16 ms | 30.0, 41 ms | 30.0, 70 ms |

(p95 is the frame's one-way delay at the receiver.) In the app lab, 5% loss
on every leg with 15 ms each way: the 5120x1440 layer held at 60.0 decoded
frames/s (section 3).

**Not covered**: an AQM bottleneck (fq_codel/CAKE: no standing queue, so
congestive drops read as random and V6 behaves as V5 would; those queues bound
everyone's delay themselves, but the share against TCP there is not measured),
ECN, and bottlenecks with non-drop-tail policers.

## 2. Uplink adaptation

### What was wrong

The relay's uplink estimate falls only on sequence gaps, which reliable frames
never leave, so the encoder kept its preset on any uplink; a share through a
narrow uplink queued in the sender's QUIC connection (and in an unbounded set of
per-frame send tasks), and every viewer fell seconds behind and froze.

### What changed

`client/src-tauri/src/native_media/uplink.rs` (new) and `video_pipeline.rs`:

- **Measured from the share's own frames.** Each screen frame's stream is
  followed to the relay's acknowledgement of all of it
  (`SendStream::stopped`). Over 2 s: what was sent, what the relay acknowledged,
  and the backlog (unacknowledged bytes, in ms at the acknowledged rate).
- **Not keeping up** when, for a second on end, the relay acknowledged under
  92% of what was sent with more than 200 ms waiting, or more than 600 ms waited
  either way. Random loss does neither over 2 s (a resent frame is
  acknowledged a round trip or two late); a keyframe's burst clears inside the
  second. (A first version judged by the oldest frame in flight: at 5% loss
  there is always a frame waiting for a resend, and it walked a 44 Mb/s share
  down to its lowest layer on a clear uplink.) No decision in a share's first
  3 s.
- **Budget**: 85% of what the relay acknowledged, not again for 1 s; after
  3 s with under 100 ms waiting it climbs 8% a second to the preset, and stops
  climbing before it builds a queue.
- **Layers** (`allocate_layers`): the top layer gives up bitrate first, down to
  1.5x the layer below it, then is dropped; then the next one. A dropped layer
  is unpublished (`TrackLayers` without it), so the relay moves its viewers to
  the layer below at that layer's next keyframe at once
  (`restage_viewers_off_unpublished_layers`; it used to wait for the 2 s
  re-evaluation with no picture), and the sender forces that keyframe. A layer
  comes back only with 25% to spare, not for 10 s after it was dropped, doubling
  to 80 s each time it is dropped again within 20 s of returning
  (`LayerGate`); without that, Movie 50's top layer on a 20 Mb/s uplink came
  back and was dropped every ~10 s. It comes back from a keyframe.
- **A backlog over 1 s for half a second** sheds the highest layer still sent:
  its queued frames' streams are reset (they hold up everything behind them and
  are worth nothing late) and it skips frames until the backlog is under
  300 ms, then resumes from a keyframe.
- Lower layers get higher QUIC stream priority on the uplink.
- `SimulcastEncoder::set_layer_bitrate` (codec): any layer retargets, not only
  the top one (the highest layer still sent is not always the top).
- Logged: every budget change with its numbers ("the uplink is not keeping up:
  over the last 2 s the relay acknowledged 7955 of the 9525 kbps sent, with
  955 ms (949 kB) waiting; budget 7304 -> 6761 kbps"), every layer dropped or
  restored, every shed, each layer's bitrate change, and the uplink state in the
  5 s encoder report. The relay's own estimate still limits the top layer as
  before (V3's rule); the lower of the two applies.

### Numbers

`scripts/stream-audit/uplinkstep.sh` (new): 15 ms each way on every leg to and
from the relay from before the share starts; the steps add an HTB rate class
with a ~100 ms drop-tail queue on the sender's uplink only. Viewer at
5120x1412, normal view, 40 s per step, the same lab and steps for both builds.
"Backlog" is the largest the sender reported in the step.

**Movie 50** (5120x1440, 44.4 + 7 + 1.6 Mb/s of layers):

| Uplink | V5: decoded/s, unique/s | V5: capture to screen, med / p95 | **V6: decoded/s, unique/s** | **V6: capture to screen** | V6 layer | V6 backlog |
|---|---|---|---|---|---|---|
| unlimited | 59.4, 55.3 | 119 / 138 ms | 60.0, 56.1 | 135 / 149 ms | 5120x1440 | 68 ms |
| 10 Mb/s | **0.7, 0.7** | **769 / 7801 ms** | **54.1, 47.9** | **127 / 329 ms** | 1280x360, then 2560x720 | 231 ms |
| 20 Mb/s | 0.3, 0.3 | 3981 / 6764 | 58.9, 54.9 | 122 / 187 | 2560x720 | 824 ms |
| 50 Mb/s | 0.6, 0.6 | 2066 / 3748 | 58.7, 54.8 | 147 / 463 | 2560x720, then 5120x1440 | 315 ms |
| unlimited again | 58.5, 54.6 | 120 / 141 | 60.0, 55.4 | 131 / 148 | 5120x1440 | 68 ms |

**1440p60** (5120x1440, 36 + 7 + 1.6):

| Uplink | V5: decoded/s, unique/s | V5: capture to screen | **V6: decoded/s, unique/s** | **V6: capture to screen** | V6 layer | V6 backlog |
|---|---|---|---|---|---|---|
| unlimited | 60.0, 54.7 | 130 / 152 ms | 60.0, 55.6 | 120 / 136 ms | 5120x1440 | 92 ms |
| 10 Mb/s | 0.8, 0.7 | 3970 / 10178 | 53.9, 46.9 | 134 / 298 | 2560x720 | 767 ms |
| 20 Mb/s | 0.4, 0.3 | 3385 / 6638 | 60.0, 55.9 | 120 / 164 | 2560x720 | 94 ms |
| 50 Mb/s | 0.4, 0.4 | 1647 / 4606 | 56.2, 52.3 | 119 / 281 | 2560x720, then 5120x1440 | 127 ms |
| unlimited again | **1.0, 0.0** (not recovered) | 1723 | 60.5, 53.7 | 120 / 139 | 5120x1440 | 92 ms |

V6's longest gap in a step was 2.5 s (the onset of the 10 Mb/s limit: the
backlog the first second built is shed, and the viewer switches to the layer
below at a keyframe); 0.4 to 1.4 s at the other steps; 0 to 4 keyframe
recoveries per 40 s step. At 20 Mb/s the 5120x1440 layer stays off: with the
other layers it needs 19.1 Mb/s, and it comes back only with 25% to spare.

**Not measured**: a real ISP uplink, the camera (it still has no relay or
uplink feedback), a VAAPI/QSV sender (the retarget path is per layer there
too, untested), and Windows/macOS senders (same code, untested).

## 3. Reorder window

`video_pipeline.rs` `ReorderHold`: the hold is 250 ms, and 1.5x the slowest gap
that filled in the last 30 s plus 30 ms when that is longer, up to 400 ms. A
frame that arrives after the hold gave up on it counts as a gap that filled
that late. Changes are logged (`video-transport: reorder hold 250 -> 400 ms
(…)`, `frame N arrived X ms after the frame behind it, after the reorder hold
gave up on it`). A first version also shrank to 150 ms on quick fills; a clean
path reorders frames by a few milliseconds, the hold shrank, and the first
retransmission when loss began overran it (a keyframe recovery for a frame
337 ms late), so 250 ms is the floor.

The hold only delays a frame while an earlier one is missing; in order, frames
pass straight through.

1440p60 from a 5120x1440 screen, viewer 5120x1412, 15 ms each way on every leg
from before the share, loss on every leg, 40 s per step:

| Loss, every leg | V5 build: decoded/s, unique/s, recoveries | **V6: decoded/s, unique/s, recoveries** | V6 capture to screen, med / p95 |
|---|---|---|---|
| 0% | 60.0, 54.5, 0 | 60.0, 54.9, 0 | 132 / 147 ms |
| 5% | 59.5, 52.0, **4** | **60.0, 54.1, 0** | 126 / 154 ms |
| 1% | 60.0, 48.9, 0 | 60.0, 53.1, 0 | 121 / 137 ms |
| 0% again | 60.0, 52.4, 0 | 59.7, 55.8, 0 | 129 / 144 ms |

The V5 build did better here than in V5's own runs (45 decoded/s, 35
recoveries at 5%): V5 applied the 15 ms delay together with the loss, after the
connection had started; the relay's frame priorities (V5) mean a gap is rare
once the path is steady. V6's hold never had to widen in these runs.

## 4. Final audit

`stream-audit.md`, section "After the fix round" (the table there, with the
audit's first numbers beside it). Sets: every preset on a 5120x1440 screen at a
5120x1412 window (rest, theater, full screen, four UI motions), viewing
qualities, mid-stream changes, stream audio, re-shares, a 1920x1080 window,
1920x1080 and 3840x2160 screens, and 0/1/5% loss on every leg; one run
directory per set, each from a fresh environment. Phases the lab's synthetic
screen stalled in (`pattern.py` stops after `gst_buffer_is_writable`
assertions; the sender logs "the encoder took 0.0 captured frames/s") were
rerun in a fresh environment, except 4K60 full screen on the 3840x2160 screen
(stalled twice) and Movie 100 at the 1920x1080 window.

**Found and fixed** (`4b4bbba6`): a viewer still watching when the sharer
switched from a larger preset to a smaller one (1440p60 or Movie 100, then
720p30) saw a green and magenta picture for as long as the share ran (3.9
readable frames a second): both ladders' top layer is "high", the new share
reused the 5120x1440 decoder, and `unbind_remote_video_track` had forgotten
the size that would have flagged it. The V5 build does the same. A share that
ends now marks the track's decoder for recreation at the next share's first
keyframe (`unbind_remote_video_track`; test in
`negotiated_quality_resize_recreates_decoder_with_the_new_cap`). After:
1440p60 → 720p30 → Movie 100 → 720p30 → 1080p60 → 1440p60, 29.8 to 58 unique
frames a second at every step, decoder recreated at each.

Lab: `campaign.mjs` presses a call control the chrome hid (it timed out
waiting for "Leave theater" and aborted the run, three times); `reshare.mjs`
knows V5's Movie labels.

## Lab tooling

- `scripts/stream-audit/cc/` (`netns.sh`, `scenario.sh`, `matrix.sh`,
  `analyze.py`, `tcpbulk.py`) and `cc_lab` (paracord-transport example):
  section 1.
- `scripts/stream-audit/uplinkstep.sh`: the sender's uplink alone, rate and
  loss, the other legs delayed; `SA_UPLINK_SHAPER=netem` for netem's own rate
  limiter, `SA_OTHER_LEGS_LIMIT` for the other legs' queue.
- Changing a netem qdisc under a running share (delete and add) flushes what it
  holds: a loss burst on every leg. The V5 build never recovered from one in
  this lab (0.1 frames/s from then on: its relay's loss-blind window overflowed
  the 1000-packet netem queue, 13 to 19% loss toward the viewer, frames 2 to
  6 s late); V6 did. The scripts now change netem in place, and the lab's
  delay is in place before the share starts.
- `env.sh down` leaves the namespace's server running (V5's note); it was
  stopped by hand each time.

## Gates

`cargo fmt --all`; `cargo clippy --workspace -D warnings`; `-p
paracord-desktop --all-targets`, `-p paracord-codec --features lavc,vpx
--all-targets`, `-p paracord-transport --all-targets`, `-p paracord-relay
--all-targets` (all `-D warnings`); Windows cross clippy `-p paracord-desktop`
(only the pre-existing `windows_h264.rs` and `screen_capture.rs` warnings);
tests: `paracord-relay` 157, `paracord-transport` 123 + 6, `paracord-codec`
153, `paracord-desktop` lib 270 (2 ignored). No client (TypeScript) changes.

## What is left

- The audit's remaining failures (`stream-audit.md`, "Still failing").

- An AQM bottleneck (no standing queue) is not covered by the loss classifier;
  fq_codel/CAKE isolate flows themselves, but it is not measured.
- A path whose round trip rises mid-call is read as a queue for 30 s (losses
  in that time cut like Cubic's) before the floor rises.
- At a 10 Mb/s uplink the onset costs a ~2.5 s gap (the first second's backlog
  is shed, then a keyframe of the layer below); a budget probe that overshoots
  shows as p95 latency up to ~0.3 to 0.5 s in the step.
- 20 Mb/s does not carry Movie 50's or 1440p60's 5120x1440 layer with the
  others (needs 19.1 Mb/s and 25% headroom): those viewers get 2560x720.
- The camera has no uplink adaptation.
