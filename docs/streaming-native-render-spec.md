# Streaming Final-Mile Spec: Native Surface Rendering, Simulcast, Bridge Parity

Status: LAW for the streaming final-mile implementation (2026-07). Route law
revised 2026-10-04 (§2): the desktop app draws every video natively on every
platform; WebCodecs is the browser client's route only. Companion to the
2026-07-06 six-subsystem audit and the `streaming-stack-fix-all` overhaul that landed
reliable keyframes, ingress bandwidth estimation, GPU bitrate retargeting, BT.709
signaling, stereo stream audio, native camera, and lifecycle fixes. This spec covers
everything that remains between the current stack and "nothing left to improve."

## 0. Mission and principles

- **Raw frames never cross IPC.** The remaining raw-I420-over-IPC path (native decode →
  webview WebGL) is deleted by this work, not optimized.
- **Decoded frames never touch the CPU when the GPU decoded them** (tier-1 goal; see
  the explicit tier-2 floor in §3.4).
- **One deterministic route per subscription, chosen once at subscribe time.** No
  runtime route switching, no silent fallbacks. A route that cannot be established is a
  loud error for that subscription.
- **Self-view stays the exact encoded bitstream viewers receive.** This spec changes
  where it is decoded and rendered, never what is decoded.
- The streamer's machine is the optimization target: streaming while gaming must not
  cost meaningful game FPS. Encode already rides the NVENC ASIC; this work removes the
  remaining CPU costs (self-view render path) and the last quality gaps (simulcast,
  browser-viewer keyframes).

## 1. Scope

In scope:
1. **Native surface rendering** for every video track in the desktop app (Linux
   GLArea; macOS AVSampleBufferDisplayLayer; Windows DirectComposition — see §2).
2. **GPU-resident decode outputs** in paracord-codec (CUDA / VAAPI-dmabuf / CVPixelBuffer
   handles; CPU handle as the software floor).
3. **Simulcast on by default** on hardware-encode paths, with relay-side per-viewer
   layer selection.
4. **WebTransport bridge uni-stream forwarding** so browser viewers receive reliable
   keyframes (fixes the known "bridged viewers cannot decode" gap).
5. **NVENC colorspace hardware verification** (closes the one skipped review item) —
   runnable on this dev machine's RTX 4080.
6. **Windows WGC→MFT zero-copy encode input** (D3D11 texture straight to the encoder).

Explicit non-goals (documented decisions, do not implement):
- 4:4:4 / lossless modes (hardware decode ecosystem is absent; violates
  everyone-must-decode negotiation).
- WebKitGTK GStreamer plugin work to make webview AV1 WebCodecs pass (environment-
  fragile; native surface rendering supersedes it).
- BBR congestion control (may be evaluated later behind config; not default).
- ~~A Windows native surface backend~~ — superseded 2026-10-04: Windows has one
  (`native_render/windows.rs`, DirectComposition under the WebView2), because the
  desktop app has one route on every platform (§2).

## 2. Route law (revised 2026-10-04)

One route per platform, fixed at build time. Nothing probes, nothing chooses at
runtime, nothing falls back.

| Client | Route | Frame flow |
|---|---|---|
| Desktop app (Linux, macOS, Windows) | `native-surface`, always | encoded frames → native per-track decode worker → platform surface UNDER the transparent webview. **Nothing crosses IPC but geometry, stills and stats.** |
| Browser client (the web UI a server serves) | WebCodecs | WebTransport → WebCodecs → canvas. No native layer exists in a browser. |

- The WebCodecs passthrough route in the desktop app is **deleted**: the frame
  channel (`media_register_stream_video_subscription`), the functional WebCodecs
  probe and its probe frames (`media_generate_decode_probe`), the stall watchdog
  that re-registered channels, and the webview-side decode-support merge. The
  desktop's advertised `decode` for a codec means "a native decoder exists AND
  this window's native renderer installed" (`capabilities.rs`).
- The self-view takes the same route: the native side decodes the exact
  bitstream viewers receive (from the encoder, never the relay) onto a surface.
- Platform decoders: Linux lavc (NVDEC/VAAPI/software) for H.264/AV1 and libvpx
  or lavc for VP9; macOS VideoToolbox H.264 (GPU-resident `CVPixelBuffer`) and
  libvpx VP9 (CPU I420, wrapped in a `CVPixelBuffer` by the surface); Windows
  Media Foundation H.264/AV1 (CPU I420) and libvpx VP9. A codec with no native
  decoder is not advertised as decodable, so negotiation never picks it.
