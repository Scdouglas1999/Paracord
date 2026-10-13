# Linux desktop engine: GTK 4, Chromium, or stay (plan, 2026-10-13)

**The goal.** On Linux the app should hold the monitor's refresh rate. The
owner's machine: RTX 4080, driver 615.71.09, KDE Plasma Wayland (KWin 6.7.5),
5120x1440 at 240 Hz.

**Today.**
- Index motions (Web Animations / CSS on WebKit's compositor thread) present
  at 162 to 202 fps since the frame-pacing pass (`linux_frame_clock.rs`).
- Scrolling and anything driven by `requestAnimationFrame` are held near
  60 Hz.

**This page covers:**
- the spike that measured both WebKitGTK stacks and Chromium under identical
  conditions;
- the routes and how they compare;
- the recommendation;
- the phased plan for GTK 4, with rollback and tests.

Raw numbers and how to rerun the spike are in
`docs/design/index-checkpoints/gtk4-research.md`.

## Recommendation

1. **Do not start a GTK 4 port for the frame rate.** The spike shows it buys
   nothing there.
   - GTK 3 with our pacing patch and GTK 4 + WebKitGTK 6.0 (same WebKit 2.52.6,
     same machine, same page) give the same numbers.
   - Both reach about 200 fps on compositor-thread motion.
   - Both stay at about 60 on scrolling and rAF.
2. **The ceiling on both stacks is one thing: WebKit's display link.**
   - On this machine WebKit's display link is a fixed 60 Hz timer.
   - With a test shim that makes it tick at 240 Hz (not shippable), *both*
     stacks reach about 200 fps on every motion, scrolling and rAF included.
     The range is 178 to 216 fps, with 93 to 98% of frames one refresh apart
     in most phases (88% for GTK 3's css-anim).
   - **The GTK 3 app reaches this as well as GTK 4.**
3. **Route C, now: stay on GTK 3 / WebKitGTK 4.1 and fix the display link
   upstream.**
   - **C1. Turn `PreferPageRenderingUpdatesNear60FPS` off ourselves.** Do it
     through WebKit's public `WebKitFeature` API (WebKitGTK 2.42 and later).
     - Small.
     - It is a precondition for anything above 60 for page-driven updates,
       and it has no effect while the timer is the source.
   - **C2. Upstream a WebKit patch for the display-link timer.**
     - `DisplayVBlankMonitorTimer` should tick at the monitor's refresh rate
       on absolute deadlines, not `sleep_for(1000 / 60)`.
     - Better, on GTK, drive it from the toplevel's frame clock.
     - The test shim is exactly such a timer, unsynchronized with the
       display, and it already gives 93 to 98% one-refresh cadence on
       scrolling and rAF.
     - This one change lifts every WebKitGTK user on NVIDIA, and any machine
       whose DRM vblank lookup fails.
     - Distros ship WebKitGTK stable updates as security updates (Debian,
       Ubuntu, Fedora, Arch), so a fix in a stable release reaches our users
       without our own packaging.
   - **C3. Keep `linux_frame_clock.rs`.** It is what lets the GTK 3 window
     present above 60. It touches one private field, guarded, and is retired
     by Route A later.
4. **Route A (GTK 4 + WebKitGTK 6.0): later, through Tauri itself.** It is
   worth having for other reasons:
   - no private-field patch;
   - GPU-composited transparency, which is the real fix for the call view's
     40 to 47 fps;
   - `GdkDmabufTexture` and graphics offload for the video underlay.

   It should come with Tauri's own GTK 4 support, not a fork of tao and wry
   that we would carry alone. There is a tripwire under "When to revisit".
   - **If we do take it, force `GSK_RENDERER=ngl` on NVIDIA.** GTK 4.22's
     default Vulkan renderer presented the same page at **29 to 39 fps** at
     5120x1440 on the RTX 4080, against 199 to 211 with `ngl`.
5. **Route B (Chromium via Tauri's CEF runtime): not now.**
   - Out of the box Chromium does everything we want on this machine: 192 to
     213 fps presented on every motion, and rAF and scrolling at 201 to
     240/s, with no patches.
   - But the only Tauri path is `tauri-runtime-cef`, which has these problems:
     - it is a v3 alpha;
     - on Linux it forces X11 (it runs under XWayland);
     - it adds about 100 MB compressed and 311 MB installed;
     - it would make us re-release for every Chromium security update
       (weekly);
     - our video underlay, frame pacing and window chrome would be rewritten
       against X11 child windows or off-screen rendering.

   Revisit when that runtime runs native Wayland and its off-screen rendering
   path is merged.

## The spike (what was measured)

### Conditions
- **Compositor.**
  - A nested `kwin_wayland --virtual` with a 5120x1440 output, switched to a
    239.9 Hz custom mode.
  - It rendered on the **RTX 4080**: `libdevorder.so` lists the NVIDIA DRM
    device first. `wayland-info` main device was `0xE280`
    (card1/renderD128).
  - It had its own `XDG_CONFIG_HOME`. The real
    `~/.config/kwinoutputconfig.json` was md5 `e6df1573…` before and after
    every run.
- **Clients.**
  - Every client ran with `__EGL_VENDOR_LIBRARY_FILENAMES=…/10_nvidia.json`.
  - Each was checked from `/proc`: the UI and web processes held only
    renderD128 and had `libnvidia-eglcore` mapped.
  - Chromium's WebGL reported `ANGLE (NVIDIA … RTX 4080 …)`.
  - Every window was maximized: WebKit spikes 5120x1440, the app and Chromium
    5120x1412.
- **Isolation.**
  - Clients ran under `bwrap` with no `/dev/snd` and the real
    PipeWire/Pulse sockets covered.
  - `PULSE_SINK=glass_g23_out`.
  - Chromium used a fresh profile and `--password-store=basic` (no keyring).
  - Nothing ran on the owner's display or touched the owner's running client.
- **Same WebKit.**
  - WebKitGTK 2.52.6 for both APIs: the system `webkit2gtk-4.1` and Arch's
    `webkitgtk-6.0-2.52.6-1` package, signature checked.
  - The 6.0 package was extracted and overlaid onto `/usr` inside the
    sandbox only; nothing was installed.
  - GTK 3.24.52 and GTK 4.22.5.
- **The page** (`frame-test.html`). Each phase ran for 6 s:

| Phase | What the page does |
|---|---|
| `idle-raf` | rAF loop alone |
| `css-anim` | CSS transform animation, main thread idle |
| `css-anim-raf` | the same plus an rAF counter |
| `raf-anim` | transform written in rAF |
| `scroll` | `scrollBy({behavior: 'smooth'})` of 600 px every 300 ms through 600 rows |
| `scroll-glass` | the same under a `backdrop-filter: blur(24px)` header |
| `glass` | three blurred glass panels over drifting color |

- **Presented frames.**
  - GTK 4 spike: `GdkFrameTimings` presentation times, which GTK 4 fills
    from `wp_presentation`.
  - The app: its own `PARACORD_FRAME_TRACE`.
  - Chromium: its `wp_presentation_feedback.presented` events
    (`WAYLAND_DEBUG=client`).
  - In every case: CLOCK_MONOTONIC, a 239.9 Hz grid, and the same analysis
    (`pacing.py` from the frame-pacing pass).
  - Page cadence: rAF timestamps, scroll events, and `scrollTop` changes per
    rAF.

### Results (5120x1440 at 239.9 Hz, RTX 4080)

Presented fps / share of frames one refresh apart. "rAF" is the page's
callback rate. Two or three runs each (one for Vulkan); ranges cover them all.
CPU is the process tree's average over the phase, in percent of one core (one
run; see the caveat under the table).

| Phase | GTK 3 app (shipped path) | GTK 4 + WebKit 6.0, `ngl` | GTK 4, default Vulkan renderer | Chromium 153, native Wayland |
|---|---|---|---|---|
| css-anim | 197 fps, 87% 1v | 206 to 211 fps, 94 to 95% | 34 fps, 6v | 213 fps, 96% |
| glass | 191 to 193, 86 to 89% | 199 to 201, 90 to 91% | 33, 6v | 207 to 210, 94 to 96% |
| raf-anim | **63**, 4v (rAF 62) | **62**, 4v (rAF 62) | 39 (rAF 39) | 199 to 201, 88 to 90% (rAF 219 to 221) |
| scroll | **49 to 53**, 4v (scroll events 51 to 52/s) | **53 to 56**, 4v (51 to 53/s) | 31 | 192 to 195, 87% (201/s) |
| scroll-glass | 51 to 54, 4v | 53 to 56, 4v | 29 | 212 to 213, 96 to 98% |
| idle rAF | 62/s | 62/s | 62/s | 240/s |
| CPU, whole tree, css-anim / glass / scroll | 35% / 41% / 12% | 13% / 19% / 7% | – | 12% / 25% / 27% |

With WebKit's display link ticking at 240 Hz (test shim `libvblemu2.so`) and
`PreferPageRenderingUpdatesNear60FPS` off:

| Phase | GTK 3 app + display link 240 | GTK 4 `ngl` + display link 240 |
|---|---|---|
| css-anim | 195 to 196, 88 to 89% 1v | 205 to 212, 94 to 96% |
| glass | 199 to 216, 90 to 98% | 211 to 212, 95 to 96% |
| raf-anim | **208 to 213, 91 to 98%** (rAF 216 to 226) | **204 to 212, 94%** (rAF 217 to 225) |
| scroll | **207 to 208, 93 to 96%** (scroll events 217 to 223/s) | **193 to 204, 96%** (208 to 229/s) |
| scroll-glass | 203 to 209, 97% | 178 to 205, 93 to 98% |
| idle rAF | 240/s | 240/s |
| CPU, raf-anim / scroll / glass | 37% / 21% / 45% (14% / 12% / 41% at 60) | 10% / 15% / 21% |

Chromium under XWayland (`--ozone-platform=x11`, what `tauri-runtime-cef`
forces): rAF 216 to 240/s, scroll events 204 to 208/s. Presented frames
there are Xwayland's, not measured.

Notes:
- **CPU caveat.**
  - The GTK 3 column is the full app: Tauri runtime, the frame pacer, idle
    media threads. The GTK 4 column is a 200-line spike.
  - At the same frame rate the GTK 4 tree used about a third of the app's
    CPU. That fits GTK 3's per-paint cost measured in `desktop-framerate.md`.
  - It is not a like-for-like app comparison.
- **The video-underlay shape on GTK 4.**
  - A 1920x1080 texture replaced at 60 Hz filled the window under a fully
    transparent webview (`SPIKE_UNDERLAY`).
  - The page's CSS animation still presented 198 fps (89% 1v), and glass
    205 fps (93%).
  - On GTK 3 the app's call view, transparent over a native video, runs 39
    to 47 fps (`desktop-framerate.md`).
  - The difference: GSK blends the transparent webview on the GPU; GTK 3
    does it with cairo and a texture upload.
- **Turning `PreferPageRenderingUpdatesNear60FPS` off alone changes nothing**
  (idle rAF stays 62) while the display link is the 60 Hz timer. With the
  feature left on and a 240 Hz display link, the page would still be paced
  at 60.
- **The DRM vblank monitor cannot work on the owner's machine, for two
  reasons.** Both are confirmed:
  1. The connector `HDMI-A-1` on card1 now reports `encoder_id 0` (atomic
     KMS), so WebKit's CRTC lookup skips it. This is new since the
     frame-pacing pass.
  2. `drmWaitVBlank` returns `EPERM` to a non-master client on nvidia-drm.

  The journal shows `Could not create a vblank monitor for display 1: no drm
  node with CRTC found` → `falling back to timer` for both APIs.

### Memory (built client's first screen, PSS of the whole process tree)

| Engine | PSS | Processes |
|---|---|---|
| GTK 3 + WebKitGTK 4.1 | 448 MB | UI 183, web 213, network 52 |
| GTK 4 + WebKitGTK 6.0 (`ngl`) | 466 MB | UI 136, web 277, network 53 |
| Chromium 153 | about 592 MB | 12 processes; excludes `plasma-browser-integration`, which Chromium started |

The built client (`client/dist`, no server, so its error screen) rendered
correctly in all three (screenshots in the checkpoint).

## Why 240 is not reached on either WebKitGTK

The diagnosis is in `desktop-framerate.md`; the spike adds that **GTK 4 does
not change it**:

1. **WebKit's display link.**
   - `DisplayVBlankMonitor::create` tries the DRM monitor, then falls back to
     `DisplayVBlankMonitorTimer`.
   - That timer is `sleep_for(1000 / 60)` (WebKit `Source/WebKit/UIProcess/glib/`,
     tag `webkitgtk-2.52.6`).
   - WebKitGTK 6.0 uses the same code. There is no `GdkFrameClock` use in
     `WebKitWebViewBase`.
   - Upstream: bug 199376 "View is locked to 60 FPS" is open since 2019. A
     2026-10-12 comment there on 2.54.1 says the same.
2. **`PreferPageRenderingUpdatesNear60FPS`.** Stable, default on in the GTK
   ports, settable through `webkit_settings_set_feature_enabled`.
3. **GTK 3 only: the GL frame clock at 60.**
   - Fixed in the app by `linux_frame_clock.rs`; upstream this is GTK work
     item 8461 (2026-10-12).
   - GTK 4's clock follows the compositor without help. The GTK 4 spike
     presents 199 to 215 fps on compositor motion with no patch at all.

## Routes compared

| | A. GTK 4 + WebKitGTK 6.0 | B. Chromium (Tauri CEF runtime) | C. Stay GTK 3 / 4.1, fix display link |
|---|---|---|---|
| **Frame timing, compositor motion** | 199 to 215 fps (`ngl` only; Vulkan 29 to 39) | 199 to 213 | 191 to 209 (today) |
| **Frame timing, scroll / rAF** | about 60 until WebKit's display link is fixed; then 178 to 212 | 192 to 213 today | about 60 until fixed; then 203 to 213 |
| **CPU at those rates (test page)** | lowest: 7 to 21% (spike) | 12 to 30% | 11 to 45% (full app) |
| **Memory (client first screen)** | 466 MB | about 592 MB | 448 MB |
| **Download / installed** | system library (webkitgtk-6.0: 36 MB download, 131 MB installed on Arch; already present on GNOME desktops) | +about 102 MB xz, 311 MB installed (CEF 154 minimal, en-US, stripped), bundled in every package | unchanged |
| **Native video underlay** | rewrite (`GtkGLArea` API changed; `GtkOverlay`/`GtkFixed` subclassing changed); opportunity: `GdkDmabufTexture` + `GtkGraphicsOffload` subsurface, GPU blending | rewrite against an X11 child window (windowed) or off-screen rendering (Tauri PR #16225, open) | unchanged |
| **Frame pacing patch** | deleted (GTK 4 does it) | not needed (Chromium paces itself) | kept |
| **Window chrome** (CSD, resize, double click, app id) | port: `GdkToplevel` begin_move/resize, `gtk-titlebar-double-click` stays, `gdk_wayland_toplevel_*`, no `announce_csd` (GTK 4 decides CSD itself) | runtime-provided; X11 under XWayland: app id becomes `WM_CLASS` only | unchanged |
| **Tray, deep links, notifications, keyring, portal capture, file dialogs** | tray (libappindicator/muda GTK 3) → ksni (StatusNotifierItem) as Tauri v3 does; dialogs: `rfd` → portal backend; others engine-independent | same as A; screen capture under XWayland needs Chromium's PipeWire capturer flag if we ever use `getDisplayMedia` (we capture natively) | unchanged |
| **Cross-platform consistency** | Linux stays WebKit like macOS; Windows stays WebView2 | Linux becomes Chromium like Windows; macOS is CEF in that runtime or WKWebView | as today |
| **Packaging** | `webkitgtk-6.0` + GTK 4 runtime deps; Ubuntu 22.04 has no webkitgtk-6.0 (drop it, or AppImage only); AppImage needs linuxdeploy-plugin-gtk with GTK 4 and our bundler fix; `finalize-appimage.sh` still needed | Chromium bundled; Tauri's AppImage path is quick-sharun, not linuxdeploy (#16204); release cadence tied to Chromium security fixes | unchanged |
| **Upstream state** | no released Tauri stack; wry#1767 and tao#1104 unmerged; Tauri v3's wry runtime still GTK 3 (`tauri-runtime-wry` 3.0.0-alpha.4) | `tauri-runtime-cef` 3.0.0-alpha.5 (2026-10-01), XWayland only, open Linux bugs (#16189 idle 100% CPU, #16251 keyboard input lost, #16131 drag and drop) | WebKit patch needed (C2); C1 needs nothing upstream |
| **Effort** | XL (forks or own runtime) or M (on Tauri's own GTK 4) | XL (Tauri v3 migration + native pieces rewrite) | S (C1) + M (C2, upstream review time) |
| **Risk** | NVIDIA renderer choice; carrying forks; video underlay rewrite | alpha runtime; X11-only; size; security cadence | the upstream patch's timing |

## Route C work packages (recommended now)

| WP | What | Size | Depends on | Risk |
|---|---|---|---|---|
| **C1** | Turn `PreferPageRenderingUpdatesNear60FPS` off on the main webview through `webkit_settings_get_all_features` / `webkit_settings_set_feature_enabled`. Raw FFI: the `webkit2gtk` 2.0.2 crate binds only up to `v2_40`. Log the result in the client log. Fail loudly if the feature is missing (WebKitGTK < 2.42). | S (half a day + tests) | – | Nothing visible changes while the display link is the timer. On machines where WebKit's DRM monitor works (Mesa, matching connector), rAF and scrolling should rise to the refresh rate at once. **Unverified: needs a real AMD/Intel display.** Watch CPU: page updates up to 4x as often. |
| **C2** | WebKit patch, upstream: `DisplayVBlankMonitorTimer` at the screen's refresh rate (from `ScreenManager`/`gdk_monitor_get_refresh_rate`) on absolute deadlines. Optionally a GTK monitor fed by the toplevel's `GdkFrameClock`. Plus a fix for the `encoder_id == 0` CRTC lookup (use the connector's `CRTC_ID` property). File it under bug 199376. | M (patch + review; weeks to months to a stable release) | – | Upstream may prefer a different design; the timer change is small and defensible. |
| **C3** | Frame-timing gate (below) in the repo, with this page's test page and analysis, so C1/C2 and any later route are measured the same way. | M | – | – |
| **C4** | When a WebKitGTK release with C2 is in Arch: rerun the gate on the owner's machine (`PARACORD_FRAME_TRACE=1`). | S | C2 | – |

**Not recommended: an in-process display-link shim.** The app would export
its own `drmWaitVBlank`, `gdk_monitor_get_{width,height}_mm`,
`drmModeGetConnector` and `drmModeGetEncoder`. That works (it is what the test
shim does), but it hijacks system library symbols for the whole process, which
the frame-pacing pass already rejected, and it is exactly the kind of hidden
second path the project avoids.

## Route A: GTK 4 + WebKitGTK 6.0, phased

For when the tripwire fires, or the owner chooses it. Sizes: S ≤ 2 days, M ≤ 1
week, L ≤ 3 weeks, XL > 3 weeks.

### How it would be done

| Option | Assessment |
|---|---|
| **A-up. Wait for Tauri's GTK 4.** | Preferred. Tauri v3 has a per-runtime GTK version (`tauri_runtime::gtk::declare_version`, tauri#15787, 2026-09-12); maintainers have chosen `tauri-winit-gtk4` over porting tao (amrbashir, tao#1258, 2026-07-03). A GTK 4 wry runtime is not on a published branch. |
| **A-fork. Fork tao + wry to GTK 4 ourselves.** | wry#1767 (Ranrar, gtk4 0.11 / webkit6 0.6, verified in a Tauri app on Debian 13) and tao#1104 exist but are unreviewed. We would carry tao, wry, tauri-runtime-wry and muda forks across every Tauri update. XL, high maintenance. |
| **A-own. Our own Linux runtime implementing `tauri_runtime::Runtime` on gtk4 + webkit6.** | The trait surface (windows, webviews, events, menus, tray, dialogs, IPC, custom protocols) is large. XL+; only if Tauri drops GTK and we refuse CEF. |

### Work packages (A-up)

| WP | What | Size | Depends on | Risk |
|---|---|---|---|---|
| A0 | Tauri v3 migration on all platforms (API changes, plugins, runtime selection). Separate from GTK 4, but a prerequisite for A-up. | L | Tauri v3 beta | v3 churn |
| A1 | **Build both.** A `gtk4` cargo feature on `paracord-desktop` selecting the GTK 4 runtime. The GTK 3 build stays the default until A9. CI builds both on Linux. | S | A0 | feature drift |
| A2 | **Startup and transport.** `linux_webkit.rs`: drop the `GDK_GL=always` rule (GTK 4 always paints with GL). Set `GSK_RENDERER=ngl` when NVIDIA EGL is active and the user set none. Log the renderer (`gtk_native_get_renderer`). Keep the explicit-sync check: WebKit 6.0 hands GTK dmabufs, and GTK 4 never commits `wl_shm` on a GL window. | S | A1 | the NVIDIA Vulkan result may change with GTK/driver updates: re-measure, do not assume |
| A3 | **Delete `linux_frame_clock.rs`.** Keep `PARACORD_FRAME_TRACE` by reading `GdkFrameTimings` presentation times (the spike's 40 lines). | S | A2 | – |
| A4 | **Window chrome and identity** (`window_chrome.rs`, `app_identity.rs`). <br>- `GdkToplevel::begin_resize` / `begin_move`. <br>- No `gdk_wayland_window_announce_csd`: an undecorated GTK 4 window is CSD. <br>- `gtk_window_set_icon_name` plus the installed hicolor icons. GTK 4 has no `set_icon_list`, so X11 `_NET_WM_ICON` comes from the icon theme. <br>- `glib::set_prgname` is unchanged. <br>- `gdk_x11_set_program_class`: GTK 4 sets `WM_CLASS` from the program name, so check it. <br>- The double-click setting is unchanged (`gtk-titlebar-double-click`). | M | A1 | X11 icon and `WM_CLASS` details |
| A5 | **Native video underlay** (`native_render/linux.rs`, 1489 lines). See "The video underlay on GTK 4" below. | L | A2 | **the hardest piece**: GTK 4's `GtkGLArea` renders into a texture that GSK composites, and the hole-punch model changes |
| A6 | **Tray and menus.** muda/tray-icon on GTK 3 + libappindicator become whatever the runtime ships (ksni in Tauri v3). | S to M | A0 | tray menu parity |
| A7 | **Dialogs.** `tauri-plugin-dialog` → `rfd` with the xdg-portal backend (GTK 4 has no `GtkFileChooserDialog` in the same form). Clipboard (arboard), notifications (notify-rust over D-Bus), deep links (D-Bus single instance + desktop entry), keyring (Secret Service over zbus), screen capture (`scap` → portal + PipeWire): **engine-independent, no change**. | S | A0 | – |
| A8 | **Packaging.** <br>- deb `Depends`: `libwebkitgtk-6.0-4`, `libgtk-4-1`. <br>- rpm: `webkitgtk6.0`, `gtk4`. <br>- AppImage: linuxdeploy-plugin-gtk with `DEPLOY_GTK_VERSION=4`; the bundler's webkit2gtk-4.1 helper directory becomes `webkitgtk-6.0`. <br>- `finalize-appimage.sh` keeps removing the bundled libwayland, same failure mode. <br>- The fresh-machine image gains WebKitGTK 6.0. | M | A1 | Tauri bundler changes for GTK 4 |
| A9 | **Parity and switch.** <br>- All gates below green on the GTK 4 build. <br>- Then GTK 4 becomes the Linux default. <br>- The GTK 3 build stays selectable for one release. | M | A2 to A8 | – |
| A10 | **Remove GTK 3.** One release after A9 with no regressions reported. | S | A9 | – |

### The video underlay on GTK 4 (A5)

**Today:**
- A `gtk::Overlay` holds `UnderlayFixed` with one `GtkGLArea` per track, under
  the reparented WebKit webview.
- The webview turns transparent while a surface exists, and the DOM punches
  holes.
- Frames arrive as CPU I420 and are uploaded with `glTexSubImage2D`.
- At 5120x1412, GTK 3's blend of the transparent webview costs 9 to 13 ms
  per paint, so the call view's theater moves run at 39 to 47 fps.

**On GTK 4:**
1. **Same shape, ported.** `GtkOverlay` + a `GtkWidget` subclass with
   `measure()` returning 0 (replaces `UnderlayFixed`'s `get_preferred_*`).
   `GtkGLArea` still exists, but renders to a texture GSK composites, and
   `make_current`/`queue_render` semantics are the same. The webview's
   transparency is blended by GSK on the GPU, with no cairo ground and no
   texture upload.
   - The spike measured a 1920x1080 texture replaced at 60 Hz under a fully
     transparent webview at 5120x1440: 198 to 205 fps on the page's motion,
     against 39 to 47 on GTK 3's call view.
2. **Better: no GL in our code.** Build a `GdkMemoryTexture` (CPU I420→RGB is
   a cost we pay now in the shader) or a `GdkDmabufTexture` per decoded frame,
   and show it in a `GtkPicture` inside a **`GtkGraphicsOffload`**.
   - GTK then puts the video in its own Wayland subsurface when it can, and
     the compositor blends it.
   - This is the "video in subsurfaces" fix `desktop-framerate.md` asks for,
     done by GTK.
   - Offload needs a dmabuf texture and a compositor that accepts it; it
     falls back to normal compositing silently. Our no-fallbacks rule means
     logging which one happened per surface.
3. Rounded corners and the premultiplied mask move from our shader to
   `GtkWidget` CSS (`border-radius` with `overflow: hidden`) or a
   `GskRoundedClipNode`. Offload is lost under a rounded clip in some GTK
   versions: measure.

**Risks:**
- dmabuf import of NVIDIA buffers into GSK `ngl`;
- whether KWin accepts the offloaded subsurface;
- input still goes to the webview: overlay order unchanged, the video below
  takes no input.

## Route B in more detail (for the record)

- **What it is.** `tauri-runtime-cef` 3.0.0-alpha.5 on CEF 152 (cef-rs, binaries
  from Spotify's CDN through `download-cef`). Windowing is `tauri-winit-gtk4`.
  It is on the `v3` branch, last commit 2026-10-12.
- **On Linux it forces `--ozone-platform=x11` and `GDK_BACKEND=x11`.** It
  hosts browsers in X11 child windows, so on a Wayland desktop it is always
  XWayland.
  - Measured here: Chromium under XWayland keeps rAF and scrolling at about
    205 to 240/s on the RTX 4080.
  - XWayland brings X11 window identity (no `xdg_toplevel.set_app_id`), X11
    fractional scaling and no Wayland-native input.
- **Our native pieces.**
  - The underlay would have to become an X11 sibling window (no transparency
    across it) or move to off-screen rendering (`OnAcceleratedPaint`
    dmabufs, Tauri PR #16225 open) composited by us.
  - The frame-pacing work and the GTK window chrome would be dropped.
  - Tray, deep links, notifications, keyring and capture are
    engine-independent.
- **Cost.**
  - About 102 MB more per download and 311 MB installed.
  - Chromium ships stable security fixes weekly and a major every 4 weeks.
    With CEF bundled, each one means rebuilding and re-releasing the app, or
    knowingly lagging.
  - The runtime pinned CEF 152 while 154 was current, so it already lags.
- **Upside.** The same engine as Windows (WebView2), and the frame-timing
  problem disappears without patches.
- **When to revisit:**
  - native Wayland in the runtime;
  - OSR merged;
  - v3 GA;
  - a Linux bug list without input-loss bugs.

## Windows and macOS

- **Route C** touches only Linux code: `linux_webkit.rs` and a WebKit patch.
- **Route A** is Linux-only:
  - The `gtk4` feature, the deleted frame clock and the underlay port are all
    under `cfg(target_os = "linux")`.
  - A0, the Tauri v3 migration, does touch every platform. Windows (WebView2)
    and macOS (WKWebView) keep their engines and native render backends
    (`native_render/{windows,macos}.rs`).
  - The `cross-platform-smoke` job and the Windows cross-check
    (`x86_64-pc-windows-gnu`) must stay green on every A package.
- **Route B** would change macOS too if the CEF runtime were used everywhere.
  Tauri v3 lets the runtime be chosen per platform in code, so Linux-only CEF
  is possible.

## Packaging and distro support

| Distro | webkitgtk-6.0 | GTK 4 | Today (4.1) |
|---|---|---|---|
| Arch / CachyOS | 2.54.1 (`extra/webkitgtk-6.0`) | 4.24 | yes |
| Ubuntu 22.04 | **not packaged** | 4.6 | yes |
| Ubuntu 24.04 | 2.52.6 | 4.14.5 | yes |
| Ubuntu 26.04 | 2.52.6 | 4.22 | yes |
| Debian 12 | 2.50.6 | 4.8.3 | yes |
| Debian 13 | 2.52.6 | 4.18.6 | yes |
| Fedora 43 / 44 (`webkitgtk6.0`) | 2.54.1 | 4.20 / 4.22 | yes |
| Flatpak GNOME 50 runtime | both | – | – |

- **Route A drops Ubuntu 22.04 for deb.** Its standard support ends
  2027-04; check whether any user is still on it before A8.
- **Debian 12's GTK 4.8** predates `GdkDmabufTexture` (4.14) and graphics
  offload (4.14). The underlay's better path (A5.2) needs GTK ≥ 4.14, so
  Debian 12 would get only the ported GLArea path, or be dropped too.
- **AppImage:** linuxdeploy-plugin-gtk supports GTK 4. The libwayland problem
  `finalize-appimage.sh` fixes applies the same way.

## Rollback

- **Route C** has nothing to roll back. C1 is one setting; reverting is one
  commit.
- **Route A:**
  - The GTK 3 build stays a supported, CI-built configuration until A10.
  - Released packages carry the GTK 4 build only after A9. The updater can
    ship a GTK 3 build again by flipping the default feature.
  - No data or config format changes with the toolkit, so the user profile is
    shared.
  - `GSK_RENDERER` stays overridable by the user's environment, as
    `linux_webkit.rs` already respects existing variables.
- **Route B:**
  - A profile downgrade issue exists in Chromium: profiles migrate forward
    only, and the runtime has a `downgrade` module.
  - It also changes where the webview's storage lives: WebKit's
    localStorage/IndexedDB vs Chromium's. Rolling back loses webview-side
    storage unless we migrate it.

## Test plan

1. **Frame-timing gate (new; C3).**
   - What it runs:
     - this spike's page (`frame-test.html`, seven phases);
     - `pacing.py`;
     - the nested-KWin harness: virtual 5120x1440 output at 239.9 Hz, NVIDIA
       forced, own config dir, `bwrap` audio isolation.
   - Pass:
     - compositor phases ≥ 180 fps with ≥ 85% at one refresh;
     - after C2 lands, also scroll and raf-anim;
     - GPU identity asserted from `/proc` (no silent iGPU run, the trap
       earlier passes fell into).
   - **Where it runs:** CI has no GPU, so it runs on the dev box (and any
     self-hosted GPU runner later). The job also asserts the real
     `kwinoutputconfig.json` is unchanged.
   - On a real display: `PARACORD_FRAME_TRACE=1` on the owner's machine,
     same analysis.
2. **CPU.**
   - A 240 Hz page loop costs more main-thread work.
   - The gate records per-phase CPU of the process tree (the spike's
     `cpusample.sh`).
   - The owner's "performance over fidelity" rule means C1/C2 ship only if
     idle CPU is unchanged and motion CPU is reported.
3. **Existing gates, unchanged, on every package:**
   - client typecheck, unit, lint, motion lint;
   - the Index e2e suites;
   - `live-drive` (three real accounts);
   - the fresh-machine gate (`setup-s13`/S15 lab: deb install, scheme,
     keyring);
   - `cargo clippy -D warnings`;
   - the Windows cross-check;
   - `cross-platform-smoke`.
4. **Route A additions:**
   - the gate on both builds (GTK 3 and GTK 4) side by side;
   - the video underlay checks from `video-min-size.md` and the frame-pacing
     pass (call view with Vincent's stream, theater toggles, min size,
     minimize/restore);
   - the window-chrome checks (`WAYLAND_DEBUG` app id, KWin
     `desktopFileName`, X11 `WM_CLASS`, Xvfb hover);
   - fresh-machine images for Ubuntu 24.04, Debian 13 and Fedora with
     WebKitGTK 6.0.

## When to revisit

- **GTK 4 (A-up)**, when any of these happens:
  - Tauri publishes a wry runtime on GTK 4 (watch tauri `v3`, wry#1767,
    `tauri-winit-gtk4`);
  - the call view's 39 to 47 fps becomes the top complaint (GTK 4 + offload
    is its fix);
  - Tauri announces the end of GTK 3 support.
- **Chromium (B)**, when `tauri-runtime-cef` runs native Wayland and merges
  OSR.
- **C2 status:** at each WebKitGTK stable release (2.56 is due about March
  2027).

## Still unknown

- **C1 on a machine where WebKit's DRM monitor works** (Mesa, real display).
  Expected: rAF and scroll at the refresh rate today. Not testable in a
  nested session (no real connector).
- **Real-display numbers.** The nested virtual output reports no vblank
  counter. The owner's real panel through KWin's DRM backend may pace
  differently (direct scan-out, tearing control).
- **GTK 4 Vulkan on NVIDIA at small sizes:** 129 to 159 fps at 1440x900,
  against 34 at 5120. Whether a newer GTK (4.24 "frame clock fixes") or
  driver changes it is unmeasured.
- **WebKitGTK 2.54** (Skia compositor, damage-limited composition) was not
  measured. Arch's mirror here still served 2.52.6.
- **CPU at 240 Hz page updates** on the full Index client (only the test
  page was measured).
- **The Chromium memory figure** includes no Tauri runtime overhead, and
  `tauri-runtime-cef` was not built here.
- **Fractional scaling** (the owner runs 1.0) and multi-monitor mixed refresh
  rates.

## Sources (accessed 2026-10-13)

- **WebKit source**, tag `webkitgtk-2.52.6`:
  `Source/WebKit/UIProcess/glib/DisplayVBlankMonitor{,DRM,Timer}.cpp`.
- **WebKit bugs** (bugs.webkit.org):
  - 199376 "View is locked to 60 FPS" (open; comment 2026-10-12);
  - 315997 (2026-06-01, KWin timer fallback ~30 fps);
  - 325789 (2026-09-30, monitor size mismatch on NVIDIA);
  - 281134 (2024-10-09, `GSK_RENDERER=vulkan` WebView cost).
- **GTK** work item 8461 (2026-10-12, GTK 3 GL frame clock).
- **Tauri:**
  - tao#1051, tao#1104 (draft, updated 2026-08-18), tao#1258 (closed
    2026-07-31; amrbashir 2026-07-03, FabianLars 2026-07-06/07);
  - wry#1474, wry#1767 (open, updated 2026-09-19), wry#1530;
  - tauri#7335, #12561–12563, #14684, #15787 (merged into `feat/cef`
    2026-09-12);
  - tauri#14963 (CEF discussion; FabianLars 2024-12-20, 2026-02-17,
    2026-04-03, 2026-05-18);
  - tauri#16189, #16203, #16204, #16205, #16131, #16251, #16249, #16225 (OSR
    PR, 2026-10-07).
- **crates.io:**
  - `tauri-runtime-wry` 3.0.0-alpha.4;
  - `tauri-runtime-cef` 3.0.0-alpha.0 (2026-09-13) to alpha.5 (2026-10-01);
  - `tauri-winit-gtk4` 0.31.0-beta.3 (2026-09-12);
  - `webkit6` 0.6.1 (2026-03-11; features to `v2_52`);
  - `gtk4` 0.11.5 (2026-09-20);
  - `webkit2gtk` 2.0.2 (2025-12-16; features to `v2_40`);
  - `cef` 154.5.0 (2026-10-07).
- **CEF binary:** `cef_binary_154.0.34…_linux64_minimal` measured by the
  research pass. 311 MB download; stripped en-US runtime 311 MB installed,
  about 102 MB xz.
- **Distros:** Arch package database (`webkitgtk-6.0`), Launchpad (Ubuntu
  22.04/24.04/26.04), Debian tracker (12/13/sid), Fedora packages (43/44),
  Flathub GNOME 50 runtime manifest.
- **Chromium on Linux:**
  - chromium-discuss 2026-07-21 (Ozone/Wayland vsync interval from the first
    mode);
  - NVIDIA developer forum 2026-05-31 (Wayland dmabuf import crash, X11
    works);
  - Google Security Blog 2023-08 (weekly stable security updates);
  - tauri#5889 (memory, 2022-12-21).
