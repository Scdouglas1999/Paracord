# Checkpoint: Route C on Linux (C1 shipped, C2 not pursued, C3 gate) (2026-10-13)

The plan is `docs/design/gtk4-plan.md` (Route C). The spike it builds on is
`gtk4-research.md`.

**Outcome:**
- **C1 is in the app.** WebKit's "near 60 fps" preference is turned off on the
  main webview.
- **C2, the WebKit display-link patch, is not being pursued.** This is the
  owner's decision: nothing goes to WebKit, and Paracord will not bundle a
  patched WebKitGTK.
- **C3 is in the repo.** The frame-timing gate lives in `scripts/frame-timing/`.

## What changed

### C1: `PreferPageRenderingUpdatesNear60FPS` off

**The code.**
- `client/src-tauri/src/linux_webkit.rs`:
  - `release_page_rendering_rate(view)` turns WebKit's
    `PreferPageRenderingUpdatesNear60FPS` feature off on the main webview's
    `WebKitSettings`, then reads it back.
  - It uses WebKit's public `WebKitFeature` API, available since WebKitGTK
    2.42: `webkit_settings_get_all_features`, `webkit_feature_get_identifier`,
    `webkit_settings_{get,set}_feature_enabled`.
  - The calls are raw FFI, looked up in the process's symbol scope at run
    time. The `webkit2gtk` crate binds only up to 2.40, and on an older
    WebKitGTK their absence must be an error line, not a failure to start.
- `lib.rs`: `release_main_page_rendering_rate`, called in setup after the
  frame pacer. Linux only (`cfg(target_os = "linux")`).

**The client log.** The line is written to stderr and to the client log:

```
[webkit] page rendering: PreferPageRenderingUpdatesNear60FPS off (was on; WebKitGTK 2.52.6): page rendering follows WebKit's display link
```

It fails loudly as `[webkit] page rendering NOT released from 60 fps: <why>`
in these cases:
- no feature API (WebKitGTK older than 2.42);
- no such feature;
- a setting that does not stick;
- no webview.

The app keeps running in each case.

**Tests** (`linux_webkit::tests`, 6 new):
- Five against a fake API:
  - turned off and reported;
  - already off;
  - API missing names 2.42;
  - feature missing;
  - setting does not stick.
- One against the system WebKitGTK: `webkit_settings_new()`, the feature is
  listed and on by default, and it is off after the call. It needs no display
  and was run here with `WAYLAND_DISPLAY` and `DISPLAY` unset. CI's
  `ubuntu-latest` has WebKitGTK 2.50 or later, so it runs there too.
- `cargo clippy -p paracord-desktop --all-targets -D warnings` and
  `cargo fmt --check` are clean.

### C3: the frame-timing gate

`scripts/frame-timing/` contains the following (the README has the details):

| File | What it is |
|---|---|
| `frame-test.html` | The spike's page, plus an `idle` phase (nothing changes and no rAF: the app's cost at rest) and an `hz` parameter for the page-side histograms. |
| `pacing.py` | The frame-pacing pass's analysis of `PARACORD_FRAME_TRACE`, now importable. |
| `analyze.py` | One row per phase, CPU per phase, the median across runs, and the verdict. |
| `run.sh` + `session.sh` | The nested KWin runner. |
| `gpucheck.py` | GPU identity from `/proc` and `/sys`. |
| `cpusample.py` | Samples the app's process tree. |
| `stamp.py` | Puts CLOCK_MONOTONIC on each line of the app's stderr, so `idle` (no frames) has phase bounds. |
| `serve.py` | Serves the page. `/` redirects with the run's parameters. |
| `gate.sh` | N runs plus the verdict. |
| `build-app.sh` | Builds the test binary: release, vpx, devUrl :1437. |
| `devorder.c` | Lists the NVIDIA device first for the nested KWin. |
| `dbus-session.conf` | The private session bus's config. |

