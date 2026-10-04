//! Native surface rendering (spec §3.1, §3.6, §3.7; Glass spec §2).
//!
//! In the desktop app every remote video, and the self-view, takes this route:
//! the native side decodes the track and draws it on a platform surface UNDER
//! the webview, and the page shows it through a transparent hole. **Nothing
//! crosses the Tauri IPC boundary but geometry, stills and stats.** There is no
//! WebCodecs route in the desktop app and no probe choosing one; the browser
//! client (the web UI a server serves) is the only place WebCodecs draws video.
//!
//! One backend per platform, all underlays to the same contract:
//! - Linux: a `gtk::GLArea` per surface in a `gtk::Fixed` below the reparented
//!   WebKitGTK webview ([`linux`]).
//! - macOS: an `NSView` hosting an `AVSampleBufferDisplayLayer` below the
//!   WKWebView (`macos`, review-only on the Linux toolchain).
//! - Windows: a DirectComposition visual tree composed behind the WebView2
//!   child window (`windows`, compile-checked here, not run).
//!
//! This module owns the platform-agnostic pieces:
//! - the [`VideoSurface`] trait every backend implements,
//! - the [`SurfaceGeometry`] the TS reporter drives (physical px + dpr + corner
//!   radius + visibility + reveal generation),
//! - the [`ShownNotifier`] a backend fires once a revealed surface has drawn a
//!   frame where the page asked for it, so the page opens its hole only over
//!   video that is already there,
//! - the [`SurfaceRegistry`] mapping `SurfaceId → surface`,
//! - whether this process has a working renderer at all ([`renderer_status`]),
//! - the commands (`native_render_attach`, `native_render_attach_sampler`,
//!   `native_render_update_geometry`, `native_render_still`,
//!   `native_render_detach`, `native_render_set_ground_color`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use paracord_codec::video::DecodedFrameHandle;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

pub mod still;

/// Opaque identity for one native surface. Allocated by the [`SurfaceRegistry`],
/// carried to the TS side so its geometry reporter can address the surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SurfaceId(pub u64);

/// Geometry for one surface, in **physical pixels** relative to the window's
/// client area (spec §3.6). `corner_radius` is in logical px; `dpr` is the
/// device pixel ratio the physical coordinates were measured at, so the backend
/// can convert to whatever coordinate space its widget toolkit uses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
    pub corner_radius: f32,
    pub visible: bool,
    /// The page's count of reveals for this surface. Each time the page shows a
    /// hidden surface it raises this; once the backend has drawn a frame at a
    /// visible geometry of a generation it has not yet confirmed, it fires the
    /// surface's [`ShownNotifier`] with it, exactly once per generation. The
    /// page keeps the tile opaque (its poster showing) until then, so the hole
    /// never opens over a surface that is not in place yet.
    pub generation: u64,
    /// Draw the frame flipped left to right (the self-view camera, which the
    /// page mirrors the same way).
    pub mirrored: bool,
}

impl SurfaceGeometry {
    /// Convert the physical-pixel rect to the logical (toolkit) coordinate space
    /// used by GTK's `Fixed`/`set_size_request` (spec §3.3): logical = physical /
    /// dpr. Returns `(x, y, width, height)` with a non-negative origin and a
    /// minimum 1×1 extent so a degenerate report never produces an invalid
    /// allocation. A non-finite or non-positive `dpr` is treated as 1.0.
    pub fn logical_rect(&self) -> (i32, i32, i32, i32) {
        let scale = if self.dpr.is_finite() && self.dpr > 0.0 {
            self.dpr
        } else {
            1.0
        };
        let x = (self.x as f64 / scale).round() as i32;
        let y = (self.y as f64 / scale).round() as i32;
        let w = ((self.width as f64 / scale).round() as i32).max(1);
        let h = ((self.height as f64 / scale).round() as i32).max(1);
        (x.max(0), y.max(0), w, h)
    }

    /// The corner radius in physical pixels (the value the fragment shader's
    /// rounded-rect mask works in), clamped so it never exceeds half the shorter
    /// physical side (a fully-pill mask, never an inverted one).
    pub fn physical_corner_radius(&self) -> f32 {
        let scale = if self.dpr.is_finite() && self.dpr > 0.0 {
            self.dpr as f32
        } else {
            1.0
        };
        let radius = (self.corner_radius.max(0.0)) * scale;
        let half_min = (self.width.min(self.height) as f32) / 2.0;
        radius.min(half_min)
    }
}

/// Where a `cover` crop falls, as CSS `object-position` reads it and as the
/// canvas route's `anchor` option does (glass-polish-2 item 2): 0 keeps the start
/// of the axis (the left, the top) and crops the far edge, 1 the opposite, 0.5
/// crops both evenly. Only the axis the frame overflows is cropped, so `x` is
/// what decides on a frame wider than its tile and `y` on a taller one. A camera
/// tile anchors at `y: 0.35` so people's faces stay in frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceAnchor {
    pub x: f32,
    pub y: f32,
}

impl SurfaceAnchor {
    /// The middle on both axes: what `cover` crops around unless told otherwise.
    pub const CENTER: Self = Self { x: 0.5, y: 0.5 };
}

