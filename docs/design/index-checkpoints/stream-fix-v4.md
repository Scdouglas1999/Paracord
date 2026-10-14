# Checkpoint: stream fix V4, stream audio (own-sound exclusion and A/V sync)

Fixes B6 and B7 of `stream-audit.md`.
- **B6:** the sharer's own app sounds went out in the stream audio.
- **B7:** stream audio played 100 to 145 ms behind the picture.

Measured in the stream-audit lab (`scripts/stream-audit`, plan `audio`, new
in this package). Branch `feat/stream-fix`, 2026-10-13.

## Results

| | Before | After |
|---|---|---|
| A 3 kHz WebAudio tone played in the sharer's page | Reached the viewer: 10 of 10 tones, peak 0.80 | **0 of 30** tones, over three presets |
| The pattern's 1 kHz bursts (another application's sound) | Arrive | Still arrive: 5 to 10 per phase, peak 0.50 |
| Share with its sound switched off | (not tested) | Nothing at the viewer: 0 bursts, rms 0.0 |
| A/V offset, 720p30 at rest (+ = audio late) | +100 to +145 ms (audit); +164 to +174 ms in this lab | **+24 ms**, and +14 ms during the app-tone phase |
| A/V offset, 1080p60 at rest | +100 to +145 ms (audit); +146 ms | **+32 ms** |
| Audio latency, capture sink to viewer output | 165 to 207 ms | 111 to 144 ms |
| Video latency, capture to screen | 34 to 48 ms | 95 to 112 ms. The picture is now held for its sound (below). |
| Voice, sender mic to viewer (in the call, 100 s) | (not measured) | Steady. The jitter buffer holds 2 to 3 frames, 0 lost, no creep. |

**How the offset was measured.** The audit's method (`analyze.py`):
- the median latency of the pattern's tone bursts, from the sender's capture
  sink to the viewer's output;
- minus the median latency of the pattern's baked frame counter, from capture
  to the frame the viewer's window hands KWin.

The bursts are emitted on frame times, so this is the offset between a frame
and its own click.

**Where the target is not met.**
- **1080p60, during the app-tone phase: +75 ms.** The picture was not steady
  (p95 capture-to-screen 577 ms).
- **1440p60: meaningless offsets.** The picture froze (p95 1.4 s). With the
  picture frozen, the "picture clock" the audio follows is wrong.
- Both phases ran on the shared tree, with the other packages' work in
  progress. The freezes are V1's area (B3).

## What changed

### 1. Paracord's own sound stays out of the stream

**Linux.** `pulse_router.rs` judged "own" by `application.process.id ==
getpid()` or "paracord" in the application name. Two things broke that:
- The webview's sounds (join and leave chimes, other WebAudio) come from the
  `WebKitWebProcess` child, not from this process.