**What the gate enforces:**
- **Frames.** Compositor phases (`css-anim`, `css-anim-raf`, `glass`) must
  present at ≥ 75% of the refresh (180 fps at 240 Hz) with ≥ 85% of frames
  one refresh apart.
- **Display-link phases.** `raf-anim`, `scroll` and `scroll-glass` are gated
  the same way only with `--require-display-link`.
- **No silent iGPU run.** The compositor's main device must be NVIDIA, every
  DRM node the app's tree holds must be NVIDIA's, and the UI and web
  processes must have `libnvidia-eglcore` mapped.
- **The output mode** must be the requested one.
- **The real KWin config.** `~/.config/kwinoutputconfig.json` must have the
  same md5 before and after. It was `e6df1573…` before and after every run
  here.
- **CPU** is reported per phase. There is no fixed threshold: compare against
  the previous run on the same machine.

**An isolation hole the gate closes.** The research pass's harness used
`dbus-run-session` with the stock session config. The app's Secret Service
lookup then *activated* `ksecretd` and `xdg-desktop-portal-kde` on the private
bus.
- They started with the real `HOME`. They outlived every run, holding the
  run's output pipe, which is what made the first gate run here hang.
- **No wallet file was written.** `~/.local/share/kwalletd/kdewallet.kwl` was
  last modified 2026-10-12 23:23, and nothing under `~/.config` or
  `~/.local/share` changed during the run.
- The gate's bus config now lists **no service directories**, so nothing can
  be activated. After the eight measurement runs plus one, no new
  `ksecretd`/portal process existed.
- **Cleanup.** The 54 orphans from today's runs (07:51 to 08:43, all on
  private buses, none on `/run/user/1000/bus`) were stopped.
- **Left alone.** 87 older orphaned `ksecretd`/portal pairs from passes on
  2026-10-01 to 10-05 are still running. They come from other sessions, so
  they were not touched. The owner may want them gone: they are the
  `ksecretd` processes whose `DBUS_SESSION_BUS_ADDRESS` is a `/tmp/dbus-*`
  socket.

## Measurements

**Conditions.** As in the research pass:
- nested `kwin_wayland --virtual`, 5120x1440, custom mode 239.90 Hz, own
  config dir;
- on the RTX 4080 (driver 615.71.09): compositor main device `0xE280` =
  renderD128; the app's UI and web processes on renderD128 with
  `libnvidia-eglcore`. The gate's GPU check passed on every run.
- the app maximized at 5120x1412, `PARACORD_FRAME_TRACE=1`;
- `bwrap` with no sound devices, `PULSE_SINK=glass_g23_out`, a private
  activation-free D-Bus, and a private HOME.

**Builds.** Both are release `paracord-desktop` builds, vpx on, devUrl :1437:
- `base`: HEAD `7fe63a0b`;
- `c1`: the same tree plus this change.

**WebKit.** WebKitGTK 2.52.6, the system `webkit2gtk-4.1`.

**How to read the tables.**
- Cells are the median of two runs: presented fps, then the share of frames
  one refresh apart.
- rAF and scroll are the page's callbacks and scroll events per second.
- CPU is the app's whole process tree, in percent of one core.

### Today's machine (WebKit's display link is its 60 Hz fallback timer)

| Phase | base | c1 |
|---|---|---|
| idle, CPU | **0.1%** | **0.1%** |
| idle-raf, rAF / CPU | 62.2/s / 1.1% | 62.2/s / 1.1% |
| css-anim | 197.2, 89% / CPU 36.0% | 199.5, 89% / 34.5% |
| css-anim-raf | 210.1, 95% / 36.0% | 207.3, 95% / 36.8% |
| raf-anim | 62.2, 6% (rAF 62) / 12.6% | 63.0, 8% (rAF 62) / 13.1% |
| scroll | 53.6, 6% (scroll 52/s) / 12.0% | 54.8, 7% (scroll 51/s) / 12.0% |
| scroll-glass | 54.5, 1% / 11.3% | 54.8, 1% / 11.3% |
| glass | 194.9, 89% / 42.1% | 197.3, 90% / 42.0% |
| Gate (compositor phases) | PASS | PASS |