impl Default for SurfaceAnchor {
    fn default() -> Self {
        Self::CENTER
    }
}

/// The anchor as the webview sends it to `native_render_attach`:
/// `{ x?: number, y?: number }`, an axis it leaves out staying in the middle.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub struct AnchorArg {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

/// How a frame sits in its surface, fixed when the surface is attached (the
/// canvas route's `CanvasRenderer` `fit`, glass-polish-1 item 7).
/// `Contain` shows the whole frame and letterboxes the rest; `Cover` fills the
/// surface and crops the overflow on the long axis, around its anchor (camera
/// tiles). The anchor belongs to `Cover` alone: `Contain` crops nothing.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum SurfaceFit {
    #[default]
    Contain,
    Cover {
        anchor: SurfaceAnchor,
    },
}

/// Where the fragment shader samples the frame for a tile and a frame shape:
/// `sample = (uv - 0.5) * scale + center`, where `uv` spans the tile.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UvWindow {
    /// How much of the frame the tile spans on each axis. Above 1 it reaches
    /// outside the frame (the letterbox bars, painted empty); below 1 it crops.
    pub scale: [f32; 2],
    /// Where in the frame the tile's middle samples: 0.5 unless a `Cover` crop
    /// is anchored away from the middle.
    pub center: [f32; 2],
}

impl UvWindow {
    /// The same window flipped left to right: sampling runs from the frame's
    /// right edge to its left, about the window's center.
    pub fn mirrored(self) -> Self {
        Self {
            scale: [-self.scale[0], self.scale[1]],
            center: self.center,
        }
    }
}

impl SurfaceFit {
    /// Read what the webview asked for: the renderer's `fit` (`contain`, the
    /// default, or `cover`) and, for `cover`, where its crop falls. Anything
    /// else is refused rather than read as the default: an unknown fit, an
    /// anchor outside 0 to 1 (or not a number), and an anchor with a fit that
    /// crops nothing.
    pub fn parse(value: Option<&str>, anchor: Option<AnchorArg>) -> Result<Self, String> {
        match value {
            None | Some("contain") => match anchor {
                None => Ok(Self::Contain),
                Some(_) => Err(
                    "a native surface anchor needs fit \"cover\": contain crops nothing"
                        .to_string(),
                ),
            },
            Some("cover") => {
                let axis = |name: &str, value: Option<f64>| -> Result<f32, String> {
                    match value {
                        None => Ok(0.5),
                        Some(v) if v.is_finite() && (0.0..=1.0).contains(&v) => Ok(v as f32),
                        Some(v) => Err(format!(
                            "native surface anchor {name} must be between 0 and 1, got {v}"
                        )),
                    }
                };
                let anchor = match anchor {
                    None => SurfaceAnchor::CENTER,
                    Some(arg) => SurfaceAnchor {
                        x: axis("x", arg.x)?,
                        y: axis("y", arg.y)?,
                    },
                };
                Ok(Self::Cover { anchor })
            }
            Some(other) => Err(format!("unknown native surface fit: {other}")),
        }
    }

    /// The window the fragment shader samples through (see [`UvWindow`]).
    /// `Contain` never crops and `Cover` never leaves a bar. Degenerate sizes
    /// read as square.
    pub fn uv_window(self, tile_w: f32, tile_h: f32, source_w: f32, source_h: f32) -> UvWindow {
        let aspect = |w: f32, h: f32| {
            if w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite() {
                w / h
            } else {
                1.0
            }
        };
        let tile = aspect(tile_w, tile_h);
        let source = aspect(source_w, source_h);
        let tile_wider = tile > source;
        let scale = match (self, tile_wider) {
            (Self::Contain, true) => [tile / source, 1.0],
            (Self::Contain, false) => [1.0, source / tile],
            (Self::Cover { .. }, true) => [1.0, source / tile],
            (Self::Cover { .. }, false) => [tile / source, 1.0],
        };
        let center = match self {
            Self::Contain => [0.5, 0.5],
            Self::Cover { anchor } => [
                crop_center(scale[0], anchor.x),
                crop_center(scale[1], anchor.y),
            ],
        };
        UvWindow { scale, center }
    }
}

/// Where the middle of a cropped window falls along one axis. The window
/// spans `scale` of the frame (< 1 when that axis is cropped) and the room it
/// has to move in is `1 - scale`: at `anchor` 0 it sits at the start, at 1 at
/// the end, and at 0.5 it is centered (a center of exactly 0.5). An axis that is
/// not cropped (`scale` >= 1) has nowhere to move and stays centered.
fn crop_center(scale: f32, anchor: f32) -> f32 {
    if scale < 1.0 {
        anchor * (1.0 - scale) + scale / 2.0
    } else {
        0.5
    }
}

/// Tells the page that a revealed surface has drawn a frame in place (see
/// [`SurfaceGeometry::generation`]). Emits `native_render_shown`
/// `{ surfaceId, generation }`, scoped to the session owner like every media
/// event. Cheap to clone; callable from any thread.
#[derive(Clone)]
pub struct ShownNotifier {
    sink: Option<super::CallEventSink>,
    surface_id: SurfaceId,
}

impl ShownNotifier {
    pub fn new(sink: super::CallEventSink, surface_id: SurfaceId) -> Self {
        Self {
            sink: Some(sink),
            surface_id,
        }
    }

