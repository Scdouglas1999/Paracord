# Checkpoint: live-stream audit, every share setting, end to end (Linux desktop)

The owner: "we have all these different stream settings but if they're not
working in some way we need to know." This pass measured what each setting
actually delivers, stage by stage, from the sharer's screen to the pixels the
viewer's window hands the compositor. Product code was not changed. The
tooling is in `scripts/stream-audit/` (README there).

Tree: `b6c57f91` (feat/index-ui = main). Machine: RTX 4080, driver 615.71.09,
KWin 6.7.5, WebKitGTK 2.52.6. Date: 2026-10-13.

## Verdict

**Every share preset fails "delivers what it says".** The worst is that the
1440p and 4K presets mostly show a frozen or corrupted picture to the viewer.

| Setting (what the menu says) | What the sender encodes (5120x1440 screen) | What a viewer gets on screen (5120x1412 window, at rest) | Verdict |
|---|---|---|---|
| **720p 30fps** (default) | 1280x**360** at **25** fps, ~2.9 Mb/s | 25 frames/s, 97 to 100% of frames, 37 to 49 ms from capture to screen | FAIL: fps short (25/30); "720p" is 1280x360 |
| **1080p 60fps** | 1920x**540** at **32 to 37** fps, ~6 to 7.4 Mb/s | 34/s in normal view, but **20 to 26/s** in theater and full screen, with freezes up to **3.2 s** | FAIL: about half the frame rate; freezes |
| **1440p 60fps** | 2560x**720** at **30 to 33** fps, ~9 to 10 Mb/s | **8 to 24/s**, freezes up to **6.9 s** | FAIL |
| **4K 60fps** | 3840x**1080** at **28 to 30** fps, ~13 to 14 Mb/s | **1 to 4 frames/s**: the picture is **frozen for 5 to 8 s at a time** | FAIL: unwatchable |
| **Movie 4K (50 Mbps)** | 3840x1080 at 29 fps, **~17 Mb/s** (not 50) | **2 to 6 frames/s**, frozen for 5 to 7 s at a time | FAIL: unwatchable; the bitrate is a cap, not a rate |
| **Movie 4K (100 Mbps)** | 3840x1080 at 30 fps, **~18 Mb/s** (not 100) | The relay sends the viewer the **1280x360** layer: 27 to 30/s of a 0.46-megapixel picture | FAIL: the viewer does not get 4K |
| Viewing quality **Auto** | | Highest layer at 5120; at a 1920 window the relay **switches layer and the picture turns green** (below) | FAIL |
| Viewing quality **Low** | | Receives the **medium** layer, not low; the picture **turns green** | FAIL |
| Viewing quality **Medium** | | Receives the **high** layer (no change) | FAIL |
| Viewing quality **High / Source** | | Same layer (both map to layer 2) | Works; the two are one setting |
| Stream volume | | Not measured separately (audio arrived at 100%) | Not measured |
| Share quality changed **during** a share | Applied every time (new size, cap and fps in 1 to 3 s) | The viewer freezes for 3 to 6 s after each change; one change left the viewer **receiving nothing**; one sent it a **corrupted picture** | FAIL for viewers |
| Stream audio (computer's sound) | Captured | Present in every phase, but **~100 to 145 ms behind the picture**, and the sharer's **own app sounds leak into it** | FAIL (sync, leak) |
| Camera | Not measurable here | Not measured: see "Not covered" | n/a |

**Two problems outside the settings hit every viewer:**

- A viewer who watches with **Watch** and stays on it sees a **frozen picture that
  still says live** after the sharer stops and starts sharing again. This
  happened 18 out of 18 times. The picture never recovers; the viewer must
  leave and press Watch again.
- **The sharer's own app sounds are sent to viewers.** The webview's join and
  leave chimes and any other WebAudio go into the stream audio.

### Where each failure comes from

| Failure | Bottleneck | GTK 4 (graphics offload) fixes it? |
|---|---|---|
| 60 fps presets encode 30 to 37 fps | **Sender**: each simulcast layer uploads the full 5120x1440 frame to the GPU on its own (3 × 6.4 ms), plus the pacing gate | No |
| 720p30 encodes 25 fps; single-layer 1080p60 encodes 43 | **Sender**: the encoder's pacing gate | No |
| 1440p/4K/Movie-50 freeze for seconds | **Transport and decode**: frames lost or reordered, and the decoder runs on without its reference until the next keyframe, 6 to 8 s later | No |
| Picture turns green after a layer change (Auto at small windows, Viewing quality, Movie 100) | **Decode**: the decoder is not reset when the layer resolution changes | No |
| Movie 100 viewers get 1280x360 | **Relay** layer choice | No |
| Viewer frozen after the sharer re-shares | **Transport**: the watch session (likely its media key) is not renewed | No |
| Video frames dropped while the UI moves (64 to 89% of frames reach the screen in theater and chat-sheet toggles, even on working presets) | **Render/present**: the GTK 3 main thread blends a transparent window-sized webview every paint | **Yes** |
| Viewer CPU 44 to 62% at rest in theater at 5120, 126 to 142% while scrolling chat beside the stream | **Render/present** (the same GTK 3 blend) | **Yes**, mostly |
| Audio 100 to 145 ms behind the video | **Audio playout** | No |
| App sounds in the stream audio | **Sender audio routing** | No |

**GTK 4 fixes only the viewer-side render cost.** Everything that makes the
high presets unwatchable, and every frame-rate shortfall, comes before the
window: sender, transport and decode.

## How it was measured

Nothing ran on the owner's display, devices, keyring, router or LAN server.
After every stop, `~/.config/kwinoutputconfig.json` was the same file
(`e6df1573…`).

**The scene**
- **Instance.** A throwaway one from `scripts/live-env.mjs` on :18760, bound to
  loopback (so no router port mapping is attempted). Its data was in the run
  directory.
- **Accounts.** Vincent (sharer) and Sam (viewer), both one-password accounts.
  Sam watches with the room card's **Watch** (a view session), as a person
  watching without joining would.

**Both apps**
- Release `paracord-desktop` test builds: vpx on, no embedded UI, devUrl
  :1477 served by `audit-serve.mjs` with an in-page agent. The client build is
  the same tree.
- Each app runs in its own nested `kwin_wayland --virtual` on the RTX 4080
  (frame-timing gate's runner; GPU check PASS).
- Each app has a private HOME, a private activation-free D-Bus, and bwrap with
  no `/dev/snd` and the user's sockets covered.
- Each app has a private PipeWire graph: null nodes named `glass_g23_out` and
  `glass_g23_mic`, plus a pulse server on a private socket, plus a policy-only
  WirePlumber (no ALSA, Bluetooth or V4L2 monitors).
- **Viewer window.** Maximized at **5120x1412** on a 239.9 Hz output, and
  again at **1920x1080**.
- **Sender window.** 1600x900 at 60 Hz.

**The screen being shared.** `pattern.py`: a PipeWire Video/Source at
**5120x1440, 60 fps** (the owner's monitor):
- a scrolling, text-heavy page with a moving block;
- a band of bars carrying each frame's number;
- a 1 kHz tone burst every 2 s.

`fakeportal.py` answers the app's ScreenCast portal request with that node, so
the app's real capture path (scap → PipeWire) is what runs.

**Following each frame.** `probe.c`, preloaded into both apps, reads the frame
number wherever pixels are on the CPU and logs one line per frame at each
stage:
- PipeWire capture;
- encoder input and output for each simulcast layer, with each encoder's
  settings;
- decoder input and output;
- the native underlay's texture upload;
- the composited window frame the app hands KWin. This is a one-pixel column
  read back without stalling the paint, and matched to the app's own
  `wp_presentation` trace (`PARACORD_FRAME_TRACE`).

"Unique on screen" means distinct frame numbers in frames that KWin
presented.

**The rest:**
- **Relay.** Ingress counters from `/voice/{id}/media-stats` (it lists call
  members only, so the viewer's view connection is not in it).
- **CPU.** Every process and thread of each app, every 0.5 s.
- **GPU.** `nvidia-smi`.
- **Audio.** Burst onsets at the sharer's capture sink and at the viewer's
  output.

**Phases.** Each one lasted 10 s at rest or 12 s in motion:
- at rest: normal, theater, full screen;
- in motion: theater toggled every 1.5 s, the chat sheet toggled, the stream
  popover toggled, and the room chat scrolled beside the stream (600 px every
  300 ms).

Each preset started with a fresh share.

## Results

### Sender: requested vs encoded (5120x1440 screen, simulcast on, the default)

| Preset | Requested | Layers encoded (low / medium / top) | Top layer fps | Top layer Mb/s (cap) | Keyframes | Sender CPU |
|---|---|---|---|---|---|---|
| 720p30 | 1280x720, 30 fps, 5 Mb/s | 640x180, **1280x360, 1280x360** | **25** | 2.9 (5) | GOP 120 frames = 4.8 s at 25 fps | 65 to 73% |
| 1080p60 | 1920x1080, 60, 12 | 640x180, 1280x360, **1920x540** | **32 to 37** | 6 to 7.4 (12) | GOP 240 = 6.5 to 7.5 s | 120 to 130% |
| 1440p60 | 2560x1440, 60, 18 | 640x180, 1280x360, **2560x720** | **30 to 33** | 9 to 10 (18) | GOP 240 = 7.3 to 8 s | 106 to 114% |
| 4K60 | 3840x2160, 60, 28 | 640x180, 1280x360, **3840x1080** | **28 to 30** | 13 to 14 (28) | GOP 240 = 8 to 8.6 s | 93 to 103% |
| Movie 50 | 3840x2160, 60, 50 | same as 4K | 29 to 30 | **17.7** (50) | 8 s | 98 to 104% |
| Movie 100 | 3840x2160, 60, 100 | same as 4K | 29 to 31 | **18** (100) | 8 s | 114 to 122% |

**Encoder.** Every layer is `av1_nvenc` (hardware, picked because both apps
decode AV1). Settings: preset p6 (p5 above 1440p60), tune ull, rc vbr, cq 17
to 19 by content hint, a max-rate cap equal to the preset, no B-frames.

**The capture itself is fine.** It delivered 60.0 fps of the 60 fps source in
every phase. The capture thread costs ~44% of a core: it copies and swizzles
29.5 MB frames, 60 a second, even for 30 fps presets.

**NVENC and NVDEC are not the limit.** The GPU's encode engine was busy 2 to
8%, its decode engine 0 to 3%.

**Why the encoder misses its frame rate.**

- **Per-frame cost.** Each frame costs the encode thread 24 to 33 ms:

  | Step | Time |
  |---|---|
  | `av_buffersrc_add_frame` → filter graph → encoder input: `hwupload_cuda` of the full 5120x1440 BGRA frame, then `scale_cuda`, done **once per layer** | 6.4 ms each |
  | `avcodec_send_frame` | 1.7 ms each |
  | Three layers in sequence | ~25 ms |

  So 60 fps is impossible with three layers.
- **Simulcast off confirms it.** With simulcast off
  (`PARACORD_SCREEN_SIMULCAST=off`, one layer):
  - 1080p60 encodes **43 fps** and 4K60 **40 to 43 fps**, at half the sender
    CPU (50 to 60%);
  - capture-to-screen latency drops to 22 to 36 ms.
- **The pacing gate.** Even single-layer and with time to spare, 1080p60 only
  reaches 43 and 720p30 only 25 (single-layer 720p30: 24.3 to 24.9 fps). See
  bug B2.

**Each preset's resolution is a box the screen is fitted into.** On a
5120x1440 (32:9) screen:

| Preset | Encoded at | Pixels |
|---|---|---|
| "720p" | 1280x360 | 0.46 MP |
| "1080p" | 1920x540 | 1.0 MP |
| "4K" | 3840x1080 | 4.1 MP |

With the 720p30 preset, the medium and top layers are the same size: two
NVENC sessions for one picture.

### Transport (loopback, so no network loss)

**Sender to relay.** The relay received about the datagrams and stream frames
the encoders produced. Frames over 48 fragments, and every keyframe, go on
reliable QUIC streams:

| Preset | Datagrams/s | Stream frames/s |
|---|---|---|
| 1080p60 | 1,075 | 0.9 |
| 4K60 | 816 | 13.3 |
| Movie 50 | 612 | 21.7 |

**Relay to viewer.** At 1440p and up, 2 to 4 top-layer frames a second never
reach the viewer's decoder:

| Preset | Encoded fps | Decoded fps |
|---|---|---|
| 4K60 | 29.5 | 27.6 |
| Movie 50 | 29.7 | 27.7 |
| 1440p60 fullscreen | 30.2 | 29.9 |

Others arrive 20 to 80 ms late, after later frames. In the frame trace of
4K60 normal:
- a 50 KB datagram frame never arrives;
- an 18 KB datagram frame and a 94 KB stream frame arrive 80 ms and 25 ms after
  frames encoded later.

The viewer's reorder stage holds at most 2 frames for 50 ms, then drops older
frames as stale.

**Capture to screen latency** (median / p95):

| Presets | Latency |
|---|---|
| 720p30 | 37 to 49 / 62 to 92 ms |
| 1080p60 and 1440p60 | 53 to 74 / 80 to 145 ms |
| 4K, Movie 50 (counting only the frames that do change) | 62 to 154 ms, p95 into seconds |

Capture to underlay upload, at 720p30: 29 to 32 ms, jitter (sd) 4 to 11 ms.

### Viewer: decoded vs uploaded vs on screen

Window 5120x1412, at rest. "Of layer" means the share of the frames encoded
in the received layer that reached the screen. "Frozen" means the longest
time the screen showed one frame.

| Preset | Layout | Decoded/s | Uploaded/s | Unique on screen/s | Of layer | Frozen max | Viewer CPU (main thread) |
|---|---|---|---|---|---|---|---|
| 720p30 | normal | 25.2 | 25.2 | 25.2 | 99.6% | 0.12 s | 23% (17) |
| 720p30 | theater | 25.4 | 24.7 | 24.7 | 97% | 0.12 s | 44% (37) |
| 720p30 | full screen | 25.9 | 25.3 | 25.3 | 97% | 0.31 s | 50% (41) |
| 1080p60 | normal | 36.8 | 34.4 | 34.3 | 93% | 0.38 s | 30% (20) |
| 1080p60 | theater | 31.7 | 29.7 | **25.7** | 80% | **1.4 s** | 61% (50) |
| 1080p60 | full screen | 31.6 | 29.6 | **20.5** | 64% | **3.2 s** | 61% (49) |
| 1440p60 | normal | 32.5 | 27.1 | **17.0** | 51% | 1.0 s | 32% (20) |
| 1440p60 | full screen | 29.9 | 24.6 | **8.1** | 26% | **6.9 s** | 57% (46) |
| 4K60 | normal | 27.6 | 26.5 | **1.1** | 3% | **8.1 s** | 34% (18) |
| 4K60 | full screen | 25.6 | 19.6 | **1.9** | 7% | **8.2 s** | 52% (37) |
| Movie 50 | normal | 27.7 | 27.1 | **5.8** | 19% | 6.3 s | 36% (22) |
| Movie 100 | normal | 30.6 (1280x360) | 29.7 | 29.7 | 97% | 0.13 s | 31% (23) |

**When uploads outrun unique frames, the decoder is the problem.**
- Example: 4K60 uploads 26.5 frames/s but only 1.1 are new.
- The decoder keeps outputting the same picture after a lost reference.
- The upload counter reads the frame number in the decoded pixels, so this is
  not a display artifact.

**When uploads fall behind decodes, the render side is the problem.**
- Example: 1080p60 normal decodes 36.8 frames/s but uploads 34.4.
- Frames are replaced in the underlay's keep-latest slot before the GTK main
  thread renders them.

**1920x1080 window.** It costs half the viewer CPU in theater:

| Preset | 5120x1412, theater | 1920x1080, theater |
|---|---|---|
| 720p30 | 44% | 17% |
| 1080p60 | 61% | 26% |

The cost scales with the window's area, not the video's.

The same freeze pattern holds at 1920x1080. Normal view at 1920x1080 is where
Auto changes layer and the picture goes green (B5): 1080p60 and 1440p60 had 0
readable frames in normal view.

### During UI motion (5120x1412)

| Motion | 720p30: on screen / decoded | 1080p60 | 1440p60 | Viewer CPU (main thread) | Window presents |
|---|---|---|---|---|---|
| Theater toggle every 1.5 s | 22.1 / 24.6 (89%) | 27.8 / 33.1 (83%) | 21.1 / 30.2 (69%) | 61 to 72% (37 to 44) | 31 to 39 fps |
| Chat sheet toggle | 21.7 / 24.5 (88%) | 23.2 / 35.6 (**64%**) | 15.5 / 32.8 (46%) | 44 to 59% | 28 to 36 fps |
| Stream popover | 24.3 / 25.0 (97%) | 34.8 / 35.8 (97%) | 21.1 / 32.8 | 27 to 42% | 27 to 37 fps |
| Scroll the chat beside the stream | 23.9 / 26.0 (92%) | 28.9 / 30.9 (93%) | 23.5 / 27.6 | **126 to 142%** (73 to 86), WebKit 47 to 49% | 47 to 53 fps |

At 1920x1080 the same motions cost less, and the window presents more:

| Motion | Viewer CPU | Window presents |
|---|---|---|
| Theater toggle | 36 to 51% | 45 to 50 fps |
| Scroll | 68 to 106% | 70 to 88 fps |

### Viewing quality (1080p60 shared, viewer 5120x1412, normal view)

| Setting | Layer received (Mb/s) | Decoder output | On screen |
|---|---|---|---|
| Auto | top 1920x540 (6.6) | 1920x540 | 30.9/s |
| Low | **medium 1280x360 (2.0)** | **still 1920x540** | **0.9/s: green, corrupted** |
| Medium | **top (6.6)** | 1920x540 | 33.4/s |
| High | top (6.4) | 1920x540 | 29.5/s |
| Source | top (6.6) | 1920x540 | 31.0/s |

### Share quality changed mid-stream (viewer in theater, 5120x1412)

Changed in this order: 720p30 → 1080p60 → 4K60 → Movie 100 → 1440p60 → 720p30.

| Change to | Sender applied | Viewer, the 9 s after |
|---|---|---|
| 1080p60 | 1920x540, 38 fps, cap 12 Mb/s | 11 unique/s, frozen up to 3.2 s |
| 4K60 | 3840x1080, 34 fps, cap 28 | 2.3/s, frozen up to 4.3 s |
| Movie 100 | 3840x1080, cap 100 | relay switches it to 1280x360, decoder stays 3840x1080: **0.1/s (corrupted)** |
| 1440p60 | 2560x720, 37 fps | **receives 0.3 Mb/s, decodes 0.1 frames/s: nothing** |
| 720p30 | 1280x360, 25 fps | 14.6/s, frozen up to 3.4 s |

The UI took 2.6 to 2.9 s from the click to the sender's new encoder.

**A crash during the first run of this sequence was the tooling's own.** The
sharer's app crashed on the change from 1440p60 to 720p30, and the core dump
shows the crash in the probe's `av_opt_get` call. The probe was fixed and the
sequence above is the second run, with no crash. Before that crash, the encode
thread had sat 29 s between handing a frame to the filter graph and the
encoder. That was not reproduced and is not counted as a product finding.

### Audio

Stream audio was present in every phase, with every burst arriving.

**Audio is late against the picture.**
- Audio latency from the sharer's capture sink to the viewer's output:
  **165 to 197 ms**, in every phase.
- Video latency, from capture to screen, on presets that play: 35 to 75 ms.
- So the audio arrives **~100 to 145 ms after the matching frame**. That is
  past the point where a late lip-sync becomes noticeable (about 45 ms is
  detectable, 125 ms is the usual acceptability limit for late audio).

The 4K and Movie 50 rows show a smaller offset only because their video is
late too.

## Bugs

### B1. A watched stream freezes forever after the sharer stops and shares again, and still says live

**Repro**
1. Sam presses **Watch vincent** on the room card, without joining. Frames
   flow.
2. Vincent stops sharing, then shares again (any preset).

**What happens**
- Sam's decoder receives **0 frames** from then on. In the 12 s check there
  were 4,929 decoder inputs before and 4,929 after.
- The stream box still reports live (`data-underlay="live"`,
  `data-picture="true"`), shows Vincent's last frame, and gives no notice.
- Even 2 s after the stop, before the new share, there is no "stopped
  sharing" notice.

**Rate.** 18 out of 18 fresh shares during this audit; each needed Back to
chat and Watch again.

**Evidence.** The viewer logged `media packets from this ssrc keep failing to
decrypt: no usable key for it` after a re-share. The new share's sender key
seems never to reach the view session.

**Suggested fix**
1. When the watched streamer's `self_stream` turns false, or the relay
   unpublishes the track, end the watch with "Vincent stopped sharing". When
   they share again, re-subscribe, or offer Watch again.
2. Deliver track key announces to view sessions on every republish.
3. Add a watchdog: say so loudly (fail loudly, never silently) when a "live" watch has
   decoded nothing for 2 s.

**Bottleneck:** transport and session. GTK 4 fixes it: no.

### B2. 60 fps presets encode 30 to 37 fps; 720p30 encodes 25 fps

**Two causes in the sender's encode thread** (`screen_capture.rs`
`run_capture_loop`, `paracord-codec` `lavc/encoder.rs`):

1. **Each simulcast layer has its own filter graph,
   `hwupload_cuda,scale_cuda`**, so the same 5120x1440 BGRA frame (29.5 MB) is
   uploaded to the GPU three times, one after another. Each upload is 6.4 ms of
   the encode thread's time, ~19 ms per frame, plus 3 × 1.7 ms of
   `avcodec_send_frame`. Per frame that is 24 to 33 ms, so at most 30 to 40
   fps.
   - **Fix:** upload once per frame and feed all layers from it. Use one
     graph, `hwupload_cuda,split=3`, then a `scale_cuda` per layer; or upload
     to a CUDA frame once and give each layer's encoder that frame through its
     own scaler. The layers could also encode in parallel.
2. **The pacing gate drops frames that arrive a little early.**
   - The gate encodes a fresh frame only when `elapsed >= frame_interval`.
   - A frame held back because it arrived slightly early waits on
     `wait_timeout(frame_interval)` (a full interval), so the next capture
     usually replaces it.
   - With a 60 fps source and a 30 fps target, frames go out at alternating
     33 and 50 ms. Measured: 24.3 to 26 fps, steps of 2 and 3 source frames.
     Single-layer 1080p60 shows the same, at 43 fps.
   - **Fix:** keep a deadline schedule (`next_due += interval`), wait only
     until `next_due` (not a full interval), and allow up to ~half an interval
     early.
   - Also stop asking the capture for 60 fps when the preset is 30.
     `build_capture_options(…, 60, …)` is hard-coded "so quality can change
     without a new picker"; asking PipeWire for the preset's rate would halve
     the 44% capture cost at 30 fps.

**Bottleneck:** sender. GTK 4: no.

### B3. 1440p, 4K and Movie 50 viewers see a frozen picture for 5 to 8 seconds at a time

**What happens**
- At the top layer of these presets, about 1 frame in 10 is lost or arrives
  late. Large delta frames go on reliable streams while small ones go as
  datagrams, and the viewer's reorder stage gives a late frame 2 frames or 50
  ms before dropping it as stale.
- The decoder then decodes on without its reference.
- NVDEC (AV1) goes on outputting the **same picture** (the decoded pixels
  carry the same frame number) until the next keyframe.

**Why the freezes are so long**
- The keyframe interval is 240 frames, set for 60 fps. At the real 28 to 30
  fps that is **8 s**.
- Nothing asks for a keyframe sooner: the decoder "succeeds" (no error, no
  log line), so the wedged-decoder recovery never fires.

**Effect**
- 4K60: 1 to 4 unique frames/s on screen.
- Movie 50: 2 to 6.
- 1440p60: 8 to 24.
- Even 1080p60 freezes 1.4 to 3.2 s in theater and full screen.
- Silent in every log.

**Repro**
1. Share **4K 60fps** from a 5120x1440 screen.
2. Watch at 5120x1412.
3. The picture updates once every few seconds.

**Suggested fix**
1. Treat a missing or stale-dropped delta frame as a broken reference. Drop
   every delta until the next keyframe and send `RequestKeyframe` at once:
   frame ids are consecutive per layer, so a gap is visible.
2. Do not split one track's frames between datagrams and streams, or widen the
   reorder hold to cover the stream path's latency.
3. State the GOP in seconds of real time (or as a keyframe timer), not as
   `fps × 4` frames.
4. Log a decode gap with its frame ids.

**Bottleneck:** transport, then decode. GTK 4: no.

### B4. A layer switch corrupts the picture: green, until the viewer re-watches

**What happens**
- When the relay switches a viewer to another simulcast layer, the viewer's
  decoder keeps its first resolution.
- The new layer's frames are decoded as if they were the old one. That gives a
  **green, smeared picture** that does not clear, even after the new layer's
  keyframe arrives (1 keyframe received, output still 1920x540).
- The probe matched every received frame to the 1280x360 layer while the
  decoder output 1920x540.

**Triggered by**
- **Auto** in normal view at a 1920x1080 window: the relay picks the medium
  layer for the 1386-px box. 1080p60 and 1440p60 had 0 readable frames.
- **Viewing quality Low**.
- **Movie 100**, where the relay picks medium for everyone (B5).

**Repro**
1. Viewer window 1920x1080.
2. Share 1080p60.
3. Watch in normal view (not theater). The picture is green.

**Suggested fix**
1. On a layer change, reset (or recreate) the track's decoder.
2. Start the new layer only from its keyframe, as the native-render spec's
   "switch at target-layer keyframe" says.
3. Check that each decoded frame's size matches the layer the frame came
   from.

**Bottleneck:** decode (and relay switching). GTK 4: no.

### B5. Settings that do not mean what they say

**Movie 4K (100 Mbps)**
- The relay never sends its 4K layer: every viewer under Auto gets **1280x360**
  (1.8 Mb/s) at both window sizes. The viewer's estimated downlink is probably
  compared with the preset's 100 Mb/s cap.
- Base the layer choice on the measured layer bitrate, not the advertised
  cap.

**Movie 50 and Movie 100 encode at ~17 to 18 Mb/s**, about the same as 4K60's
13 to 14.
- NVENC runs constant quality (cq 18/19) with the preset as a cap, so the
  label's bitrate is never reached on this content.
- Either relabel them ("up to 50 Mbps") or switch them to a target bitrate
  (rc vbr with `bit_rate` set, or cbr).

**Resolution labels.** On a 32:9 screen the presets encode 1280x360,
1920x540, 2560x720 and 3840x1080. That is honest aspect fitting, but "720p"
and "4K" are not what a sharer gets.
- Say the real size in the menu.
- Or fit by height (1280x720 → 2560x720 on a 32:9 screen) when the screen is
  wider than 16:9.

**720p30's medium and top layers are both 1280x360.** That is a redundant
NVENC session: the ladder removes a duplicate only if its bitrate is also
equal.

**Viewing quality**
- Low gives medium, and Medium gives top.
- High and Source are the same value (layer 2) in `StreamSound.tsx`.

**Bottleneck:** relay, encoder configuration and settings mapping. GTK 4: no.

### B6. The sharer's app sounds go to viewers in the stream audio

**What happens**
- `pulse_router.rs` keeps "Paracord's own streams" out of the capture sink by
  process id or "paracord" in the application name.
- The webview's playback stream is named `PipeWire ALSA [WebKitWebProcess]`,
  in a child process, so it is moved into `paracord_stream_capture` with every
  other application's audio.
- That is what plays the join/leave chimes (`voiceSounds.ts`, WebAudio) and
  any other webview audio.

**Proof.** A 3 kHz WebAudio tone played in the sharer's page arrived at the
sharer's capture sink (peak 0.81) and at the viewer's output (peak 0.81),
between the pattern's bursts.

**Repro**
1. Share with computer sound on.
2. Someone joins or leaves the call.
3. Viewers hear the sharer's chime inside the stream.

**Fix**
- Treat a sink-input whose process is a descendant of the app (WebKit's web
  process) as own.
- Or give the webview's audio a recognizable name, e.g. by setting
  `PULSE_PROP`/`PIPEWIRE_PROPS` with `application.name=Paracord` before WebKit
  starts its processes.
- Add a test that WebKit's stream is excluded.

**Bottleneck:** sender audio routing. GTK 4: no.

### B7. Stream audio plays 100 to 145 ms behind the picture

**What happens.** Audio latency from the capture sink to the viewer's output
is 165 to 197 ms. Video is 35 to 75 ms from capture to screen.

**What to look at.** Look at the stream-audio jitter buffer and playout path:
- Opus frame, 20 ms;
- capture fragment, 20 ms;
- the ALSA/pipewire-alsa output buffer at 44.1 kHz with resampling;
- the jitter buffer target.

Either:
- cut it to about the video's latency; or
- hold the video by the difference (the A/V offset is stable within about
  ±20 ms across presets).

**Measurement precision.** About ±10 ms (PipeWire quantum).

**Bottleneck:** audio playout. GTK 4: no.

### B8. The viewer's window drops video frames and spends a core whenever the UI moves (GTK 3 blend)

**What happens**
- While a video surface exists, the webview is transparent, and GTK 3 blends
  the window-sized page over its painted ground on every paint (the cost
  `desktop-framerate.md` measured at 9 to 13 ms at 5120x1412).
- The underlay's GLArea is drawn in the same paint on the main thread, and
  holds only the latest frame.
- So while the page animates or scrolls, decoded frames are replaced before
  they are drawn. Even at 720p30, which arrives intact, only 88 to 92% of
  frames reach the screen during chat-sheet toggles and scrolling.

**Measured cost**

| State | Viewer CPU (main thread) |
|---|---|
| Rest, 5120x1412, normal | 23 to 34% (17 to 20) |
| Rest, 5120x1412, theater and full screen | 44 to 62% (37 to 53) |
| Rest, 1920x1080, theater | 17 to 30% |
| Scrolling the chat beside the stream, 5120x1412 | **126 to 142%** (main thread 73 to 86%) |

The window presents only 31 to 39 fps during theater moves at 5120x1412.

**GTK 4 fixes it: yes.** Graphics offload puts the video in a Wayland
subsurface. The compositor then blends it, a video frame no longer needs a
GTK paint, and the GTK 3 per-paint blend of a transparent window goes away.
That is the subsurface rewrite `frame-pacing.md` already names.

**Short of GTK 4,** drawing the GLArea only for new video frames would help
(and paint only its own rect, when the page is still).

### Smaller findings

- **The sharer's room card still says "You, sharing a screen" after its app
  died.** After a crash the server kept the voice state; the next launch showed
  the ghost share until it joined again.
- **No diagnostics for B3 or B4.** A frozen or green picture writes nothing
  to `client-voice.log` or stderr, and decode gaps are not logged.
- **Each app process prints** `Gtk-CRITICAL gtk_widget_get_scale_factor` once
  at start (known, `video-min-size.md`).

## Not covered

- **Camera.** The desktop camera path (nokhwa/V4L2) needs a video device. A
  fake one (v4l2loopback) needs root to load, and the real camera is off
  limits, so the camera was not measured.
  - The camera has no quality setting in the UI, and its simulcast ladder
    (480x270@15, 640x360@30, source) shares the encoder code with the screen.
  - B2's per-layer upload, B3 and B4 apply to it by construction, but that
    was not measured.
- **The browser sender ("Vincent's stream" in earlier passes: Chromium,
  canvas `captureStream`, WebCodecs over WebTransport).** It was not used here.
  - The desktop's settings drive the native sender, which this pass drove
    through its real capture path instead (scap → PipeWire → NVENC).
  - The browser path has its own preset code (`voiceStore.ts`, browser
    branch) and needs its own run.
- **A 3840x2160 screen** (real "4K" sources), Windows and macOS senders,
  VAAPI (AMD/Intel), and real network loss. The loopback here loses frames
  only through the B3 ordering.
- **Stream volume.** Not measured beyond "audio present".

## Reproduce

```sh
scripts/stream-audit/build.sh /tmp/sa-build    # CARGO_TARGET_DIR=…/Paracord-glass/target here
export SA_APP=… SA_SERVER_BIN=… SA_DIST=…        # as build.sh prints
scripts/stream-audit/env.sh up /tmp/sa-run
node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan full
node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan layers --presets 1080p60
node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan midstream
scripts/stream-audit/setsize.sh /tmp/sa-run/viewer 1920 1080
node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan sizes --size 1920x1080
python3 scripts/stream-audit/analyze.py /tmp/sa-run --json /tmp/sa-run/all.json
python3 scripts/stream-audit/table.py /tmp/sa-run/all.json
scripts/stream-audit/env.sh down /tmp/sa-run && rm -rf /tmp/sa-run
```

**Simulcast off.** Restart the sender with
`SA_ENV=PARACORD_SCREEN_SIMULCAST=off scripts/stream-audit/side.sh start sender …`,
then run `--plan quick --tag nosimulcast-`.

**Logs.** This pass's analyzed JSON and the green-picture screenshot are in
its scratchpad (`sa/results/`). The run directories (instance data, HOMEs,
graphs, ~220 MB of logs) were deleted after analysis, and every process the
pass started was stopped. The 1080p60 smoke run of the committed tooling
reproduced these numbers:
- 33.5 fps encoded;
- 32 unique frames/s in normal view;
- a 4.7 s freeze in theater.
