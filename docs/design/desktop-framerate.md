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

## Left open

| Severity | Item |
|---|---|
| Medium | **App CPU at 5120 during motion (about 43%) scales with window area** even on the GPU path; at 1440 it is 12%. Likely GTK 3 uploading the cairo-painted toplevel ground under the transparent webview every frame. Worth trying: keep the webview opaque while no video surface exists and transparent only while the underlay shows something. This needs care, because it changes the underlay contract in `native_render/linux.rs`. |
| Medium | **The call view presents at 39 to 48 fps during opens and theater moves at either size**, with rAF at 60. It is not resolution bound. The stream's own frame commits (about 23 a second through the GLArea) interleave with WebKit's frames on the same GTK frame clock. Not investigated further. |
| Medium | **While a video is shown, the window cannot be made smaller than the stage.** The underlay's `gtk::Fixed` raises the toplevel's minimum size to the GLArea's extent (`xdg_toplevel.set_min_size(3706, 1196)` in the trace). A resize to 1440x900 with the call view open landed at 2807x980, then 2166x900. Present before this change (`native_render/linux.rs`). |
| Low | The X11 verdict comes from nested Xwayland on the RTX 4080; a real X11 session was not tested. |
| Info | Earlier nested-KWin CPU tables (Glass release check, IX-20) were taken with the app on the AMD iGPU, because KWin's virtual backend picks the first DRM device. The owner's desktop runs on NVIDIA. |
| Info | The nested KWin of earlier passes and of this one wrote a `Virtual-0` entry into the real `~/.config/kwinoutputconfig.json`. This pass removed that entry (only `Virtual-0` and its setup; the real outputs are untouched) and runs its nested KWin with its own config directory. A backup of the file before the cleanup is in this pass's scratchpad. |
| Info | Not built here: the release binary. The owner schedules one rebuild with all agents' work. |