    /// A notifier that tells nobody (backend unit tests).
    #[allow(dead_code)]
    pub fn silent(surface_id: SurfaceId) -> Self {
        Self {
            sink: None,
            surface_id,
        }
    }

    // Read by the Windows and macOS backends.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub fn surface_id(&self) -> SurfaceId {
        self.surface_id
    }

    pub fn fire(&self, generation: u64) {
        if let Some(sink) = self.sink.as_ref() {
            let _ = sink.emit(
                "native_render_shown",
                serde_json::json!({ "surfaceId": self.surface_id.0, "generation": generation }),
            );
        }
    }
}

/// Whether this process has a native renderer, and if not, why. Set once by the
/// platform's host install in the Tauri `setup` hook. Until then (and on a
/// platform with no backend) it reads as not installed.
static RENDERER_STATUS: OnceLock<Result<&'static str, String>> = OnceLock::new();

/// Record the outcome of the platform's host install (first call wins).
pub fn record_renderer_status(status: Result<&'static str, String>) {
    let _ = RENDERER_STATUS.set(status);
}

/// `Ok(backend name)` when native video can be drawn in this process,
/// otherwise the reason it cannot. Remote video in the desktop app has no
/// other route: when this is an error, every video subscription fails loudly
/// with this reason.
pub fn renderer_status() -> Result<&'static str, String> {
    match RENDERER_STATUS.get() {
        Some(status) => status.clone(),
        None => Err("the native video renderer was not installed in this window".to_string()),
    }
}

/// A platform surface that renders one native-decoded video track (spec §3.1).
///
/// Implementations are `Send` (moved to the render thread as an owned handle);
/// they marshal every toolkit call to their own main loop / render thread.
/// `present()` is called from the track's decode worker and only enqueues a
/// handle + wakes the render side (spec §3.3), so the per-frame lock the
/// dispatch layer holds is cheap.
///
/// # Signature note
/// The spec sketches `new(window: &tauri::Window, …)`. The concrete backends
/// take a [`tauri::AppHandle`] instead — it is what actually provides
/// `run_on_main_thread` (the marshaling primitive) and reaches the reparented
/// webview host; a bare `Window` would only be used to fetch the same handle.
pub trait VideoSurface: Send {
    /// Attach to the app window; created hidden at a zero rect, drawing frames
    /// with `fit`. `shown` is fired as [`SurfaceGeometry::generation`] describes.
    fn new(
        app: &tauri::AppHandle,
        surface_id: SurfaceId,
        fit: SurfaceFit,
        shown: ShownNotifier,
    ) -> Result<Self, String>
    where
        Self: Sized;
    /// Update geometry / corner radius / visibility / reveal generation
    /// (physical px + dpr). A hidden surface is not drawn; the decoder keeps
    /// running unless the page also paused the track (`media_set_stream_visibility`).
    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String>;
    /// Present one decoded frame. Called from the decode worker thread; the
    /// implementation marshals to its render loop itself.
    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String>;
    /// Tear the surface down (spec trait method). For the
    /// `Arc<Mutex<Box<dyn VideoSurface>>>` the registry holds this is not
    /// reachable through the trait object (the `Self: Sized` bound excludes it
    /// from the vtable), so boxed teardown runs through the backend's `Drop`; it
    /// is kept for owned (non-boxed) callers and tests, matching the spec trait.
    #[allow(dead_code)]
    fn destroy(self)
    where
        Self: Sized;
}

/// A surface shared between the registry (keyed by [`SurfaceId`]) and the
/// dispatch layer's per-track binding (keyed by `track_key`). The per-frame
/// `present()` locks this; both holders drop their `Arc` on teardown, and the
/// backend's `Drop` then runs the toolkit teardown.
pub type SharedSurface = Arc<Mutex<Box<dyn VideoSurface>>>;

/// Owns every live native surface by [`SurfaceId`] (spec §3.1).
///
/// The spec places this "in Tauri state". It is a process-global singleton
/// ([`registry`]) so the session-teardown path
/// (`video_pipeline::clear_all_stream_video_state`, which has no Tauri `State`
/// access) can drop every surface; a marker is still `.manage`d in Tauri state
/// so the ownership is discoverable there. All mutation happens from the three
/// commands (or teardown), never from the render/decode threads.
pub struct SurfaceRegistry {
    next_id: AtomicU64,
    surfaces: Mutex<HashMap<SurfaceId, SharedSurface>>,
}

