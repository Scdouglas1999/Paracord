//! Native surface rendering (spec §3.1, §3.6, §3.7).
//!
//! A native video surface renders a native-decoded track's frames directly on
//! the GPU, composited over the WebKit webview, so **nothing crosses the Tauri
//! IPC boundary but geometry and stats** (spec §0/§2). The raw-I420-over-IPC
//! path is deleted; a subscription whose functional WebCodecs probe failed takes
//! the `native-surface` route instead, calling [`native_render_attach`] in place
//! of the frame-channel registration.
//!
//! This module owns the platform-agnostic pieces:
//! - the [`VideoSurface`] trait every backend implements,
//! - the [`SurfaceGeometry`] the TS reporter drives (physical px + dpr + corner
//!   radius + visibility),
//! - the [`SurfaceRegistry`] mapping `SurfaceId → surface`,
//! - the three geometry/occlusion commands (`native_render_attach`,
//!   `native_render_update_geometry`, `native_render_detach`).
//!
//! The Linux zero-copy backend lives in [`linux`]; the macOS backend (review
//! only on this toolchain) in `macos`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use paracord_codec::video::DecodedFrameHandle;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

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
    /// Attach to the app window; created hidden at a zero rect.
    fn new(app: &tauri::AppHandle, surface_id: SurfaceId) -> Result<Self, String>
    where
        Self: Sized;
    /// Update geometry / corner radius / visibility (physical px + dpr).
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

/// Construct the platform surface for this build (spec route matrix §2): Linux →
/// GTK GLArea zero-copy backend; macOS → `AVSampleBufferDisplayLayer`; every
/// other target has no native-surface backend and returns a loud error (Windows
/// is passthrough-only, so `native_render_attach` must never be reached there).
fn create_surface(app: &tauri::AppHandle, id: SurfaceId) -> Result<Box<dyn VideoSurface>, String> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(linux::LinuxVideoSurface::new(app, id)?))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(macos::MacosVideoSurface::new(app, id)?))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, id);
        Err(
            "no native-surface backend on this platform (passthrough is the only \
             route here)"
                .to_string(),
        )
    }
}

/// Response for [`native_render_attach`].
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResponse {
    pub surface_id: u64,
}

/// Create a native surface for `stream_id:track_id` and flip the subscription
/// onto the `native-surface` route (spec §3.6 contract S1). Called **instead of**
/// the frame-channel registration when the route is native-surface. The keyframe
/// request / visibility / stats plumbing is shared with the existing
/// subscription bookkeeping.
#[tauri::command]
pub async fn native_render_attach(
    stream_id: String,
    track_id: String,
    app: tauri::AppHandle,
) -> Result<AttachResponse, String> {
    let id = registry().allocate_id();

    // Surface creation marshals to the GTK/AppKit main thread and blocks for the
    // result; keep it off the async worker.
    let create_app = app.clone();
    let surface = tokio::task::spawn_blocking(move || create_surface(&create_app, id))
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

    let shared: SharedSurface = Arc::new(Mutex::new(surface));
    registry().insert(id, shared.clone());
    super::video_pipeline::attach_native_surface(&stream_id, &track_id, id, shared, app.clone());
    super::video_pipeline::native_diag(
        Some(&app),
        &format!(
            "native_render_attach: track={stream_id}:{track_id} surface_id={}",
            id.0
        ),
    );
    Ok(AttachResponse { surface_id: id.0 })
}

/// Update a surface's geometry / corner radius / visibility (spec §3.6). Physical
/// pixels relative to the window's client area, coalesced TS-side through one
/// rAF-throttled reporter.
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
    };
    let mut guard = surface.lock().unwrap_or_else(|e| e.into_inner());
    guard.update_geometry(geometry)
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

    #[test]
    fn registry_allocates_unique_ids_and_tracks_lifetime() {
        let reg = SurfaceRegistry::new();
        let a = reg.allocate_id();
        let b = reg.allocate_id();
        assert_ne!(a, b, "ids are never reused");
        assert!(reg.is_empty());
    }
}
