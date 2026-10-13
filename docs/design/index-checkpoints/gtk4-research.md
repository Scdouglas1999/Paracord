# Checkpoint: GTK 4 / WebKitGTK 6.0 / Chromium frame-timing spike (2026-10-13)

The decision and the comparison of routes are in `docs/design/gtk4-plan.md`.
This page has the raw measurements and how to rerun the spike. Nothing in the
app changed.

## Setup

| | |
|---|---|
| Machine | RTX 4080 (driver 615.71.09) + AMD iGPU, CachyOS, KWin 6.7.5 |
| Nested compositor | `kwin_wayland --virtual --width 5120 --height 1440`, a capability-free copy so `LD_PRELOAD=libdevorder.so` (lists the NVIDIA DRM device first) applies; `kscreen-doctor ...addCustomMode.5120.1440.240000.full` then `mode.2` = **5120x1440 @ 239.90 Hz**; own `XDG_CONFIG_HOME`; `wayland-info` main device `0xE280` (card1/renderD128) |
| GPU check (`/proc/<pid>/{fd,maps}`) | spike4, spike3, the app and their WebKitWebProcess: renderD128 only, `libnvidia-eglcore.so.615.71.09`; GTK 4 Vulkan: "Using Vulkan device 0" = 0x2704 (RTX 4080); Chromium GPU process renderD128 + NVIDIA, WebGL `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4080/PCIe/SSE2, OpenGL ES 3.2)` |
| Isolation | clients in `bwrap`: `/dev/snd` empty tmpfs, real PipeWire/Pulse sockets covered, `PULSE_SINK=glass_g23_out`, private D-Bus (`dbus-run-session`), private `HOME`; Chromium `--password-store=basic`, fresh profile. `~/.config/kwinoutputconfig.json` md5 `e6df1573e4cb2092f532a839e47e2046` before and after every run. The owner's running client (pid 3691665) was not touched. |
| WebKit | 2.52.6 for both APIs. `webkit2gtk-4.1` is the system package. `webkitgtk-6.0-2.52.6-1-x86_64.pkg.tar.zst` from the Arch mirror, `pacman-key --verify` good (heftig), extracted to the scratchpad and overlaid with `bwrap --overlay-src /usr --overlay-src <extract>/usr --ro-overlay /usr` (WebKit's helper paths are compiled in; nothing installed) |
| GTK | 3.24.52, 4.22.5 |
| Chromium | 153.0.8010.47 (Arch), `--ozone-platform=wayland` (and `=x11` on a nested Xwayland) |

| Binary | What |
|---|---|
| `spike4` | gtk4 0.11.5 + webkit6 0.6.1 (`v2_52`): one undecorated maximized `ApplicationWindow` with a `WebView`. It prints a `[frame] commit= present=` line per toplevel frame from `GdkFrameTimings` (GTK 4 fills it from `wp_presentation`), and `[mark t=<µs>]` lines for `messageHandlers.mark`. `SPIKE_FEATURES=Id=0` toggles `WebKitFeature`s. `SPIKE_UNDERLAY=1` puts a 1920x1080 `GdkMemoryTexture`, replaced at 60 Hz, under a transparent webview. |
| `spike3` | the GTK 3 / webkit2gtk 2.0.2 twin, used for the memory row |
| the app | `paracord-desktop-final` from the frame-pacing pass: release, vpx, devUrl `localhost:1437`, `PARACORD_FRAME_TRACE=1`. It is the frame path of HEAD; the window-chrome commit after it does not touch painting. The page shows the window through `plugin:window\|show` and marks phases through `append_client_log`. |
| Chromium | presented frames from `WAYLAND_DEBUG=client` `wp_presentation_feedback.presented` (clock_id 1 = CLOCK_MONOTONIC); page marks POSTed to the static server, which stamps CLOCK_MONOTONIC |

**The page** (`frame-test.html`, 6 s per phase, 1.5 s gaps):

| Phase | What the page does |
|---|---|
| `idle-raf` | rAF loop only |
| `css-anim` | `translateX` keyframes on a 160 px box, main thread idle |
| `css-anim-raf` | the same plus an rAF counter |
| `raf-anim` | transform written each rAF |
| `scroll` | `scrollBy({top: ±600, behavior: 'smooth'})` every 300 ms over 600 rows; scroll-event timestamps and `scrollTop` changes per rAF |
| `scroll-glass` | the same under a fixed `backdrop-filter: blur(24px)` header |
| `glass` | three `backdrop-filter: blur(30px) saturate(1.4)` panels over a drifting radial-gradient layer, one bobbing |

## Raw results (5120x1440 maximized, 239.9 Hz)

**How to read a cell:**
- Presented fps; the most common interval, and its share, in display
  refreshes (1v = 4.17 ms); then frame gaps over 25 ms.
- `rAF`: the page's callback rate.
- `scr`: scroll events per second.

### GTK 3 app, shipped frame path (`app-gtk3`, `app-gtk3-r2`)

| Phase | Run 1 | Run 2 |
|---|---|---|
| idle-raf | rAF 62.2 | rAF 62.2 |
| css-anim | 197.0, 1v 87%, 9 | 196.8, 1v 87%, 7 |
| css-anim-raf | 208.8, 1v 94% (rAF 62.1) | 208.2, 1v 94% (rAF 61.9) |
| raf-anim | 62.8, 4v 69% (rAF 62.1) | 62.6, 4v 69% |
| scroll | 49.3, 4v 74%, 19 (rAF 61.8, scr 50.8) | 53.3, 4v 72%, 13 (scr 52.1) |
| scroll-glass | 51.4, 4v 62% (scr 51.8) | 53.5, 4v 72% (scr 51.9) |
| glass | 191.4, 1v 86% | 192.9, 1v 89% |

CPU (run 2): css-anim 35%, raf-anim 14%, scroll 12%, glass 41%.

### GTK 4 + WebKitGTK 6.0, `GSK_RENDERER=ngl` (`gtk4-ngl`, `-r2`, `-r3`)

| Phase | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| idle-raf | rAF 62.1 | 62.1 | 62.2 |
| css-anim | 206.4, 1v 94%, 10 | 211.0, 1v 95% | 208.1, 1v 94% |
| css-anim-raf | 210.1, 1v 96% | 215.0, 1v 96% | 211.5, 1v 96% |
| raf-anim | 62.2, 4v 75% (rAF 61.6) | 61.7, 4v 71% | 61.5, 4v 74% |
| scroll | 56.1, 4v 70% (scr 52.6) | 53.9, 4v 70% (scr 51.0) | 53.3, 4v 69% (scr 52.8) |
| scroll-glass | 52.7, 4v 70% | 53.6, 4v 72% | 56.2, 4v 69% |
| glass | 201.3, 1v 91% | 199.1, 1v 91% | 199.5, 1v 90% |

CPU (run 3): css-anim 13%, raf-anim 5%, scroll 7%, glass 19%.

### GTK 4 + WebKitGTK 6.0, GTK's default renderer (`GskVulkanRenderer`, MAILBOX) (`gtk4-vulkan`)

| Phase | Result |
|---|---|
| css-anim | 33.9, 6v 38%, 91 |
| css-anim-raf | 36.7, 5v 42% |
| raf-anim | 38.7 (rAF 38.6) |
| scroll | 31.1, 124 gaps (rAF 57.2) |
| scroll-glass | 28.8 |
| glass | 33.4, 142 gaps |

- At 1440x900 (`t-vk-small`): css-anim 129.3, 1v 46%; glass 158.7, 1v 62%.
- Short 4 s runs at 5120: css-anim 32.6 to 38.3, glass 33.4 to 33.7.

### Display link at 240 Hz

Both columns run the test shim `libvblemu2.so` (below) with
`PreferPageRenderingUpdatesNear60FPS` off: for GTK 4 through `SPIKE_FEATURES`,
for the app through `libnear60.so` from the frame-pacing pass.

| Phase | GTK 4 `ngl`, run 1 | GTK 4 `ngl`, run 2 | GTK 3 app, run 1 | GTK 3 app, run 2 |
|---|---|---|---|---|
| idle-raf | rAF 240.0 | 240.0 | 240.0 | 240.0 |
| css-anim | 211.5, 1v 96% | 204.7, 1v 94% | 196.3, 1v 89% | 195.2, 1v 88% |
| css-anim-raf | 210.5, 1v 96% (rAF 240) | 209.0 (238.7) | 205.8, 1v 93% (238.3) | 210.7 (238.8) |
| raf-anim | 212.1, 1v 94% (rAF 224.7) | 204.4, 1v 94% (217.4) | 208.0, 1v 91% (225.7) | 213.2, 1v 98% (216.2) |
| scroll | 204.0, 1v 96% (scr 228.8) | 192.7, 1v 96% (208.1) | 208.3, 1v 96% (222.6) | 207.4, 1v 93% (217.3) |
| scroll-glass | 205.0, 1v 98% (scr 215.4) | 178.1, 1v 93% (199.3) | 202.8, 1v 97% (210.9) | 208.7, 1v 97% (214.8) |
| glass | 210.6, 1v 96% | 212.1, 1v 95% | 198.6, 1v 90% | 216.1, 1v 98% |

CPU (run 2):
- GTK 4: raf-anim 10%, scroll 15%, glass 21%.
- GTK 3 app: raf-anim 37%, scroll 21%, glass 45%.

### Chromium 153, native Wayland (`chromium`, `chromium-r2`)

| Phase | Run 1 | Run 2 |
|---|---|---|
| idle-raf | rAF 239.9 | 239.9 |
| css-anim | 212.5, 1v 96% | 212.7, 1v 96% |
| css-anim-raf | 208.1, 1v 92% (rAF 223.2) | 198.9, 1v 89% (219.2) |
| raf-anim | 200.5, 1v 90% (rAF 218.7) | 198.7, 1v 88% (221.1) |
| scroll | 195.2, 1v 87% (scr 200.5) | 191.8, 1v 87% (scr 200.9) |
| scroll-glass | 213.2, 1v 98% (scr 207.5) | 212.4, 1v 96% (scr 209.0) |
| glass | 210.2, 1v 96% | 206.5, 1v 94% |

- CPU (run 2): css-anim 12%, raf-anim 16%, scroll 27%, glass 25%.
- Under Xwayland (`--ozone-platform=x11`, nested KWin `--xwayland`, page
  side only):
  - rAF: idle 239.8; in phases 215.6 to 220.8.
  - Scroll events: 207.8, and 204.1 under glass.

### Underlay shape, GTK 4 `ngl` (`gtk4-ngl-underlay`, page `?hole=1`)

| Phase | Result | CPU |
|---|---|---|
| css-anim | 198.4, 1v 89% | 37% |
| glass | 204.6, 1v 93% | 42% |
| scroll | 98.6, mixed (the 60 Hz texture plus 60 Hz scrolling) | 30% |

The CPU includes the spike filling an 8 MB frame in a Rust loop 60 times a
second.

### Memory, built client (`client/dist` on :1438, no server, so its "could not open the instance screen")

PSS 22 s after start:

| Engine | Total | By process |
|---|---|---|
| GTK 3 + 4.1 | 448 MB | UI 183, web 213, network 52 |
| GTK 4 + 6.0 | 466 MB | UI 136, web 277, network 53, dbus-proxy 1 |
| Chromium | 592 MB | 12 processes; excludes the 38 MB `plasma-browser-integration` host it started |

The page rendered correctly in all three (screenshots `shots/client-*.png` in
the scratchpad).

### Why the DRM vblank monitor fails here (both APIs)

- **The journal:** `spike4: Could not create a vblank monitor for display 1:
  no drm node with CRTC found` → `Failed to create DRM vblank monitor,
  falling back to timer`.
- **The connector:** card1 `HDMI-A-1` (828) is connected, 1190x340 mm, but
  `encoder_id 0`, and WebKit skips connectors without one.
  - On the frame-pacing pass's day only the physical size mismatched.
  - Faking the size alone (`libvblemu.so`) no longer reaches
    `drmWaitVBlank`; `libvblemu2.so` also fills `encoder_id`/`crtc_id`.

## Rerun

All files are in the scratchpad's `gtk4-spike/`:
- `spike4/`, `spike3/`
- `www/frame-test.html`
- `desk/{session,run,gpuprobe,cpusample,chromium,chromium-x11}.sh`
- `serve.py`, `pacing.py`, `report.py`, `cpu.py`, `wl2frames.py`
- `bin/{kwin_wayland,libdevorder.so,libvblemu2.so,libnear60.so}`
- `rerun.sh`

Steps:

1. **Fetch WebKitGTK 6.0 without installing it.**

   ```sh
   curl -O https://geo.mirror.pkgbuild.com/extra/os/x86_64/webkitgtk-6.0-2.52.6-1-x86_64.pkg.tar.zst{,.sig}
   pacman-key --verify webkitgtk-6.0-*.sig webkitgtk-6.0-*.zst
   tar -C sysroot -xf webkitgtk-6.0-*.zst
   ```

2. **Build the spikes.** Build `spike4` inside the overlay so pkg-config and
   the linker find 6.0:

   ```sh
   CARGO_TARGET_DIR=…/Paracord-glass/target/gtk4-spike \
   bwrap --dev-bind / / --overlay-src /usr --overlay-src $PWD/sysroot/usr --ro-overlay /usr -- cargo build --release
   ```

   `spike3` builds normally.
3. **Serve.**
   - `python3 serve.py 1437 www runs/marks.log`: the page, plus marks for
     Chromium.
   - `python3 serve.py 1438 client/dist`: the built client.
4. **One configuration.** For example:

   ```sh
   SPK_ENV="__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json GSK_RENDERER=ngl SPIKE_URL=http://127.0.0.1:1437/frame-test.html" \
     desk/run.sh gtk4-ngl timeout 100 …/spike4
   python3 report.py runs/gtk4-ngl.log; python3 cpu.py runs/gtk4-ngl.log
   ```

   - `run.sh` starts the nested KWin in a private D-Bus session, runs the
     client in the sandbox, and checks `kwinoutputconfig.json` is unchanged.
   - `SPK_MAXIMIZE=1` for the app and Chromium (a KWin script).
   - `SPK_KWIN_ARGS=--xwayland` for an X11 client.
   - `SPK_SHOT=<s>:<name>` for a spectacle shot inside the session.
5. **All headline configurations:** `rerun.sh <suffix>`.

**The test-only shim** `libvblemu2.so` (`gcc -shared -fPIC vblemu2.c
$(pkg-config --cflags --libs libdrm) -ldl`). It is never shipped; it exists
to show what WebKit does when its display link runs at the refresh rate. It
overrides:
- `gdk_monitor_get_{width,height}_mm` → 1190x340;
- `gdk_monitor_get_refresh_rate` → 240000;
- `drmModeGetConnector` (fills a 0 `encoder_id` from `encoders[0]`);
- `drmModeGetEncoder` (fills a 0 `crtc_id` with the first CRTC);
- `drmWaitVBlank`: sleeps to the next multiple of 1/240 s of CLOCK_MONOTONIC.
  This is not tied to the display, so it is what a "timer at the refresh
  rate" fix in WebKit would be.

## Not done here

- **No real-display run.** The owner can capture `PARACORD_FRAME_TRACE=1` on
  the RTX 4080 itself.
- **No AMD/Intel run** where WebKit's DRM monitor might work. That is where
  turning off `PreferPageRenderingUpdatesNear60FPS` alone could already lift
  rAF.
- **No WebKitGTK 2.54.** The mirror here served 2.52.6; Arch has 2.54.1 as of
  2026-10-07.
- **`tauri-runtime-cef` was not built.** The Chromium numbers are the
  browser's.
- **The full Index client was not driven in GTK 4.** It needs a server and the
  Tauri runtime; only its static first screen was loaded.