impl SurfaceRegistry {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            surfaces: Mutex::new(HashMap::new()),
        }
    }

    /// Allocate a fresh, never-reused surface id.
    pub fn allocate_id(&self) -> SurfaceId {
        SurfaceId(self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Register a surface under `id`.
    pub fn insert(&self, id: SurfaceId, surface: SharedSurface) {
        self.surfaces
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, surface);
    }

    /// Look up a surface by id (clones the shared handle).
    pub fn get(&self, id: SurfaceId) -> Option<SharedSurface> {
        self.surfaces
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
    }

    /// Remove a surface by id, returning the shared handle if present.
    pub fn remove(&self, id: SurfaceId) -> Option<SharedSurface> {
        self.surfaces
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
    }

    /// Number of live surfaces (diagnostics / tests).
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.surfaces
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// Whether no surfaces are live (diagnostics / tests).
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop every registered surface (session teardown). Each backend's `Drop`
    /// runs once the dispatch layer has also dropped its `Arc`.
    pub fn clear(&self) {
        self.surfaces
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// The process-global surface registry (see [`SurfaceRegistry`]).
pub fn registry() -> &'static SurfaceRegistry {
    static REGISTRY: OnceLock<SurfaceRegistry> = OnceLock::new();
    REGISTRY.get_or_init(SurfaceRegistry::new)
}

/// Marker `.manage`d in Tauri state so the registry ownership is discoverable
/// there per the spec, while the singleton stays reachable from the teardown
/// path that has no `State` handle.
#[derive(Default)]
pub struct NativeRenderState;

/// Install this platform's video host under the main window's webview: make
/// the webview transparent and put the layer surfaces are drawn on below it.
/// Called once from the Tauri `setup` hook; its outcome goes to
/// [`record_renderer_status`].
pub fn install_platform_host(app: &tauri::AppHandle) -> Result<&'static str, String> {
    #[cfg(target_os = "linux")]
    {
        linux::install_render_host(app)?;
        Ok("GTK GLArea underlay, CPU I420 upload")
    }
    #[cfg(target_os = "macos")]
    {
        macos::install_render_host(app)?;
        Ok("AVSampleBufferDisplayLayer underlay")
    }
    #[cfg(target_os = "windows")]
    {
        windows::install_render_host(app)?;
        Ok("DirectComposition underlay, Direct3D 11")
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err("no native video backend on this platform".to_string())
    }
}

/// Construct the platform surface for this build: Linux → GTK GLArea; macOS →
/// `AVSampleBufferDisplayLayer`; Windows → DirectComposition. A process whose
/// host did not install refuses with the reason it did not (no other route).
fn create_surface(
    app: &tauri::AppHandle,
    id: SurfaceId,
    fit: SurfaceFit,
    shown: ShownNotifier,
) -> Result<Box<dyn VideoSurface>, String> {
    renderer_status()?;
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(linux::LinuxVideoSurface::new(
            app, id, fit, shown,
        )?))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(macos::MacosVideoSurface::new(
            app, id, fit, shown,
        )?))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(windows::WindowsVideoSurface::new(
            app, id, fit, shown,
        )?))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, id, fit, shown);
        Err("no native video backend on this platform".to_string())
    }
}

/// Response for [`native_render_attach`].
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResponse {
    pub surface_id: u64,
}

/// Create a native surface for `stream_id:track_id` and bind the track's
/// decoded frames to it (spec §3.6 contract S1). The relay subscription, the
/// keyframe requests and the visibility plumbing are the track's own. `fit` is
/// `contain` (the default) or `cover`, and `anchor` (`cover` only) says where
/// its crop falls.
#[tauri::command]
pub async fn native_render_attach(
    stream_id: String,
    track_id: String,
    fit: Option<String>,
    anchor: Option<AnchorArg>,
    app: tauri::AppHandle,
    owner_id: String,
    state: tauri::State<'_, super::MediaState>,
) -> Result<AttachResponse, String> {
    // A watched stream in the view slot renders on a surface like a call's.
    let slot = state.slot_for(&owner_id)?;
    let _transition = slot.owners.transition.lock().await;
    slot.owners.check(&owner_id)?;
    let fit = SurfaceFit::parse(fit.as_deref(), anchor)?;
    let app = super::CallEventSink::new(app, owner_id.clone());
    let id = registry().allocate_id();
    let shown = ShownNotifier::new(app.clone(), id);

    // Surface creation marshals to the toolkit's main (or render) thread and
    // blocks for the result; keep it off the async worker.
    let create_app = app.clone();
    let surface = tokio::task::spawn_blocking(move || create_surface(&create_app, id, fit, shown))
        .await
        .map_err(|err| format!("native surface create task failed: {err}"))?;

    let surface = match surface {
        Ok(surface) => surface,
        Err(reason) => {
            // Surface creation failure is loud (spec §3.7): no fallback to raw
            // IPC, and the subscription is not left half-attached.
            super::events::emit_media_native_render_failed(&app, &stream_id, &track_id, &reason);
            return Err(reason);
        }
    };

    slot.owners.check(&owner_id)?;
    // Every surface keeps stills of what it presents (see `still`).
    let surface: Box<dyn VideoSurface> = Box::new(still::StillSurface::wrap(
        Some(surface),
        &stream_id,
        &track_id,
        id,
    ));
    let shared: SharedSurface = Arc::new(Mutex::new(surface));
    registry().insert(id, shared.clone());
    super::video_pipeline::attach_native_surface(
        &stream_id,
        &track_id,
        id,
        shared,
        app.clone(),
        true,
    );
    super::video_pipeline::native_diag(
        Some(&app),
        &format!(
            "native_render_attach: track={stream_id}:{track_id} surface_id={}",
            id.0
        ),
    );
    Ok(AttachResponse { surface_id: id.0 })
}