- Through pipewire-pulse, a PipeWire-native or ALSA-plugin stream (WebKit's,
  and cpal's) carries **no pid on the sink-input at all**. The pid is only on
  its client.

Now a sink-input counts as own when any of these pids is this process or one
of its descendants (checked through `/proc/<pid>/stat`):
- its `application.process.id` or `pipewire.sec.pid`;
- or the same two properties on the client it belongs to (`pactl -f json list
  clients`).

**Fail loudly.** If the client list cannot be read, the sweep is skipped and
the failure is logged. Moving streams without it would leak our own sound.

**Logging.** Each own stream is logged once, for example: `keeping sink-input
75 (PipeWire ALSA [WebKitWebProcess], client 74) out of the stream audio`.

**Tests.** The child process, a grandchild, a pid known only through the
client, the socket pid, and other applications.

**Windows.** Unchanged, and already right.
- `ActivateAudioInterfaceAsync` with
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` excludes the whole tree.
  WebView2's browser and audio-service processes are descendants of the app.
- Below Windows 10 2004 it already refuses with a message the UI shows
  ("Streaming without PC audio. …"). There is no whole-device fallback.

**macOS.** `scap` accepted `exclude_current_process_audio` and never applied
it. It now sets `SCStreamConfiguration.excludesCurrentProcessAudio`
(`third_party/scap/.../mac/mod.rs`; cidre 0.10 has the setter, and macOS 13 is
already the minimum).

### 2. Audio and video on one clock, audio scheduled against the picture (`native_media/av_sync.rs`)

**Sender.** Both tracks now count from one zero point per share
(`ShareClock`, which replaces `screen_capture_base_time`):
- the screen encoder's `timestamp_us`;
- the screen audio's 48 kHz `timestamp`, which was a counter starting at 0.

Every screen-audio frame now carries the wall-clock time of its first sample
(`ScreenAudioFrame`):
- Linux: the pulse read time, minus the recording latency and the samples
  still waiting;
- Windows: the WASAPI packet time;
- macOS: ScreenCaptureKit's presentation time, which is the same clock as its
  video.

The wire stamp advances one frame at a time and is pulled 1/16 of the way to
the capture time each frame. That smooths read jitter without drifting. Jumps
of more than 60 ms are taken as they are.

**Viewer, picture side.** For each screen track:
- when a whole frame arrives, how far that is behind its capture stamp;
- when it is presented, how far that is behind, both with and without any
  hold.

**Viewer, sound side.** Each 20 ms tick, the playout reports the earliest its
sound could be heard behind its capture stamp. That is the newest buffered
frame, played now, through:
- the mixer's buffered depth;
- the resampler delay;
- the device latency.

**Why the picture is held.** The sound's path is the longer one: two 20 ms
frames, the jitter buffer, the mixer and the device, against a hardware
decode. So the decode worker holds each frame **before decode** by the
difference plus a 20 ms margin:
- at most 300 ms;
- following its target slowly;
- scheduled from the frame's own stamp, so it also evens out arrival jitter;
- and dropped to 0 the moment the stream has no sound.

Holding before decode means no GPU frame waits.

**How the sound follows the picture.** It is scheduled against the picture's
presentation distance:
- 20 ms early: hold a tick (concealment once playing);
- 20 ms late: skip a frame, but only with a frame to skip to;
- small errors corrected at most every 200 ms;
- holds stop at 300 ms buffered, which is a share restarting, not real
  earliness.

The state is logged every 5 s (`av-sync: …`).

### 3. Latency the audio path did not know about

- **The output buffer.** cpal's ALSA default is a 100 ms buffer that it keeps
  full, and PipeWire's ALSA plugin reports none of it as delay. The lab
  measured 150 ms from mixer to output, against 42 ms reported.
  - On Linux the output now asks for a 40 ms buffer in 10 ms periods.
  - Its floor, plus one PipeWire graph quantum (21.3 ms), counts as device
    latency.
  - Elsewhere the platform default stays, and cpal's callback timestamps are
    used.
  - This lowers voice latency too.
- **The jitter buffer** (`paracord-codec/audio/jitter.rs`) had two
  silence-forever bugs that the sync exposed. Both hit voice as well.
  - *When the buffer ran dry,* a pull advanced past the late frame. Once
    packets came a touch slower than the 20 ms pull (a slow sender clock, or a
    skip), every arrival was "behind" playout and the stream went silent for
    good. Now a dry buffer waits, and nothing is concealed for a late (not
    lost) frame. Concealing there added 20 ms each time.
  - *When the buffer was full* at 50 frames, it dropped exactly the frame
    playout wanted next, every time. Now playout moves to the oldest frame
    kept.
- **Jitter estimate.** A sender timeline jump (a share restarting) is left out
  of the estimate, instead of inflating it for seconds.

### Lab tooling

- `env.sh` and `build.sh` take `SA_UI_PORT`, `SA_GRAPH_A` and `SA_GRAPH_B`, so
  two labs can run at once (defaults unchanged).
- `audiorec.py` logs each burst's pitch (`freq=`).
- `campaign.mjs --plan audio`, per preset:
  1. 20 s at rest (A/V offset);
  2. 12 s of 3 kHz WebAudio tones played in the sharer's page;
  3. a share whose sound is then switched off through the page's media engine,
     which is the same command a share without sound sends. The desktop UI
     always asks for sound, and its IPC entry points are read-only.

## What is left, and what only CI or real machines can confirm

- **macOS.** A WKWebView plays page audio from WebKit's GPU process, an XPC
  service, not this process.
  - Whether `excludesCurrentProcessAudio` covers it depends on CoreAudio's
    process attribution. This needs a real Mac: share with sound, play a join
    chime, and listen on a viewer.
  - If it is not covered, the next step is an `SCContentFilter` that excludes
    the app's `SCRunningApplication`. That also removes the app's windows from
    a display capture.
- **Windows.** Compile-checked here (cross clippy, `x86_64-pc-windows-gnu`).
  - No new warnings. The three remaining are pre-existing (`texture` never
    read, `chunks_exact`, and an unneeded `unsafe` in `windows_h264.rs`).
  - Exclusion of WebView2's audio-service process needs a real Windows
    machine.
- **OS notification sounds** are played by the desktop's notification service,
  not Paracord's tree, so a toast that makes a sound can still be captured.
  Making Paracord's notifications silent while sharing with sound would close
  that.
- **The picture is now ~50 to 70 ms later** (held for its sound). The audio
  floor could come down by ~20 ms with a shallower mixer band for stream
  sources (40 to 60 ms now), which would shorten the hold.
- **The graph quantum is PipeWire's default.** A system configured with a
  larger quantum reads early by the difference (within the ±40 ms band up to a
  2048-frame quantum).
- **With a frozen picture** (B3), the audio follows the frozen picture's
  distance, up to the 300 ms cap. That is V1's area.
- **No same-session baseline build.** "Before" numbers come from the audit and
  from this package's first lab runs (tone leak 10/10 and +164 to +174 ms, with
  the sync not yet effective).