- A window whose host did not install (no usable GL context, no WebView2
  transparency, …) records the reason (`native_render::renderer_status`); every
  video subscription then fails loudly with it, and `decode` is false for every
  codec. It never draws video in the webview instead.
- Hidden ⇒ decode paused only when the tile is off screen or the window hidden
  (`media_set_stream_visibility`). A tile merely covered (a dialog, a stage
  move) keeps decoding with its surface hidden. A resumed decoder drops deltas
  until the keyframe it asks for.
- Everything in the page that needs a picture of a video (tile posters, clip
  thumbnails) reads stills (room light, the stage's glow and the pill's preview
  are retired, docs/index-spec.md §12):
  `native_render_still { streamId, trackId, maxWidth, maxHeight, afterSeq? }`,
  binary RGBA of the latest presented frame (§3.6).

## 3. Native surface architecture

### 3.1 Module layout

New: `client/src-tauri/src/native_media/native_render/` —
`mod.rs` (trait + registry + geometry command handlers), `linux.rs`, `macos.rs`.

```rust
pub trait VideoSurface: Send {
    /// Attach to the app window; created hidden at zero rect.
    fn new(window: &tauri::Window, surface_id: SurfaceId) -> Result<Self, String> where Self: Sized;
    /// Geometry in physical pixels, plus corner radius (logical px) and visibility.
    fn update_geometry(&mut self, g: SurfaceGeometry) -> Result<(), String>;
    /// Present one decoded frame. Called from the track's decode worker thread;
    /// implementations marshal to their render thread/main loop themselves.
    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String>;
    fn destroy(self);
}
pub struct SurfaceGeometry { pub x: i32, pub y: i32, pub width: u32, pub height: u32,
    pub dpr: f64, pub corner_radius: f32, pub visible: bool }
```

Registry: `SurfaceId (u64)` → boxed surface, owned by a `native_render::SurfaceRegistry`
in Tauri state; per-track association lives in the existing dispatch state
(`track_key → SurfaceId`). All registry mutation from Tauri commands; `present()` is
called by decode workers through an `Arc<Mutex<…>>` held per track (the per-frame lock
is fine — present() only enqueues a handle and wakes the render side).

### 3.2 DecodedFrameHandle (paracord-codec)

```rust
pub enum DecodedFrameHandle {
    /// NVDEC output mapped for GL interop: NV12 CUDA device memory, described by
    /// a retained AVFrame (hw_frames_ctx keeps the pool alive). Linux only.
    CudaNv12(CudaFrame),
    /// VAAPI surface exported as DRM-PRIME: fds + strides/offsets/modifier + fourcc.
    /// Ownership: fds owned by the handle, closed on drop. Linux only.
    DmaBufNv12(DmaBufFrame),
    /// CVPixelBuffer (NV12/BGRA) from VTDecompressionSession. macOS only.
    #[cfg(target_os = "macos")] CvPixelBuffer(CvPixelBufferFrame),
    /// CPU I420 — the software floor (libvpx VP9, or tier-2 readback, §3.4).
    CpuI420 { data: Vec<u8>, width: u32, height: u32, colorspace: ColorSpace },
}
```

Every variant carries `width/height/colorspace` accessors. The lavc decoder gains a
`DecodeOutput::Gpu` mode chosen at construction: when the chosen backend is CUDA, do
NOT `av_hwframe_transfer_data`; instead clone the AVFrame ref into `CudaNv12`. When
VAAPI, `vaExportSurfaceHandle(…DRM_PRIME_2…)` (via `av_hwframe_map` to DRM_PRIME or
direct VA call) into `DmaBufNv12`. The existing CPU path remains for `webcodecs-…`
probe generation and the software floor. libvpx VP9 decode returns `CpuI420` directly.

### 3.3 Linux backend (`linux.rs`) — the full zero-copy target

