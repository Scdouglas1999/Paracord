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
