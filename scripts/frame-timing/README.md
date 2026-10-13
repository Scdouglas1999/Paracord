# Frame-timing gate (Linux desktop, dev box)

The gate measures how the desktop app presents frames on a 240 Hz display:
- frames per second that actually reached the screen;
- how evenly they were spaced;
- what it costs in CPU.

It runs a fixed test page in the real desktop app, inside a nested KWin
rendering on the NVIDIA GPU. CI has no GPU, so this is a dev-box gate (or a
self-hosted GPU runner later).

Why it exists, and the numbers it reproduces:
- `docs/design/gtk4-plan.md` ("Test plan");
- `docs/design/index-checkpoints/gtk4-research.md`;
- `docs/design/index-checkpoints/route-c.md`.

## Run it

```sh
scripts/frame-timing/build-app.sh                 # test build: release, vpx, devUrl :1437
scripts/frame-timing/gate.sh /tmp/paracord-frame-timing/paracord-desktop-frame-timing
```

- It takes about 100 s per run, two runs by default.
- It prints a row per phase and the median of the runs.
- It ends with `FRAME-TIMING GATE: PASS` or `FAIL`, and exits non-zero on a
  failure.
- Results are in `$FT_OUT` (default `/tmp/paracord-frame-timing`): one
  `<run>.log`, `.cpu`, `.gpu` and `.mode` per run, plus `<name>.json` with
  every row and the verdict.

| Option | What it does |
|---|---|
| `--runs N` | Number of runs (default 2). |
| `--require-display-link` | Also gate `raf-anim`, `scroll` and `scroll-glass`. See "Thresholds". |
| `FT_HZ=144000` | Refresh of the virtual output in mHz (default 240000, which gives a 239.90 Hz mode; `60000` keeps KWin's native mode). |
| `FT_W` / `FT_H` | Output size (default 5120x1440, the owner's panel). |
| `FT_ENV="A=1 B=2"` | Extra environment for the app. |
| `FT_PORT` | The page server's port (default 1437). The app must be built for the same port. |
| `FT_NAME` | Run-name prefix (default `gate`). |

**Any other client** can be measured with `run.sh <label> <command…>` and
`analyze.py <label>.log`. For example, a browser posting marks to `serve.py`'s
`/mark`.

## What it checks besides frames

The gate fails on any of these, before looking at frame numbers:

- **The GPU.**
  - `gpucheck.py` reads `/proc` and `/sys` about 9 s into each run.
  - The nested compositor's main device (`wayland-info`) must be an NVIDIA
    DRM node.
  - Every process of the app's tree that holds a DRM node must hold only
    NVIDIA nodes.
  - The UI process and WebKit's web process must have `libnvidia-eglcore`
    mapped.
  - Why: KWin's virtual backend renders on the first device libdrm lists,
    which on the dev box is the AMD iGPU. Earlier release checks measured that
    by mistake.
- **The output mode.** The virtual output must be at the requested size and
  refresh.
- **The real KWin config.** `~/.config/kwinoutputconfig.json` must have the
  same checksum after the run as before.
  - The nested KWin gets its own `XDG_CONFIG_HOME`.
  - Without that, it writes its virtual output into the real file.

## Isolation

Nothing runs on the real display or touches the owner's session:

- **Compositor.** `kwin_wayland --virtual` (offscreen) with its own config
  directory. It is a capability-free copy of the binary, cached in
  `~/.cache/paracord-frame-timing`, so `LD_PRELOAD=libdevorder.so` (built from
  `devorder.c`) can list the NVIDIA device first.
- **D-Bus.** A private session bus (`dbus-run-session` with
  `dbus-session.conf`).
  - That config lists **no service directories**, so nothing is ever
    activated on it.
  - Without this, the app's Secret Service lookup starts a `ksecretd` with the
    real `HOME`, and it outlives the run.
- **The app.** It runs under `bwrap`:
  - `/dev/snd` is an empty tmpfs;
  - the real PipeWire and Pulse sockets are covered;
  - `PULSE_SINK=glass_g23_out`;
  - `HOME` is private, in `$FT_OUT`.
- **CPU.** `cpusample.py` samples the app's whole process tree (UI, web,
  network processes) every 0.5 s. Its own log stamper runs outside that tree.

## The page (`frame-test.html`)

Each phase runs for 6 s, with 1.5 s gaps.

| Phase | What the page does | Who paces it |
|---|---|---|
| `idle` | Nothing changes and nothing asks for frames. | Nobody: this is the app's cost at rest. |
| `idle-raf` | A rAF loop only. | WebKit's display link. |
| `css-anim` | A CSS `translateX` animation; the main thread is idle. | WebKit's compositor thread. |
| `css-anim-raf` | The same, plus an rAF counter. | Compositor (frames), display link (rAF). |
| `raf-anim` | A transform written in each rAF. | Display link. |
| `scroll` | `scrollBy({behavior: 'smooth'})` of 600 px every 300 ms through 600 rows. | Display link. |
| `scroll-glass` | The same under a `backdrop-filter: blur(24px)` header. | Display link. |
| `glass` | Three `backdrop-filter` panels over drifting color, one bobbing. | Compositor. |

- **Presented frames** come from the app's `PARACORD_FRAME_TRACE=1` (one
  `wp_presentation` line per commit, `linux_frame_clock.rs`), analyzed by
  `pacing.py`.
  - KWin's virtual output has no vblank counter, so refreshes are numbered
    from the presentation times.