- **C1 changes nothing here.** Idle CPU is unchanged, and motion CPU is the
  same within run-to-run noise (about ±2 points).
- That is expected: WebKit's display link is the fallback
  `DisplayVBlankMonitorTimer` at about 61.5 Hz, so there is nothing above 60
  for the preference to throttle.

### A machine whose display link follows a 240 Hz display (emulated)

This is the case C1 exists for: WebKit's DRM vblank monitor working, as on
Mesa with a matching connector. It is emulated with the research pass's
test-only shim `libvblemu2.so`, applied by `LD_PRELOAD` to the test app only.
The shim is never shipped and is not in the repo. It makes WebKit's DRM
monitor tick every 1/240 s.

| Phase | base + dl240 | c1 + dl240 |
|---|---|---|
| idle, CPU | **0.0%** | **0.0%** |
| idle-raf, rAF / CPU | 60.0/s / 0.8% | **240.0/s** / 2.6% |
| css-anim | 197.2, 89% / 34.8% | 199.5, 90% / 35.0% |
| css-anim-raf | 204.8, 93% (rAF 60) / 34.0% | 204.4, 93% (rAF 240) / 38.2% |
| raf-anim | **60.0, 9%** (rAF 60) / 12.5% | **217.0, 99%** (rAF 219) / 37.1% |
| scroll | 191.6, 92% (scroll 57/s, rAF 59) / 29.0% | 207.9, 98% (**scroll 215/s**, rAF 229) / 31.0% |
| scroll-glass | 188.0, 93% (scroll 55/s) / 28.8% | 194.1, 95% (scroll 214/s) / 30.8% |
| glass | 202.6, 93% / 42.3% | 207.6, 94% / 44.0% |
| Gate with `--require-display-link` | **FAIL** (raf-anim) | **PASS** |

**What this shows:**
- **C1 is what lets page-driven work use a fast display link.**
  - Without it, WebKit holds rAF and the page's scroll events at 60 even when
    the display link ticks at 240.
  - With it, `raf-anim` goes from 60 fps at 9% one-refresh to 217 fps at 99%.
  - Page scroll events go from about 56/s to about 215/s.
- **Smooth scrolling.** The scroll itself presents at about 190 fps even
  without C1, because WebKit's scrolling runs off the display link outside
  page rendering. Scroll events, rAF and anything the page redraws while
  scrolling stay at 60 without C1.
- **Idle CPU does not rise:** 0.0% either way. With nothing asking for
  frames, WebKit's display link stops.
- **Motion CPU rises where the page does more frames:**

  | Phase | CPU | Frames |
  |---|---|---|
  | raf-anim | 12.5% → 37.1% | 3.6x the frames |
  | scroll | 29.0% → 31.0% | |
  | idle-raf | 0.8% → 2.6% | a page running an rAF loop on purpose, at 240 instead of 60 |

  That is the cost of page-driven motion at the display's rate, paid only
  while it runs.
- **The Index client keeps no continuous rAF loop at rest.** Every
  `requestAnimationFrame` in `client/src` is one-shot, except
  `lib/noiseGate.ts`, which belongs to the browser media engine. This is from
  reading the code, not a measurement. So on such a machine an idle Index
  window stays at the `idle` row.

**Decision: C1 ships.** It meets the owner's rule:
- idle CPU is unchanged (0.1% today, 0.0% with the emulated fast display
  link);
- motion CPU is reported above.

### 143.9 Hz output (`FT_HZ=144000`, c1, one run)

| Phase | Result |
|---|---|
| css-anim | 126.3 fps, 96% 1v |
| css-anim-raf | 120.7, 90% |
| glass | 120.9, 91% |
| raf-anim / scroll | 63 / 52 (the 60 Hz timer) |
| idle CPU | 0.7% |

The gate passes: its fps threshold is 75% of the refresh, so 108 here.

## C2: not pursued (owner decision)