Widget (UNDERLAY revision, 2026-07-07 — supersedes the original overlay-on-top
design; every platform is an underlay since 2026-10-04): on setup, reparent the webview inside the window's `default_vbox()` into a
`gtk::Overlay` with a `gtk::Fixed` as the MAIN child (the GL host) and the webview as
the overlay child ON TOP, its background cleared via
`webkit_web_view_set_background_color(transparent)`. Each surface = one `gtk::GLArea`
positioned inside the `Fixed` (`fixed.move_()`), rendering BELOW the webview; the DOM
punches a transparent hole at the tile (`<html data-native-underlay>` clears the
ancestor-chain backgrounds — html/body/#root + `data-native-underlay-clear` wrappers —
and the tile clears its own backdrop while the surface reports visible). Consequences:
every piece of DOM chrome (control bars, badges, modals) renders naturally OVER the
video and receives input first — no input-shape tricks needed (an empty input region
is still set on each GLArea as defense in depth). Linux still runs DOM-occlusion in
**underlay mode** (`occlusion: 'underlay'` on the tile; `nativeRenderUnderlay`
advertises the mode): stage chrome is ignored so the stream stays live under the
control bar, but body-portaled dialogs/menus hide the GL surface so translucent
overlays cannot merge into / steal dismiss from the live underlay hole. The original
design — GLArea composited over the webview — both hid and swallowed input from all
in-tile controls (the 2026-07-07 invisible-and-unclickable-controls bug). The GTK
toplevel is painted `#141b17` (default `--bg-primary`) so punched regions with no
GLArea beneath read as app background. macOS (§3.5) remains an overlay backend and
keeps full occlusion sampling.
`gl_area.set_has_alpha(true)`; render with premultiplied alpha so rounded corners
(fragment-shader rounded-rect mask using `corner_radius`) composite cleanly.
All GTK calls on the GTK main thread via `glib::MainContext::default().invoke(...)`;
`present()` sends the handle over a `glib` channel / `Arc<Mutex<Option<Handle>>>` +
`queue_render()`.

Texture import, by decode backend:
- **CUDA (NVDEC)**: shared CUcontext with the GL context thread. Register two GL
  textures (R8 for Y, RG8 for UV) with `cuGraphicsGLRegisterImage`; per frame, map +
  `cuMemcpy2DAsync` device→array from the AVFrame's CUdeviceptr planes; NV12→RGB in the
  shader with the frame's signaled colorspace matrix. Device-to-device copy only — no
  PCIe round trip. CUDA driver API via a thin `libcuda` dlopen shim (no new heavy deps;
  the symbols needed are ~8 functions).
- **VAAPI (DMA-BUF)**: `eglCreateImageKHR(EGL_LINUX_DMA_BUF_EXT)` per plane (or single
  NV12 image with `EGL_IMAGE_PRESERVED`), `glEGLImageTargetTexture2DOES`. Requires the
  GLArea's EGL display — obtain via `gdk_wayland_display_get_egl_display` /
  `eglGetCurrentDisplay` inside the realized GL context.
- **CpuI420**: plain `glTexSubImage2D` upload on the GL thread. Still zero IPC, zero
  WebKit.

### 3.4 Tier-2 floor (allowed, loud, deterministic)

If the CUDA-GL or EGL-dmabuf interop cannot be made sound, the backend may fall to:
GPU decode → `av_hwframe_transfer_data` (CPU) → `CpuI420` → native GL upload. This is
chosen **once at surface/decoder construction**, logged loudly with the reason, and is
still a large win (deletes IPC + WebKit + double PCIe becomes single). It is NOT a
runtime fallback. Do not fake tier-1 — an honest tier-2 beats a broken interop.

### 3.5 macOS backend (`macos.rs`) — compile-unverified on this machine

Sibling `NSView` added BELOW the WKWebView in the window `contentView` (an underlay
since 2026-10-04; the WKWebView's `drawsBackground` is off and the window paints
the ground color), hosting an `AVSampleBufferDisplayLayer`. VideoToolbox decode (new `VtDecoder` for H264 now, AV1 on
M3+ later) outputs `CVPixelBuffer` → wrap in `CMSampleBuffer` → `enqueue(...)`. Geometry
= `view.frame` (flip Y from top-left DOM coords), `layer.cornerRadius` for corners,
`isHidden` for visibility. All AppKit calls on the main thread via
`dispatch::Queue::main().exec_async`. This is the OS's own zero-copy video path.

### 3.5a Windows backend (`windows.rs`) — compile-checked, not run