/// Attach a sampler to `stream_id:track_id`: a native-surface binding with
/// nothing on screen, so the native side decodes the track and keeps only its
/// stills (Glass spec §4). For a stream the page samples but does not show (the
/// room's ambient view, the pill's preview of it). Detach it with
/// [`native_render_detach`] like any surface. A surface attached later for the
/// same track takes the binding over (one per track).
#[tauri::command]
pub async fn native_render_attach_sampler(
    stream_id: String,
    track_id: String,
    app: tauri::AppHandle,
    owner_id: String,
    state: tauri::State<'_, super::MediaState>,
) -> Result<AttachResponse, String> {
    let slot = state.slot_for(&owner_id)?;
    let _transition = slot.owners.transition.lock().await;
    slot.owners.check(&owner_id)?;
    let app = super::CallEventSink::new(app, owner_id.clone());
    let id = registry().allocate_id();
    let surface: Box<dyn VideoSurface> =
        Box::new(still::StillSurface::wrap(None, &stream_id, &track_id, id));
    let shared: SharedSurface = Arc::new(Mutex::new(surface));
    registry().insert(id, shared.clone());
    super::video_pipeline::attach_native_surface(
        &stream_id,
        &track_id,
        id,
        shared,
        app.clone(),
        false,
    );
    super::video_pipeline::native_diag(
        Some(&app),
        &format!(
            "native_render_attach_sampler: track={stream_id}:{track_id} surface_id={}",
            id.0
        ),
    );
    Ok(AttachResponse { surface_id: id.0 })
}

/// A still of what a track's surface presented (see `still`): the latest copy
/// scaled to fit `max_width`x`max_height` as binary RGBA (layout in
/// [`still::STILL_HEADER`]), `unchanged` when that copy is `after_seq`,
/// `waiting` until a frame was presented, or `no surface` when nothing on this
/// device decodes the track. Asking keeps the
/// track's copies fresh for a few seconds. A frame that cannot be read back is
/// an error, never a quiet `waiting`.
#[tauri::command]
pub async fn native_render_still(
    stream_id: String,
    track_id: String,
    max_width: u32,
    max_height: u32,
    after_seq: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let source = still::board().latest(&still::track_key(&stream_id, &track_id))?;
    // The scale runs on the blocking pool: a 960-wide still is a few ms of work.
    let bytes = tokio::task::spawn_blocking(move || {
        still::encode_still(&source, max_width, max_height, after_seq)
    })
    .await
    .map_err(|err| format!("still task failed: {err}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Update a surface's geometry / corner radius / visibility / reveal generation
/// (spec §3.6). Physical pixels relative to the window's client area, coalesced
/// TS-side through one rAF-throttled reporter.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_render_update_geometry(
    surface_id: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    dpr: f64,
    corner_radius: f32,
    visible: bool,
    generation: u64,
    mirrored: bool,
) -> Result<(), String> {
    let id = SurfaceId(surface_id);
    let Some(surface) = registry().get(id) else {
        // A geometry report for a surface that was already detached is a no-op,
        // not an error (detach + a trailing reporter tick race).
        return Ok(());
    };
    let geometry = SurfaceGeometry {
        x,
        y,
        width,
        height,
        dpr,
        corner_radius,
        visible,
        generation,
        mirrored,
    };
    let mut guard = surface.lock().unwrap_or_else(|e| e.into_inner());
    guard.update_geometry(geometry)
}

/// Tell the shell what the app's ground color is — `--bg-base`, as the
/// renderer resolved it, `#rrggbb`.
///
/// Every backend is an underlay: the webview's own background is cleared so
/// video can show through, and whatever the DOM leaves transparent falls
/// through to what the shell paints below it (the GTK toplevel, the NSWindow,
/// the DirectComposition ground visual). The base is user-chosen (`oklch`, with
/// the hue and the tint on `<html>`), so the shell cannot hold a literal — it
/// repeats what the renderer says, on mount and on every change.
#[tauri::command]
pub async fn native_render_set_ground_color(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] color: String,
) -> Result<(), String> {
    let color = validated_ground_color(&color)?;
    #[cfg(target_os = "linux")]
    {
        linux::set_ground_color(&app, &color)
    }
    #[cfg(target_os = "macos")]
    {
        macos::set_ground_color(&app, &color)
    }
    #[cfg(target_os = "windows")]
    {
        windows::set_ground_color(&app, &color)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = color;
        Ok(())
    }
}

/// `#rrggbb`, normalized to lower case, and nothing else.
///
/// The string crosses the IPC boundary and is handed to a toolkit (pasted into
/// a GTK stylesheet on Linux), so it is validated as a color and not merely
/// trusted to be one; anything else is a loud error (spec §3.7), never a
/// quietly ignored one.
pub fn validated_ground_color(color: &str) -> Result<String, String> {
    let trimmed = color.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or("");
    if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(format!("#{}", hex.to_ascii_lowercase()));
    }
    Err(format!(
        "ground color {trimmed:?} is not #rrggbb; the shell will not paint a color it cannot read"
    ))
}

/// The RGB bytes of a color [`validated_ground_color`] accepted (the Windows
/// and macOS backends paint with numbers, not a stylesheet).
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn ground_rgb(color: &str) -> [u8; 3] {
    let hex = color.trim_start_matches('#');
    let byte = |at: usize| u8::from_str_radix(hex.get(at..at + 2).unwrap_or("00"), 16).unwrap_or(0);
    [byte(0), byte(2), byte(4)]
}

