# Stream audit (Linux desktop, dev box)

Measures a live screen share end to end, sender to viewer's screen, for every
share preset and viewer setting, and writes per-stage numbers. The results and
what they mean are in `docs/design/index-checkpoints/stream-audit.md`.

Everything runs privately: a throwaway instance, two private PipeWire graphs
with null nodes only, nested KWin sessions on the NVIDIA GPU with their own
config directories, private activation-free D-Bus sessions, private HOMEs. No
real screen, camera, microphone, speaker, keyring or portal is touched, and
`~/.config/kwinoutputconfig.json` is checked unchanged on every stop.

## Run it

```sh
scripts/stream-audit/build.sh /tmp/sa-build          # prints SA_APP, SA_SERVER_BIN, SA_DIST
export SA_APP=... SA_SERVER_BIN=... SA_DIST=...
scripts/stream-audit/env.sh up /tmp/sa-run           # ~4 min: two one-password sign-ins in WebKit
node scripts/stream-audit/drive/campaign.mjs --out /tmp/sa-run --plan full
python3 scripts/stream-audit/analyze.py /tmp/sa-run --json /tmp/sa-run/full.json
python3 scripts/stream-audit/table.py /tmp/sa-run/full.json
scripts/stream-audit/env.sh down /tmp/sa-run && rm -rf /tmp/sa-run
```

| Plan | What it does |
|---|---|
| `full` | Each preset (`--presets`, default all six): a fresh share, then the viewer at rest in normal, theater and full screen, and during theater toggles, chat-sheet toggles, the stream popover, and chat scrolling beside the stream. |
| `quick` | The same with rest phases and theater toggles only (`--tag` prefixes the phase names). |
| `sizes` | For a viewer window switched with `setsize.sh <run>/viewer 1920 1080` (`--size` names it). |
| `layers` | One preset, then the viewer's Viewing quality: Auto, Low, Medium, High, Source. |
| `midstream` | Share quality changed during a share (`--order`). |
| `netsteps` | One share (the first of `--presets`), the viewer at rest in normal view while `--net-cmd <script>` reshapes the network before each step of `--steps` (e.g. `0,1,5,0:25mbit,0`: loss % and an optional rate, passed to the script as arguments), each held `--hold` seconds. Run inside a private network namespace (see `stream-fix-v1.md`, `stream-fix-v5.md`). |

`SA_VIEW_W`/`SA_VIEW_H` set the viewer's output (default 5120x1412, the owner's
window), `SA_SRC_W`/`SA_SRC_H` the synthetic screen (default 5120x1440), `SA_ENV`
extra sender environment (e.g. `PARACORD_SCREEN_SIMULCAST=off`, set when a side
starts).

## How a frame is followed

| File | What it is |
|---|---|
| `pattern.py` | The synthetic screen: a PipeWire Video/Source, 60 fps, a scrolling page with a band of 18 full-width bars (red, 16 code bars, blue) carrying a 12-bit frame counter and a 4-bit check; plus tone bursts on every 120th frame through the pulse API. |
| `fakeportal.py` | `org.freedesktop.portal.Desktop` ScreenCast on the sender's private bus, answering with the pattern's node (the app's scap capture asks the portal, then reads that node from its own PipeWire remote). |
| `probe.c` | LD_PRELOAD for the app: one line per frame at each stage, read where pixels are on the CPU: `CAP` (PipeWire dequeue), `ESRC`/`EIN`/`EOUT`/`ECFG` (lavc/libvpx encoders), `DIN`/`DOUT` (decoders), `UP` (the underlay's I420 upload), `SW` (the window frame handed to the compositor, read back through pixel-pack buffers from one column at the x in `probe.cfg`). |
| `audiorec.py` | Burst onsets at the sender's capture sink and the viewer's output. |
| `cpuprobe.py` | CPU of each process and of each thread of the app. |
| `analyze.py`, `table.py` | Per-phase numbers from the probe logs, the viewer's `PARACORD_FRAME_TRACE` presentation trace, the relay's `media-stats`, `nvidia-smi`, and the marks the campaign writes. |
| `env.sh`, `side.sh`, `session.sh`, `graph/`, `setsize.sh`, `shot.sh` | The environment. `shot.sh` screenshots a nested session. |
| `drive/` | The in-page agent and its server (`audit-serve.mjs`, `agent.js`, `lib.js`), seeding, sign-in and the campaign. |

The trust dialog for the instance (and for the devUrl origin a test build also
asks about) is answered ahead by writing the private HOME's
`approved_origins.json`; a nested session cannot click a native dialog.

## Uplink and congestion-control labs (stream-fix V6)

**The sender's uplink.** `uplinkstep.sh <loss %> [rate]`, as a `netsteps`
`--net-cmd` inside the lab's private network namespace: 15 ms each way on
every leg to and from the relay's UDP port (`SA_RELAY_UDP`, default 18811),
plus loss and an optional rate on the sender's uplink alone (an HTB class with
a ~100 ms drop-tail queue; `SA_UPLINK_SHAPER=netem` uses netem's rate limiter
instead). Put the other legs' delay in place before the share starts (a
`legs`-style netem whose filters use priorities above 1), so the first step
attaches the uplink band without flushing a queue mid-share; needs `SA_RUN`
(the run dir, to find the sender's socket).

```sh
node drive/campaign.mjs --out $RUN --plan netsteps --presets movie-50 \
  --net-cmd scripts/stream-audit/uplinkstep.sh --steps 0,0:10mbit,0:20mbit,0:50mbit,0 --hold 40
```

**Congestion control against TCP** (`cc/`, no app): three private namespaces,
sender, router and receiver; the router's egress is the bottleneck (HTB rate,
drop-tail netem queue), its return path the round trip's delay. `cc_lab`
(`cargo build --release -p paracord-transport --example cc_lab`) is a
media-like QUIC sender (60 frames/s, a stream per frame) with a choice of
controller; `tcpbulk.py` a competing Cubic flow; `ping` the queueing delay.