**What was stopped.** The owner decided that nothing is submitted to WebKit
and Paracord does not bundle a patched WebKitGTK.
- The scratch checkout (WebKitGTK 2.54.1 tarball, signature checked) was
  deleted before any build.
- No patch was written, built or sent. There is no `docs/design/webkit-c2/`.

**The ceiling without C2**, on the owner's kind of machine: NVIDIA, where
WebKit's DRM vblank monitor cannot be used because the connector reports
`encoder_id 0` and `drmWaitVBlank` is refused to a non-DRM-master client.

| Motion | Presents at | Why |
|---|---|---|
| Compositor-thread motion (every Index motion: Web Animations / CSS on transform and opacity) | 195 to 210 fps, 89 to 95% one refresh apart | `linux_frame_clock.rs` |
| Page-driven motion (`requestAnimationFrame`, scroll position and scroll events, React-driven changes) | about 53 to 63 fps, 1 to 8% one refresh apart | Held by WebKit's 61.5 Hz fallback timer, with uneven 3/4/5-refresh intervals on a 240 Hz display |

Nothing in the app can raise the page-driven row without replacing WebKit's
display link. The in-process symbol shim was rejected in the plan.

**What would lift it:**
- **A WebKitGTK release whose display link follows the display.** A fixed
  rate timer, a frame-clock-driven monitor, or a working DRM lookup on
  NVIDIA. If WebKit ships one on its own, C1 means the app uses it with no
  further change. The emulated table above is what to expect.
- **Route A** (GTK 4 + WebKitGTK 6.0) does *not* lift it either. Same display
  link (`gtk4-research.md`).
- **Route B** (Chromium) does.

**Where C1 already helps.** On machines whose WebKit DRM monitor works (Mesa
with a connector WebKit can match), C1 lifts page-driven motion to the
display's rate today. This was not verified on real hardware: a nested
session has no real connector.

## Reproduce

```sh
cd ~/Documents/Paracord-index            # feat/index-ui, with this commit
scripts/frame-timing/build-app.sh /tmp/pft/paracord-desktop-c1
FT_OUT=/tmp/pft FT_NAME=c1 scripts/frame-timing/gate.sh /tmp/pft/paracord-desktop-c1
# the baseline: the same at 7fe63a0b (git stash or a worktree), FT_NAME=base
# 143.9 Hz: FT_HZ=144000
# the emulated 240 Hz display link (test-only shim from the research pass):
FT_ENV=LD_PRELOAD=<scratch>/gtk4-spike/bin/libvblemu2.so FT_NAME=c1-dl240 \
  scripts/frame-timing/gate.sh --require-display-link /tmp/pft/paracord-desktop-c1
```

- `CARGO_TARGET_DIR=/home/scdouglas/Documents/Paracord-glass/target` was
  used for every build here.
- The runs' logs, `.cpu`, `.gpu` and the JSON verdicts are in this pass's
  scratchpad (`routec/runs/`).

## What remains

| Item | Notes |
|---|---|
| **C4, re-measured on the real display** | `PARACORD_FRAME_TRACE=1` on the owner's RTX 4080 panel, same analysis (`scripts/frame-timing/analyze.py` reads that log too). The nested output has no vblank counter, and the real KWin DRM path (direct scan-out, tearing control) may pace differently. |
| C1 on a Mesa machine | Where WebKit's DRM monitor works, C1 should lift rAF and scrolling to the refresh at once. Needs real AMD/Intel hardware with a matching connector. |
| Gate on a schedule | It is a dev-box gate. Run it before a desktop release, or on a self-hosted GPU runner later. |
| `--require-display-link` | Turn on when the system WebKitGTK's display link follows the display (watch each WebKitGTK stable release; 2.56 is due about March 2027). |
| Upstream | Nothing to do by owner decision. WebKit bug 199376 stays as it is. |
| Old orphaned `ksecretd`/portal processes | 87 pairs from 2026-10-01 to 10-05 on dead private buses. Not touched (other sessions' leftovers); safe to stop. |