A DirectComposition target on the top-level window with `topmost = FALSE`, so its
visual tree composes behind the WebView2 child window, whose default background
is transparent. A ground visual painted the ground color, and one visual per
surface with a composition swap chain (premultiplied alpha) drawn by Direct3D 11
from CPU I420 with the same shader math as Linux (matrix, fit, crop anchor,
rounded mask, mirror). All D3D/DXGI/DComp objects live on one render thread.

### 3.6 Geometry & occlusion protocol (TS ↔ native)

New commands (contract S1):
- `native_render_attach { streamId, trackId } -> { surfaceId }` — creates the surface,
  flips the subscription's route bookkeeping; called instead of (not in addition to)
  the frame-channel registration when the route is `native-surface`. The keyframe
  request / visibility / stats plumbing is shared with the existing subscription.
- `native_render_update_geometry { surfaceId, x, y, width, height, dpr, cornerRadius, visible, generation, mirrored }`
  — physical pixels relative to the window's client area. `generation` counts the
  page's reveals: once a backend has drawn a frame at a visible geometry of a new
  generation it emits `native_render_shown { surfaceId, generation }`, and only
  then does the page open the hole (it keeps the tile's poster up until then).
- `native_render_still { streamId, trackId, maxWidth, maxHeight, afterSeq? }` —
  the latest presented frame (a CPU copy kept at most every 200ms while wanted,
  at least every second otherwise) scaled to fit, as binary RGBA; `unchanged`
  when it is `afterSeq`.
- `native_render_detach { surfaceId }`.

TS side: a `NativeVideoTile` mount in the same place `CanvasRenderer` would mount.
Reporting cadence: ResizeObserver + IntersectionObserver + window scroll/resize, all
coalesced through one rAF-throttled reporter (≤1 update per frame, skip no-ops).
**Occlusion rule** (underlay): each reporter tick samples `document.elementFromPoint`
at the tile's center + 4 inset corners; a marked occluder (`data-native-shield`,
`data-native-overlay-occlude`) or a dialog/menu over the tile's CENTER reports
`visible=false`; stage chrome and corner-only menus do not. Hiding closes the hole
first and hides the surface two frames later. While hidden the tile shows its
poster (the latest still, drawn into its own canvas with the surface's fit). A
stage move additionally makes the bottom of the page opaque in the ground color
for its length (`html[data-native-moving]`), so no surface shows through from its
old place on the move's first frames.

### 3.7 Failure law

Surface creation failure, interop init failure past the tier decision, or a present()
error streak (>30 consecutive) ⇒ tear down the subscription with a user-visible error
event (`media_native_render_failed { streamId, trackId, reason }`) — never fall back to
raw IPC (that path no longer exists) and never silently blank.

## 4. Simulcast by default

### 4.1 Encoder policy (contract S4)

- Simulcast is ON by default **iff every layer's encoder is hardware** (lavc on Linux,
  MF on Windows, VT on macOS). The libvpx VP9 floor stays single-layer (CPU triple-
  encode is a regression). `PARACORD_SCREEN_SIMULCAST` becomes an opt-OUT
  (`=off`/`0`/`false` disables; unset = policy above).
- Ladders (each layer's encoder constructed `new_with_input(capture_dims → layer_dims)`
  so scaling/conversion happens on the GPU per layer):
  - Screen: L 640×360@30 / 800 kbps · M 1280×720@min(source,60) / 3500 kbps · H source/preset.
  - Camera: L 480×270@15 / 350 kbps · M 640×360@30 / 900 kbps · H source/preset.
- The packed-BGRA input gate in `screen_encoder_input_format` (currently disabled when
  simulcast is on) is fixed: packed input is allowed whenever **all** layers are lavc
  hardware encoders — SimulcastEncoder must route the packed capture buffer to each
  layer encoder without any CPU conversion or CPU downscale (delete/bypass
  `downscale_i420` on this path). Layer SSRC mapping and per-layer keyframe forcing
  already exist and must keep working.
- Publisher bitrate feedback continues to retarget the TOP layer only.

### 4.2 Relay per-viewer layer selection

- Per-viewer downlink estimation at the relay: the pre-overhaul cwnd/RTT BDP estimator
  is the CORRECT direction for relay→viewer egress — resurrect it for this purpose
  (per-connection, windowed loss from quinn stats deltas over 5s, never lifetime).