- **The page's own cadence** comes from rAF timestamps, scroll events, and
  `scrollTop` changes per rAF.
- **Phase boundaries** are `FRMARK` lines the page writes through
  `append_client_log`. `stamp.py` stamps each with CLOCK_MONOTONIC, the clock
  of the frame trace and the CPU samples.

## Thresholds

From `docs/design/gtk4-plan.md`:

| Phases | Pass | Gated |
|---|---|---|
| `css-anim`, `css-anim-raf`, `glass` | ≥ 180 fps presented (75% of the refresh: 108 at 144 Hz) and ≥ 85% of frames one refresh apart | always |
| `raf-anim`, `scroll`, `scroll-glass` | the same | only with `--require-display-link` |

- **Why the second row is behind a flag.** Those phases run on WebKit's
  display link.
  - On NVIDIA that link is WebKit's fallback timer, about 60 Hz.
  - The DRM vblank monitor cannot be used there: the connector reports no
    encoder, and `drmWaitVBlank` is refused to a non-DRM-master client.
  - So they present at about 55 to 63 fps, and no app-side change can raise
    that. The owner chose not to patch or bundle WebKitGTK.
  - Turn the flag on when the system WebKitGTK's display link follows the
    display.
- **What the second row would show.** With `FT_ENV=LD_PRELOAD=<test shim>`, a
  display link ticking at the refresh rate gives about 200 fps there (see
  `route-c.md`). The shim is a measuring aid, never shipped, and not part of
  this directory.
- **CPU has no threshold here.** Compare `idle` and the motion phases against
  the previous run of the same machine, which is how the owner's "minimal
  hardware use" rule is applied. A change must not raise `idle`.

## Known numbers

The dev box: RTX 4080, driver 615.71.09, KWin 6.7.5, WebKitGTK 2.52.6, at
5120x1440 and 239.9 Hz, on `7fe63a0b` plus C1. Medians of two runs.

| Phase | Result |
|---|---|
| `css-anim` | about 197 to 200 fps, 89% 1v |
| `css-anim-raf` | about 207 to 210 fps, 95% |
| `glass` | about 195 to 197 fps, 89 to 90% |
| `raf-anim`, `scroll` | about 53 to 63 fps (the display-link limit above) |
| `idle` CPU | 0.1% of a core |

At 143.9 Hz (`FT_HZ=144000`), the compositor phases present at 121 to 126
fps.

The full tables are in `docs/design/index-checkpoints/route-c.md`.
