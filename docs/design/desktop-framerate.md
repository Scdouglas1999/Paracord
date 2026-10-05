# Desktop frame rate (Linux, NVIDIA, 2026-10-05)

The owner reported that the app's frame rate on the desktop was far below the
monitor's 240 Hz. The machine is an RTX 4080 on driver 615.71.09 under KDE
Plasma Wayland (KWin 6.7.5), with one 5120x1440 monitor at 240 Hz on HDMI-A-1.
WebKitGTK is 2.52.6 (webkit2gtk-4.1, GTK 3.24.52).

This page covers what limited the frame rate, what changed (`9812e663`), the
measurements before and after, and why 240 Hz cannot be reached on this stack.

## Summary

- **The main cost was the shared-memory frame path.** On every NVIDIA
  machine the app forced `WEBKIT_DMABUF_RENDERER_FORCE_SHM`. Each frame was
  then copied three times:
  1. The web process read it back into shared memory.
  2. GTK painted it into a new `wl_shm` window buffer with full-window damage.
  3. KWin uploaded that buffer again.

  At 5120x1412 that is about 29 MB per copy. Motion presented at **24 to 39
  frames a second**, and the web process itself fell to 28 to 53 rAF/s.
- **The old reason for shared memory was a Wayland protocol error, not a
  GBM failure.** On the dmabuf path KWin disconnects the app with
  `wp_linux_drm_syncobj_surface_v1: explicit sync is used, but no acquire point is set`.
  The sequence is:
  1. NVIDIA's EGL (egl-wayland2) puts the window's surface under explicit
     sync the first time GTK draws a WebKit frame with EGL.
  2. GTK 3 commits a cairo `wl_shm` buffer on that same surface.

  Mesa does not use explicit sync, so it never hits this.
- **The fix.** On NVIDIA under Wayland the app now leaves WebKit on its GPU
  (dmabuf) transport and sets `GDK_GL=always`, so GTK paints every frame with
  EGL from the first one. Motion presents at **54 to 60 frames a second at
  5120x1412**, and app CPU per frame drops.
- **NVIDIA on X11 keeps shared memory.** There the GPU path paints nothing:
  the window shows only its background and rAF never fires (nested Xwayland).