- Selection: highest layer whose ladder bitrate ≤ 85% of the viewer's egress estimate,
  additionally capped by the viewer's viewport hint (already carried at subscribe; a
  ≤480-px-tall tile never receives H). Downswitch immediately on loss >2% or estimate
  drop below the current layer; upswitch only after 5s of ≥125% headroom.
- Switching executes at a keyframe boundary: relay requests a keyframe on the TARGET
  layer (existing `RequestKeyframe { layer }` path, throttled), forwards the old layer
  until the target's keyframe arrives, then atomically switches forwarding. Uni-stream
  keyframes and datagram deltas both filter by the viewer's selected layer.
- The subscriber-visible track/SSRC does not change; layer switching is relay-internal
  (receivers already decode whatever arrives on the track keyed by frame_id order).

## 5. WebTransport bridge parity (browser viewers)

- The bridge (`paracord-transport/src/webtransport.rs` + relay forwarding) forwards
  uni-stream frames **byte-for-byte in both directions**: relay→viewer keyframe uni
  streams become WT uni streams to the browser; browser publishers send keyframes on WT
  uni streams that the bridge relays as QUIC uni streams (identical framing, contract
  S5 = the existing QUIC uni framing, no re-encoding).
- `browserMediaEngine.ts`: consume `transport.incomingUnidirectionalStreams`, parse with
  the same frame framing, feed the same frame_id-ordered path as datagrams; publish-side
  `should_send_on_stream` mirror (keyframes + >48-fragment frames via
  `createUnidirectionalStream`).
- Once delivery works, the relay's `keyframe_bridge_skip_warned` diagnostic becomes a
  hard error path for genuinely non-bridgeable cases only (should be unreachable).

## 6. NVENC colorspace verification (hardware-verifiable HERE)

Procedure (agent runs on this machine — RTX 4080, ffmpeg CLI present):
1. Add `crates/paracord-codec/examples/nvenc_colorspace_probe.rs` (or an ignored test
   gated on `PARACORD_HW_TESTS=1`): build the real `LavcEncoder` NVENC pipeline with
   BGRA input; feed full-frame patches of known sRGB colors (735,735 gray, pure R/G/B,
   white, black); encode ~30 frames.
2. Decode the bitstream (ffmpeg CLI to rawvideo yuv420p) and measure patch Y/Cb/Cr
   means. Compare against BT.709-limited AND BT.601-limited expectations (tolerance ±4).
3. If NVENC's internal conversion is BT.601: either force 709 in the CUDA chain if a
   supported filter/option exists, or change the SIGNALED colorspace on the NVENC path
   to BT.601 (honest-match rule from contract C1) — signaled must equal actual. Record
   the measured verdict in a code comment at the signaling site.

## 7. Windows WGC→MFT zero-copy encode input (compile-unverified on Linux)

- scap Windows engine: keep the WGC `ID3D11Texture2D` (+ shared device) instead of CPU
  readback; new frame variant carries it. CPU BGRA path remains for the VP9 floor.
- MF encoder: accept D3D11 textures via `IMFDXGIDeviceManager` +
  `MFCreateDXGISurfaceBuffer`; GPU color convert via the MFT's own D3D11 processing
  (hardware MFTs accept RGB32 input types — probe and prefer, falling back to the
  existing NV12 CPU pass only at construction, loudly).
- All Windows-only; cfg-gated; reviewed line-by-line since it cannot compile here.

## 8. Verification matrix

| Work | Compile-verify here | Test-verify here | Review-only |
|---|---|---|---|
| Linux surface + CUDA/VAAPI interop | ✅ | partial (GL/CUDA need a session; unit-test geometry math, handle lifetimes, fd ownership) | — |
| paracord-codec GPU handles | ✅ | ✅ (CPU paths; hw behind env gate) | — |
| Simulcast encoders + relay selection | ✅ | ✅ (relay selection unit tests) | — |
| WT bridge + browserMediaEngine | ✅ / tsc | ✅ (bridge piping tests) | — |
| NVENC colorspace probe | ✅ | ✅ **runs on the 4080** | — |
| macOS backend + VT decode | ❌ | ❌ | ✅ line-by-line |
| Windows WGC→MFT | ❌ | ❌ | ✅ line-by-line |

Regression checklist (unchanged, mandatory): no vpx-feature removal, no [profile.dev]
removal, pulse-router invariants, no raw self-preview side-channels, permissive
WebCodecs probes, no silent codec substitution, self-view = exact bitstream.