```sh
cc/netns.sh up /tmp/ccns
CC_LAB_BIN=…/cc_lab cc/matrix.sh /tmp/ccns /tmp/cc 2 bbr,blind,cubic,media \
  20:40:100:0:44:1 50:20:20:0:80:1          # mbit:rtt:queue ms:loss %:offered Mb/s:tcp
python3 cc/analyze.py /tmp/cc/*/*
cc/netns.sh down /tmp/ccns
```


## Mixed versions and voice at join (stream-fix V7)

`mixed/` runs an older app or server beside the current one: one audit-serve
per client build (:1493 the current `dist`, :1492 an older one, each desktop
test build pointing at its own), the instance on :18830 (the older server gets
legacy accounts through `seed-legacy.mjs` and its apps sign in at `/login`),
graphs `v7-pwA`/`v7-pwB`.

```sh
SA_UI_PORT=1493 scripts/stream-audit/build.sh /tmp/new        # current build
# older build: a worktree at the old commit, its own vite build as dist-old,
# paracord-desktop built with TAURI_CONFIG devUrl :1492 -> paracord-desktop-old,
# paracord-server -> paracord-server-old (see stream-fix-v7.md)
export SA_NEW=/tmp/new SA_OLD=/tmp/old
scripts/stream-audit/mixed/lab.sh up /tmp/mx new new old       # server, sender, viewer
RUN=/tmp/mx node scripts/stream-audit/mixed/voice.mjs --first viewer --trials 10
python3 scripts/stream-audit/mixed/voicean.py /tmp/mx
RUN=/tmp/mx node scripts/stream-audit/mixed/mutegap.mjs --gaps 6500,300,1000,2000
python3 scripts/stream-audit/mixed/mutean.py /tmp/mx
RUN=/tmp/mx node scripts/stream-audit/mixed/video.mjs --preset 1080p60 --qualities auto,low,medium,high,source
python3 scripts/stream-audit/mixed/vidan.py /tmp/mx
scripts/stream-audit/mixed/lab.sh down /tmp/mx
```

| File | What it does |
|---|---|
| `micfeed.sh` | Ten seconds of `espeak-ng` speech, looped, linked into the app's microphone stream only (a null source cannot be played into; the playback node is unlinked and joined to `alsa_capture.paracord-desktop*` every 100 ms, so a reopened microphone is fed too). |
| `lvlrec.py` | The RMS of an app's output every 50 ms (CLOCK_MONOTONIC): when the other side's voice is heard. |
| `voice.mjs` | Per trial: both leave; one joins and unmutes; the other joins and presses Unmute the moment the button exists (what "Unmute right after joining" means), samples its mute state for 6 s, then 12 s of both voices. `voicean.py` prints when each direction is heard. |
| `mutegap.mjs` | The talker mutes for each gap and unmutes; `mutean.py` prints whether the voice comes back (a 6.5 s gap first resets an older receiver). |
| `video.mjs`, `vidan.py` | A share, Watch, Viewing quality steps with screenshots; the viewer's decoded and uploaded sizes per step from the probe. |
| `stats.mjs` | The relay's per-connection media counters every 0.5 s (`relay-stats.log`). |