/// Destroy a native surface (spec §3.6): removes it from the registry and the
/// dispatch layer's per-track binding; the backend `Drop` tears down the toolkit
/// widgets once both `Arc`s are gone.
#[tauri::command]
pub async fn native_render_detach(surface_id: u64) -> Result<(), String> {
    let id = SurfaceId(surface_id);
    super::video_pipeline::detach_native_surface_by_id(id);
    registry().remove(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(x: i32, y: i32, w: u32, h: u32, dpr: f64, radius: f32) -> SurfaceGeometry {
        SurfaceGeometry {
            x,
            y,
            width: w,
            height: h,
            dpr,
            corner_radius: radius,
            visible: true,
            generation: 0,
            mirrored: false,
        }
    }

    #[test]
    fn logical_rect_divides_physical_by_dpr() {
        // 200 physical px at dpr 2.0 → 100 logical px.
        let (x, y, w, h) = geo(400, 200, 800, 600, 2.0, 12.0).logical_rect();
        assert_eq!((x, y, w, h), (200, 100, 400, 300));
    }

    #[test]
    fn logical_rect_is_identity_at_dpr_one() {
        let (x, y, w, h) = geo(10, 20, 320, 180, 1.0, 0.0).logical_rect();
        assert_eq!((x, y, w, h), (10, 20, 320, 180));
    }

    #[test]
    fn logical_rect_guards_bad_dpr_and_degenerate_extent() {
        // Non-finite / non-positive dpr is treated as 1.0.
        assert_eq!(geo(5, 6, 7, 8, 0.0, 1.0).logical_rect(), (5, 6, 7, 8));
        assert_eq!(geo(5, 6, 7, 8, f64::NAN, 1.0).logical_rect(), (5, 6, 7, 8));
        // A negative origin is clamped to zero; a zero extent floors to 1×1.
        let (x, y, w, h) = geo(-4, -9, 0, 0, 1.0, 0.0).logical_rect();
        assert_eq!((x, y, w, h), (0, 0, 1, 1));
    }

    #[test]
    fn physical_corner_radius_scales_and_clamps() {
        // 8 logical px radius at dpr 2 → 16 physical px, well under half the side.
        assert_eq!(geo(0, 0, 400, 300, 2.0, 8.0).physical_corner_radius(), 16.0);
        // A huge radius clamps to half the shorter physical side.
        assert_eq!(
            geo(0, 0, 400, 300, 1.0, 9999.0).physical_corner_radius(),
            150.0
        );
        // Negative radius floors to zero.
        assert_eq!(geo(0, 0, 400, 300, 1.0, -5.0).physical_corner_radius(), 0.0);
    }

    /// Where the shader samples the tile's edge and center under a window.
    fn sample_at(window: UvWindow, uv: [f32; 2]) -> [f32; 2] {
        [
            (uv[0] - 0.5) * window.scale[0] + window.center[0],
            (uv[1] - 0.5) * window.scale[1] + window.center[1],
        ]
    }

    fn close(a: [f32; 2], b: [f32; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-5 && (a[1] - b[1]).abs() < 1e-5
    }

    const COVER: SurfaceFit = SurfaceFit::Cover {
        anchor: SurfaceAnchor::CENTER,
    };

    fn cover_at(x: f32, y: f32) -> SurfaceFit {
        SurfaceFit::Cover {
            anchor: SurfaceAnchor { x, y },
        }
    }

    #[test]
    fn the_fit_is_read_strictly() {
        assert_eq!(SurfaceFit::parse(None, None).unwrap(), SurfaceFit::Contain);
        assert_eq!(
            SurfaceFit::parse(Some("contain"), None).unwrap(),
            SurfaceFit::Contain
        );
        assert_eq!(SurfaceFit::parse(Some("cover"), None).unwrap(), COVER);
        assert!(SurfaceFit::parse(Some("fill"), None).is_err());
        assert!(SurfaceFit::parse(Some(""), None).is_err());
    }

    #[test]
    fn the_anchor_is_read_strictly() {
        let anchor = |x: Option<f64>, y: Option<f64>| Some(AnchorArg { x, y });
        // An axis it leaves out stays in the middle.
        assert_eq!(
            SurfaceFit::parse(Some("cover"), anchor(None, Some(0.35))).unwrap(),
            cover_at(0.5, 0.35)
        );
        assert_eq!(
            SurfaceFit::parse(Some("cover"), anchor(Some(0.0), Some(1.0))).unwrap(),
            cover_at(0.0, 1.0)
        );
        assert_eq!(
            SurfaceFit::parse(Some("cover"), anchor(None, None)).unwrap(),
            COVER
        );
        // Outside 0 to 1, or not a number: refused, never clamped into a crop nobody asked for.
        for bad in [-0.01, 1.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                SurfaceFit::parse(Some("cover"), anchor(None, Some(bad))).is_err(),
                "y {bad}"
            );
            assert!(
                SurfaceFit::parse(Some("cover"), anchor(Some(bad), None)).is_err(),
                "x {bad}"
            );
        }
        // Contain crops nothing, so an anchor with it is a mistake.
        assert!(SurfaceFit::parse(Some("contain"), anchor(None, Some(0.35))).is_err());
        assert!(SurfaceFit::parse(None, anchor(None, Some(0.35))).is_err());
    }

    #[test]
    fn the_anchor_arrives_as_the_webview_sends_it() {
        let arg: AnchorArg = serde_json::from_str(r#"{ "x": 0.5, "y": 0.35 }"#).unwrap();
        assert_eq!(
            SurfaceFit::parse(Some("cover"), Some(arg)).unwrap(),
            cover_at(0.5, 0.35)
        );
        let half: AnchorArg = serde_json::from_str(r#"{ "y": 0.2 }"#).unwrap();
        assert_eq!(half.x, None);
        assert_eq!(half.y, Some(0.2));
    }

    #[test]
    fn a_mirrored_window_samples_the_frame_right_to_left() {
        let window = SurfaceFit::Contain.uv_window(320.0, 180.0, 1280.0, 720.0);
        let flipped = window.mirrored();
        assert!(close(
            sample_at(flipped, [0.0, 0.5]),
            sample_at(window, [1.0, 0.5])
        ));
        assert!(close(
            sample_at(flipped, [1.0, 0.25]),
            sample_at(window, [0.0, 0.25])
        ));
        // An anchored cover crop keeps its window, read the other way.
        let faces = cover_at(0.2, 0.35).uv_window(400.0, 400.0, 1280.0, 720.0);
        assert!(close(
            sample_at(faces.mirrored(), [0.0, 0.0]),
            sample_at(faces, [1.0, 0.0])
        ));
    }

    #[test]
    fn contain_letterboxes_and_matches_the_old_shader() {
        // 16:9 in a square: bars above and below, the full width shown.
        let window = SurfaceFit::Contain.uv_window(400.0, 400.0, 1280.0, 720.0);
        assert!(close(window.scale, [1.0, 16.0 / 9.0]));
        assert_eq!(window.center, [0.5, 0.5]);
        // The old shader: contentHeight = tile/source, y0 = (1 - h) / 2, and
        // sampleUv.y = (uv.y - y0) / h. The same sample at every row.
        let content_height = 1.0 / (16.0 / 9.0);
        let y0 = (1.0 - content_height) / 2.0;
        for uv_y in [0.0f32, 0.1, 0.25, 0.5, 0.9, 1.0] {
            let old = (uv_y - y0) / content_height;
            assert!((sample_at(window, [0.5, uv_y])[1] - old).abs() < 1e-5);
        }
        // A 4:3 frame in a 2:1 tile: pillarboxed, the full height shown.
        let wide = SurfaceFit::Contain.uv_window(200.0, 100.0, 640.0, 480.0);
        assert!(close(wide.scale, [2.0 / (4.0 / 3.0), 1.0]));
    }

    #[test]
    fn cover_fills_and_crops_evenly() {
        // 16:9 in a square: the full height, the sides cropped evenly.
        let window = COVER.uv_window(400.0, 400.0, 1280.0, 720.0);
        assert!(close(window.scale, [9.0 / 16.0, 1.0]));
        assert_eq!(window.center, [0.5, 0.5]);
        let left = sample_at(window, [0.0, 0.0]);
        let right = sample_at(window, [1.0, 1.0]);
        assert!((left[0] - (1.0 - 9.0 / 16.0) / 2.0).abs() < 1e-5);
        assert!((left[0] + right[0] - 1.0).abs() < 1e-5, "cropped evenly");
        // A 4:3 frame in a 2:1 tile: the full width, top and bottom cropped.
        let wide = COVER.uv_window(200.0, 100.0, 640.0, 480.0);
        assert!(close(wide.scale, [1.0, (4.0 / 3.0) / 2.0]));
    }

    #[test]
    fn an_anchored_cover_keeps_the_top_of_a_tall_frame() {
        // A 3:4 portrait camera in a 2:1 tile: the full width, a 37.5% band of the height.
        let band = 0.75 / 2.0;
        let centered = COVER.uv_window(400.0, 200.0, 600.0, 800.0);
        assert!(close(centered.scale, [1.0, band]));
        assert!(close(centered.center, [0.5, 0.5]));
        // The camera's anchor: 35% of the room above the band, 65% below.
        let faces = cover_at(0.5, 0.35).uv_window(400.0, 200.0, 600.0, 800.0);
        assert_eq!(
            faces.scale, centered.scale,
            "the same picture, a different window"
        );
        let top = sample_at(faces, [0.5, 0.0])[1];
        let bottom = sample_at(faces, [0.5, 1.0])[1];
        assert!(
            (top - 0.35 * (1.0 - band)).abs() < 1e-5,
            "35% of the crop is off the top"
        );
        assert!(
            (1.0 - bottom - 0.65 * (1.0 - band)).abs() < 1e-5,
            "65% is off the bottom"
        );
        assert!(
            (bottom - top - band).abs() < 1e-5,
            "the band is still the band"
        );
        // Higher than the centered crop, so more of the top shows.
        assert!(top < sample_at(centered, [0.5, 0.0])[1]);
        // The ends: the very top, the very bottom.
        let top_end = cover_at(0.5, 0.0).uv_window(400.0, 200.0, 600.0, 800.0);
        assert!(sample_at(top_end, [0.5, 0.0])[1].abs() < 1e-6);
        let bottom_end = cover_at(0.5, 1.0).uv_window(400.0, 200.0, 600.0, 800.0);
        assert!((sample_at(bottom_end, [0.5, 1.0])[1] - 1.0).abs() < 1e-6);
        // The axis that is not cropped does not move, whatever its anchor says.
        let sideways = cover_at(0.1, 0.35).uv_window(400.0, 200.0, 600.0, 800.0);
        assert_eq!(sideways.center[0], 0.5);
    }

    #[test]
    fn an_anchored_cover_along_the_width_moves_the_sides() {
        // 16:9 in a square: the full height, a 9/16 band of the width.
        let band = 9.0 / 16.0;
        let window = cover_at(0.0, 0.35).uv_window(400.0, 400.0, 1280.0, 720.0);
        assert!(close(window.scale, [band, 1.0]));
        assert!(
            sample_at(window, [0.0, 0.5])[0].abs() < 1e-6,
            "left-anchored shows the left edge"
        );
        assert_eq!(
            window.center[1], 0.5,
            "a vertical anchor does nothing to a frame that overflows sideways"
        );
        let right = cover_at(1.0, 0.35).uv_window(400.0, 400.0, 1280.0, 720.0);
        assert!((sample_at(right, [1.0, 0.5])[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn an_anchor_never_leaves_a_bar() {
        let sizes = [
            (320.0, 180.0),
            (180.0, 320.0),
            (400.0, 400.0),
            (1920.0, 1080.0),
            (640.0, 480.0),
            (1.0, 1.0),
        ];
        let anchors = [0.0f32, 0.2, 0.35, 0.5, 0.8, 1.0];
        for (tile_w, tile_h) in sizes {
            for (source_w, source_h) in sizes {
                for anchor in anchors {
                    let fit = cover_at(anchor, anchor);
                    let window = fit.uv_window(tile_w, tile_h, source_w, source_h);
                    // Both edges of the tile sample inside the frame, on both axes.
                    for uv in [[0.0f32, 0.0], [1.0, 1.0], [0.0, 1.0], [1.0, 0.0]] {
                        let at = sample_at(window, uv);
                        assert!(
                            at[0] >= -1e-5 && at[0] <= 1.0 + 1e-5 && at[1] >= -1e-5 && at[1] <= 1.0 + 1e-5,
                            "{tile_w}x{tile_h} tile, {source_w}x{source_h} frame, anchor {anchor}: {at:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn no_fit_leaves_a_bar_under_cover_or_crops_under_contain() {
        let sizes = [
            (320.0, 180.0),
            (180.0, 320.0),
            (400.0, 400.0),
            (1920.0, 1080.0),
            (640.0, 480.0),
            (1.0, 1.0),
        ];
        for (tile_w, tile_h) in sizes {
            for (source_w, source_h) in sizes {
                let cover = COVER.uv_window(tile_w, tile_h, source_w, source_h).scale;
                let contain = SurfaceFit::Contain
                    .uv_window(tile_w, tile_h, source_w, source_h)
                    .scale;
                // Cover samples inside the frame everywhere (no bar); contain
                // reaches every edge of it (nothing cropped).
                assert!(cover[0] <= 1.0 + 1e-6 && cover[1] <= 1.0 + 1e-6);
                assert!(contain[0] >= 1.0 - 1e-6 && contain[1] >= 1.0 - 1e-6);
                // One axis is exact under both: the one that sets the scale.
                assert!((cover[0] - 1.0).abs() < 1e-6 || (cover[1] - 1.0).abs() < 1e-6);
                assert!((contain[0] - 1.0).abs() < 1e-6 || (contain[1] - 1.0).abs() < 1e-6);
            }
        }
        // A frame of no size yet reads as square rather than dividing by zero.
        assert_eq!(COVER.uv_window(0.0, 0.0, 0.0, 0.0).scale, [1.0, 1.0]);
    }

    #[test]
    fn the_ground_color_is_read_as_a_color_not_trusted_as_one() {
        // The renderer's answer is pasted into a toolkit stylesheet, so it is
        // read before it is repeated, and normalized so a re-report of the same
        // color in different case is the same color.
        assert_eq!(validated_ground_color("#0A0C10").unwrap(), "#0a0c10");
        assert_eq!(validated_ground_color("  #100f0c  ").unwrap(), "#100f0c");
        assert_eq!(ground_rgb("#0a0c10"), [0x0a, 0x0c, 0x10]);
        for refused in [
            "",
            "#0a0c1",
            "#0a0c100",
            "0a0c10",
            "red",
            "oklch(16.5% 0.007 65)",
            "#0a0c10; } * { background-image: url(http://x/) ",
        ] {
            assert!(
                validated_ground_color(refused).is_err(),
                "{refused:?} is not #rrggbb and must be refused, not painted"
            );
        }
    }

    #[test]
    fn registry_allocates_unique_ids_and_tracks_lifetime() {
        let reg = SurfaceRegistry::new();
        let a = reg.allocate_id();
        let b = reg.allocate_id();
        assert_ne!(a, b, "ids are never reused");
        assert!(reg.is_empty());
    }
}