- **240 Hz is not reachable with WebKitGTK 4.1 / GTK 3, at any window size.**
  Three separate 60 Hz limits apply; see "Why not 240". Even with two of them
  bypassed by test shims, presentation stayed at exactly 60 Hz (16.7 ms
  gaps), including at 1440x900.
  *Superseded by the second pass below:* the third limit (GTK 3's frame clock)
  is lifted from the app, and animations that run on WebKit's compositor now
  present at up to the display's 240 Hz. What the page's main thread drives
  (scrolling, `requestAnimationFrame`) is still held near 60 by limit 1.

## How it was measured

Nothing ran on the owner's display or touched the owner's client (pid
1348020) or server (pid 1203).

### The nested session

- **The compositor.** A nested `kwin_wayland --virtual` with a 5120x1440
  output, switched with `kscreen-doctor ...addCustomMode.5120.1440.240000.full`
  to a **239.9 Hz** custom mode (KWin's virtual backend lists only 60 Hz
  natively).
- **GPU selection, and the earlier runs.**
  - KWin's virtual backend renders on the first DRM device libdrm lists,
    which is the AMD iGPU (renderD129). The app's EGL then follows it to
    Mesa. **Earlier nested checks (the Glass and IX-20 release checks) ran
    the app on the AMD iGPU, not on the NVIDIA card the owner uses.**
  - For this pass, a capability-free copy of `kwin_wayland` with an
    `LD_PRELOAD` that lists the NVIDIA device first put the nested
    compositor on renderD128. The app's UI and web processes then held only
    renderD128 and loaded `libnvidia-eglcore`, as the owner's running
    client does.
  - KWin's config was redirected (`XDG_CONFIG_HOME`), because a nested KWin
    otherwise writes its virtual output into the real
    `~/.config/kwinoutputconfig.json`.
- **The app.**
  - The test build was release `paracord-desktop`: vpx on, no
    `custom-protocol`, devUrl on :1437 through `TAURI_CONFIG`.
  - It served the production build of `6da9bf52`, with an in-page driver
    (no `eval`) and a live instance on :18486.
  - The scene came from `index-scene.mjs`: Vincent sharing a VP9 screen in
    Game Night's Lounge, plus 240 seeded messages in Basecamp's builds
    channel.
- **Audio safety.** The app ran under `bwrap` with `/dev/snd` replaced by an
  empty tmpfs and the real PipeWire and PulseAudio sockets covered. Its
  audio went to a private PipeWire graph that had two null nodes and was
  itself under the same `bwrap`. An app without any audio sink refuses to
  watch a stream ("Your speakers could not be opened"); no fallback.

### The metrics

- **Presented frames.** The app ran with `WAYLAND_DEBUG=client`, and every
  `wl_surface.commit` of the toplevel was counted between markers the page
  writes to stderr (`append_client_log`).
  - "Active fps" counts only gaps under 100 ms, so the pauses between two
    clicks are not read as slow frames.
  - On the shared-memory path GTK commits on every compositor frame even
    when WebKit has no new frame. At 1440x900 it commits 160 to 175 times a
    second, but WebKit's content still changes at most 60 times a second.
  - What a person sees is the lower of commits and rAF.
- **Page cadence.** `requestAnimationFrame` timestamps in the page during
  the same window.
- **CPU.** `top -b -d 1` on WebKitWebProcess and the app process, without
  `WAYLAND_DEBUG`, in percent of one core. The host was shared with other
  agents' work (load average 5 to 9), so CPU readings carry a few points of
  noise.

### The motions

| Motion | What was driven |
|---|---|
| glide | click the next sidebar channel every 450 ms (the selection glide and the conversation swap) |
| switch | switch server in the dock every 900 ms |
| composer | the message box grows to five lines and back every 500 ms (the feed FLIP) |
| scroll | smooth `scrollBy` of 600 px every 300 ms in a 240-message channel |
| call open | open the call view with Vincent's stream (Watch), go back, repeat |
| stage | toggle theater every 1.5 s with the stream playing |

## Results

"Before" is the shipped behavior (shared memory). "After" is `9812e663`
(GPU transport with GL painting). Each cell gives active presented fps, the
share of frame gaps under 25 ms, and the page's rAF rate.

### 5120x1412 (maximized)

| Motion | Before | After |
|---|---|---|
| glide | 35 fps, 7%, rAF 28 | **58 fps, 97%**, rAF 50 |
| switch | 39 fps, 45%, rAF 53 | **59 fps, 98%**, rAF 56 |
| composer | 32 fps, 1%, rAF 38 | **59 fps, 97%**, rAF 59 |
| scroll | 33 fps, 36%, rAF 51 | **54 fps, 93%**, rAF 61 |
| call open | 33 fps, 58% | **39 fps, 73%** |
| stage (theater) | 45 fps, 75% | 47 fps, 78% |

Once a video has been shown, the shipped build also paints its window with
EGL: the GLArea gives the window a GL paint context. From then on it does
better than the cold "before" column:

| Motion | Before, after a video was shown |
|---|---|
| glide | 54 fps, 94%, rAF 42 |
| switch | 55 fps, 96% |
| composer | 58 fps, 96% |
| scroll | 50 fps, 89% |

The shared-memory frames themselves are still copied in that state.

### 1440x900 (window)

| Motion | Before (commits/s; content ≤ rAF) | After |
|---|---|---|
| glide | 175 commits/s, rAF 54 | 60 fps, 99%, rAF 58 |
| switch | 167 commits/s, rAF 60 | 60 fps, 100%, rAF 62 |
| composer | 167 commits/s, rAF 59 | 59 fps, 98%, rAF 61 |
| scroll | 100 commits/s, rAF 61 | 53 fps, 95%, rAF 59 |
| call open | 53 fps, 83% | 46 fps, 80% |
| stage (theater) | 47 fps, 80% | 48 fps, 81% |

At this size the shared-memory path can still reach WebKit's 60 frames a
second. It does so by re-sending the whole window on every compositor frame,
which is where its CPU goes (below).

### CPU, percent of one core

| State | WebKitWebProcess before | after | App before | after |
|---|---|---|---|---|
| 5120: glide loop (24 s) | 53.9 (at rAF 33) | 45.1 (at rAF 55) | 48.5 | 42.6 |
| 5120: watching the stream | 10.5 | 7.2 | 56.2 | 40.4 |
| 5120: idle | 2.6 | 2.5 | 1.9 | 1.3 |
| 1440: glide loop | 54.1 | 38.9 | **63.4** | **11.7** |
| 1440: watching the stream | 5.6 | 5.0 | 13.2 | 10.8 |
| 1440: idle | 1.1 | 2.5 | 0.2 | 0.5 |

- **At 5120 the new path does more frames for less CPU.** About 0.8 core
  for about 55 frames, against 1.0 core for about 33.
- **At 1440 the app process falls from 63% to 12%.** Before, GTK copied the
  whole window into a new `wl_shm` buffer about 175 times a second.
- **The app still costs about 43% at 5120 during motion against 12% at
  1440.** It scales with window area, although WebKit's frames no longer
  pass through the CPU. The likely cause, not yet verified: GTK 3's GL paint
  path renders the toplevel's CSS ground with cairo and uploads it as a
  texture every frame. It cannot skip that, because the webview is
  transparent (the video underlay needs it), so the ground must be blended
  under every WebKit frame. See "Left open".

## What changed

`client/src-tauri/src/linux_webkit.rs` decides the transport once, before
GTK starts, prints it, and writes it to the client log:

```
[webkit] frame transport: GPU (dmabuf) (NVIDIA EGL on Wayland: GPU transport, GDK_GL=always so GTK paints every frame with EGL (no shared-memory commit on an explicit-sync surface))
```

| Machine | Transport | What the app sets |
|---|---|---|
| NVIDIA EGL, GTK on Wayland | GPU (dmabuf) | `GDK_GL=always`; an existing `GDK_GL` keeps its flags and gains `always` |
| NVIDIA EGL, GTK on Wayland, `GDK_GL` contains `disable` | shared memory | `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` (GTK could not paint with GL, so the conflict would return) |
| NVIDIA EGL, GTK on X11 (`GDK_BACKEND=x11...` first, or no Wayland display) | shared memory | `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` (the GPU path paints nothing there) |
| Any other EGL | WebKit's default (GPU) | nothing |
| `WEBKIT_DMABUF_RENDERER_FORCE_SHM` or `WEBKIT_DISABLE_DMABUF_RENDERER` already set | as set | nothing |

- **Nothing switches at runtime.** The table is unit tested
  (`linux_webkit::tests`).
- **`GDK_GL` is inherited by programs the app starts.** A GTK 3 program
  opened through `xdg-open` also paints with GL, which is a supported GTK
  mode. The variable is not removed after `gtk_init`, because changing the
  environment while other threads run is not safe.
- **The native video underlay works on the new path.** It was checked with
  Vincent's stream at 5120x1412:
  - The GLArea sits under the transparent webview with clean rounded
    corners.
  - Theater and repeated theater toggles keep the video in place.
  - The app ran a full measurement session without a protocol error.
- **The underlay also gets cheaper.** On the old path the GLArea's frames
  were read back into GTK's shared-memory window buffer until the window
  switched to GL painting.

## Why not 240

On this stack three separate things pace the page at 60 Hz.

1. **WebKit's display link is a 60 Hz timer here.**
   - The DRM vblank monitor (`DisplayVBlankMonitorDRM`) needs a DRM
     connector whose physical size matches the GDK monitor's. KWin reports
     1193x336 mm; the connector says 1190x340 mm. The lookup therefore fails
     ("no drm node with CRTC found").
   - Even when matched, `drmWaitVBlank` returns `EPERM` for a client that
     is not the DRM master on nvidia-drm. A standalone test of the same
     ioctl on card1 gave the same result. The CRTC-sequence ioctls are
     `EOPNOTSUPP`.
   - WebKit then falls back to `DisplayVBlankMonitorTimer`, which sleeps
     `1000 / 60` ms per tick (about 61 to 62 Hz, unsynchronized with the
     display).
2. **`PreferPageRenderingUpdatesNear60FPS` is on by default.** WebKit would
   throttle a 240 Hz display link to 60 for page rendering updates anyway.
3. **GTK 3's frame clock paces EGL painting at 60 Hz.** In GL mode GTK
   requests no `wl_surface.frame` callbacks and no presentation feedback (0
   in the trace, against one per commit on the shared-memory path). The
   idle frame clock therefore falls back to its 16.667 ms default interval.

To check whether more was reachable, test shims bypassed the first two (they
are not shipped):

- a 240 Hz `drmWaitVBlank` and a matching monitor size for WebKit's DRM
  monitor;
- `PreferPageRenderingUpdatesNear60FPS` turned off.

Idle rAF then ran at 235 Hz, and rAF during motion at 75 to 177 Hz. Presented
frames stayed at 55 to 60 a second with 16.7 ms median gaps, at 5120x1412 and
at 1440x900 alike. The third limit (GTK 3) holds, and wry/Tauri v2 ship only
the GTK 3 WebKitGTK (4.1).

Above 60 Hz on Linux would need one of the following, each a project of its
own:

- WebKitGTK 6.0 on GTK 4, whose frame clock follows the compositor (not
  available through wry today);
- an upstream WebKit change that drives the display link from the toplevel's
  frame clock;
- process-wide interposition of `drmWaitVBlank` and the GDK monitor size,
  plus a GTK 3 frame-clock change. This was rejected: it hijacks system
  library symbols.

## Second pass: frame pacing (2026-10-05, evening)

The owner, on the build with the GPU transport (`651430c1`): the animations
"appear to run at a pretty low framerate or something … they feel jittery".
This pass measured *pacing* (when each frame reached the screen, not only how
many did), found three causes that compound, and fixed them in the desktop
shell. No client code changed.

### How pacing was measured

The nested session, scene and motions are the ones described above (KWin
`--virtual` on the RTX 4080 at 5120x1440, switched to 239.9 Hz; the app
maximized at 5120x1412; Vincent's stream; the 240-message `builds` channel).
The app ran under `bwrap` with no sound devices and a private PipeWire graph.
Nothing ran on the owner's display or touched the owner's client or server;
the nested KWin had its own config directory (the real
`kwinoutputconfig.json` was checked unchanged before and after).

New: **`PARACORD_FRAME_TRACE=1`** (`client/src-tauri/src/linux_frame_clock.rs`)
asks `wp_presentation` about every commit of the main window and prints, to
stderr:

```
[frame] commit=<µs> present=<µs> seq=<vblank> refresh=<ns> flags=<bits>
[frame] paint=<µs>                       how long GTK's paint took
[frame] answer=<µs> asked=<µs> frozen=…  the compositor's frame callback
```

From those, per motion: presented frames per second; how many refreshes each
frame stayed on screen (1v = one 4.17 ms refresh, 4v = a 60 Hz frame); the
share at the most common interval; "cadence changes", the share of
consecutive intervals that differ (an even 60 is 4,4,4,4 = 0%); gaps over
25 ms; and commit-to-screen latency. KWin's virtual output reports no vblank
counter (`seq` 0), so the analysis numbers refreshes from the presentation
times, which do sit on its 4.168 ms grid. The same trace runs on a real
display, where `seq` is the hardware counter, so the owner can capture it on
the RTX 4080 itself.

### What was wrong

1. **GTK 3's frame clock free-ran at 60 Hz, off the display's grid.** When a
   GTK 3 window paints with GL (always on NVIDIA, where the app sets
   `GDK_GL=always`; on Mesa from WebKit's first GPU frame), the commit
   happens inside `eglSwapBuffers`, GTK sets a swap interval of 0 and skips
   its own commit, and with it the `wl_surface.frame` request and the clock
   freeze (`gdk_window_impl_wayland_end_paint`, `on_frame_clock_after_paint`
   in `gdkwindow-wayland.c`). The clock then paints at most every 16.667 ms
   by a millisecond timer (`FRAME_INTERVAL` in `gdkframeclockidle.c`).
   WebKit's compositor waits for each paint before it renders the next frame
   (`AcceleratedBackingStore::frameDone`), so even animations WebKit runs on
   its compositor thread (every Index motion: Web Animations on `transform`
   and `opacity`) were held at the timer's rate. A 60 Hz timer against a
   239.9 Hz display, plus WebKit's own 61.5 Hz display-link timer, put frames
   on screen for 3, 4 or 5 refreshes in no fixed order: 50 to 80% of
   consecutive frame intervals changed length. That is the jitter.
2. **The transparent webview cost about 10 ms of UI-thread work per frame at
   5120x1412.** The webview's background was cleared at startup for the video
   underlay. WebKit then renders into buffers with alpha, and GTK 3 cannot put
   such a frame on screen directly: it paints the toplevel's ground with
   cairo into a window-sized image and uploads it as a texture to blend the
   page over (`gdk_cairo_draw_from_gl`, `gdk_gl_texture_from_surface`).
   Sampled stacks of the UI thread show `gtk_css_style_render_background` →
   `pixman_fill` and texture uploads. This is the "about 43% at 5120" left
   open above; it also stretched commit-to-screen latency to 11 to 20 ms.
3. **The clock assumed 60 Hz even when paced.** GTK learns the refresh
   interval only from its own frame callbacks. After any paint cycle,
   including the empty one a thaw schedules, it holds off the next paint
   until 16.667 ms after the last (`min_next_frame_time`), so a WebKit frame
   that arrived just after the compositor's answer waited out a 60 Hz period.

### What changed

`client/src-tauri/src/linux_frame_clock.rs` (new; installed on the main
window at setup, Wayland only; the client log says
`[window] frame pacing: paced by the compositor's frame callbacks (Wayland)`):

- **The GL path gets the contract GTK's `wl_shm` path has.** When GTK paints
  the toplevel (its `draw`, on the cairo context of a real paint of its own
  `GdkWindow`), the app asks for a `wl_surface.frame` callback, which rides
  on the paint's `eglSwapBuffers` commit. After the paint the window's frame
  clock is frozen (`gdk_window_freeze_toplevel_updates_libgtk_only`, GTK's
  own freeze) until KWin answers. Hiding the window (its surface is
  destroyed) drops the request and thaws. A minimized or covered window gets
  no answer and does not paint, as with GTK's own path; minimize, restore,
  unmaximize to 1600x1000 and maximize again were checked.
- **The answer thaws the clock the moment something is waiting.** The
  toplevel's invalidate handler (`gdk_window_set_invalidate_handler`) sees
  every queued redraw. With one waiting the clock thaws at once; with none it
  stays frozen until one arrives (a WebKit frame usually does within a few
  ms) or one refresh has passed, so layout and resizes never wait longer.
  Thawing an idle clock would run an empty paint cycle and push the next
  real paint past the compositor's next frame.
- **The clock is told the display's refresh.** After each paint the
  monitor's refresh interval is written into the frame's `GdkFrameTimings`
  (getters only in GTK 3; the field is written at its offset in
  `struct _GdkFrameTimings`, laid out by a `repr(C)` mirror, and read back
  through `gdk_frame_timings_get_refresh_interval`; a mismatch restores the
  old value, stops, and logs an error).

`client/src-tauri/src/native_media/native_render/linux.rs`:

- **The webview is opaque, in the ground color, unless a native video
  surface exists** (`sync_webview_background`). It turns transparent when the
  first surface is created, before its GLArea can draw and so before the page
  can open a hole over it, and opaque again when the last one is destroyed.
  WebKit picks an opaque buffer format and GTK draws its frame straight to
  the window. The page is opaque except over open holes (`layout.css`), so
  nothing visible changes; the call view with Vincent's stream and the
  conversation after leaving it were checked by screenshot.

### Results: 5120x1412 maximized, nested KWin at 239.9 Hz, RTX 4080

"Before" is HEAD `651430c1` with only the trace added; "after" is this pass.
Cadence = share of frames at the most common interval; changes = share of
consecutive intervals that differ.

| Motion | Before: fps, cadence, changes, gaps >25 ms | After |
|---|---|---|
| glide | 45, 46% at 4v, 64%, 36 | **193, 93% at 1v, 13%**, 11 |
| switch | 54, 62% at 4v, 56%, 14 | **202, 91% at 1v, 16%**, 5 |
| composer | 52, 65% at 4v, 45%, 16 | **162, 84% at 1v, 25%**, 12 |
| scroll | 48, 53% at 4v, 54%, 21 | 60, 38% at 4v, 70%, 17 |
| call open | 29, 42% at 9v+, 77%, 29 | 66, 60% at 1v, 42%, 69 |
| stage (theater) | 41, 37% at 4v, 71%, 118 | 39 to 47, 2v to 3v, 69 to 82%, ~150 |

| | Before | After |
|---|---|---|
| Commit to screen | 11 to 20 ms | 4 to 6 ms (no video) |
| GTK paint of the window | not traced | 1.8 to 2.0 ms median; 9 to 13 ms with video |
| App CPU, 20 s glide loop | 36% at ~58 fps | 28% at ~200 fps |
| WebKitWebProcess CPU, same | 40% | 41% (3.4x the frames) |
| App CPU watching the stream | 36% | 36% |

How each change contributed (glide, same session):

| Step | fps | Cadence |
|---|---|---|
| Frame-callback pacing alone | 48 | 56% at 4v: no gain, the ~10 ms paint was the limit |
| + opaque webview | 52 | 69% at 4v, commit-to-screen 4 ms |
| + refresh interval in the timings | 107 | 81% at 2v |
| + thaw on invalidation | 226 | 94% at 1v |

On the AMD iGPU (Mesa; nested KWin on renderD129, the app's EGL following
it), glide went from 55 to 139 fps and switch from 57 to 118, with no
protocol errors.

A Web Animation on a fixed box with the page's main thread blocked for
1.5 s kept presenting at 225 fps: the Index motions run on WebKit's
compositor thread and no longer depend on the main thread or on WebKit's
60 Hz display link.

### What is still held near 60, and why

- **Scrolling and anything the page's main thread drives**
  (`requestAnimationFrame`, React commits, the smooth-scroll animation) run
  on WebKit's display link, which on this machine is
  `DisplayVBlankMonitorTimer`: `sleep_for(1000 / 60)` ms per tick, about
  61.5 Hz, unrelated to the display (limit 1 in "Why not 240": the DRM
  monitor needs `drmWaitVBlank`, which nvidia-drm refuses to a non-master
  client, and WebKitGTK has no setting or variable that raises the timer's
  rate). These frames now reach the screen within one refresh of being
  made, but a 61.5 Hz source on a 240 Hz grid still lands 4,4,4,…,3 refreshes
  apart. Scroll stays at about 60 frames a second with uneven intervals.
- **The call view while video shows.** The webview must be transparent
  there, and GTK 3's blend of a transparent GL frame (cairo ground, texture
  upload) costs 9 to 13 ms per paint at 5120x1412, so theater moves present
  at about 40 to 47 fps, as before. A full-window opaque GLArea painting the
  ground was tried and did not help: GTK marks the area under each later
  widget for blending (`gdk_window_mark_paint_from_clip`) and uploads it
  anyway. The real fix is to put the video in Wayland subsurfaces under the
  window's surface, so the compositor blends it and GTK never does; that is
  a rewrite of the underlay.
- **Main-thread stalls at the start of a motion.** A channel click takes 18
  to 37 ms before the next frame and 13 to 50 ms for the one after (React's
  render of the new conversation and the layout it causes). The glide starts
  after that work, smoothly, but late. Not investigated further here.
- **`superseded` frames.** KWin answers every frame callback a surface holds
  when it paints, so a commit that lands while KWin is compositing gets its
  answer early, and the next commit replaces it before it is shown: 5 to 10%
  of frames are rendered and never displayed. It costs GPU time, not
  smoothness (the displayed sequence keeps its one-refresh cadence).

`GDK_RENDERING=recording` (cairo records instead of painting) was also
tried: with a transparent webview GTK then rasterizes the recording for the
upload and the paint got slower (34 ms), so it was dropped.

## Left open

| Severity | Item |
|---|---|
| Fixed | ~~**App CPU at 5120 during motion (about 43%) scales with window area.**~~ It was GTK 3 painting and uploading the toplevel ground under the transparent webview every frame. The webview is now opaque unless a video surface exists (second pass). |
| Medium | **The call view presents at 39 to 48 fps during theater moves**, with video showing. The transparent webview's GTK blend costs 9 to 13 ms per paint at 5120x1412 (second pass). The fix is video in Wayland subsurfaces under the window. |
| Medium | **Scrolling and other main-thread motion stay near 60 with uneven intervals** (WebKit's 61.5 Hz display-link timer; second pass). |
| Low | **18 to 50 ms of main-thread work after a channel or server click** before the motion's first frames (second pass). |
| Fixed | ~~**While a video is shown, the window cannot be made smaller than the stage.**~~ Fixed by `UnderlayFixed` (`docs/design/index-checkpoints/video-min-size.md`). The underlay's `gtk::Fixed` raises the toplevel's minimum size to the GLArea's extent (`xdg_toplevel.set_min_size(3706, 1196)` in the trace). A resize to 1440x900 with the call view open landed at 2807x980, then 2166x900. Present before this change (`native_render/linux.rs`). |
| Low | The X11 verdict comes from nested Xwayland on the RTX 4080; a real X11 session was not tested. |
| Info | Earlier nested-KWin CPU tables (Glass release check, IX-20) were taken with the app on the AMD iGPU, because KWin's virtual backend picks the first DRM device. The owner's desktop runs on NVIDIA. |
| Info | The nested KWin of earlier passes and of this one wrote a `Virtual-0` entry into the real `~/.config/kwinoutputconfig.json`. This pass removed that entry (only `Virtual-0` and its setup; the real outputs are untouched) and runs its nested KWin with its own config directory. A backup of the file before the cleanup is in this pass's scratchpad. |
| Info | Not built here: the release binary. The owner schedules one rebuild with all agents' work. |
