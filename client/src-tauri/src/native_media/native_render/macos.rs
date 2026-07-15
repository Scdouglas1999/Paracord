//! macOS native-surface backend (spec §3.5): a sibling `NSView` added above the
//! WKWebView in the window `contentView`, backed by an
//! `AVSampleBufferDisplayLayer`. VideoToolbox decodes each track to a
//! `CVPixelBuffer` ([`DecodedFrameHandle::CvPixelBuffer`]); `present()` wraps it
//! in a `CMSampleBuffer` and `enqueue`s it on the layer — the OS's own zero-copy
//! video path. **Nothing crosses IPC but geometry/stats** (spec §0/§2).
//!
//! # Compile-unverified
//! This entire file is `#[cfg(target_os = "macos")]` and links the AppKit /
//! AVFoundation / CoreMedia / CoreVideo / QuartzCore / Foundation frameworks and
//! the Objective-C runtime. It **cannot compile on the Linux toolchain** used
//! for CI (spec §8: macOS backend is review-only, line-by-line). The FFI follows
//! the VideoToolbox encoder's idiom in `paracord-codec` — raw
//! `#[link(kind = "framework")]` externs plus `objc_msgSend`, no external crate.
//!
//! # Shape (mirrors [`linux`](super::linux) exactly)
//! The `Send` [`MacosVideoSurface`] handle holds no AppKit object — only an
//! [`AppHandle`](tauri::AppHandle) (for `run_on_main_thread`, Tauri's marshaling
//! primitive), a keep-latest frame slot, and a wake flag. The real `NSView` +
//! `AVSampleBufferDisplayLayer` live in a main-thread `thread_local` keyed by
//! [`SurfaceId`]; every AppKit call runs on the main thread (spec §3.5). Registry
//! insert/lookup/remove and the failure law are identical to the Linux backend.
//!
//! # Input pass-through
//! The overlay `NSView` is an instance of a runtime-registered `NSView` subclass
//! whose `hitTest:` returns `nil`, so mouse events fall through to the webview
//! below — the AppKit equivalent of the Linux overlay's
//! `set_overlay_pass_through(true)` (spec §3.3/§3.6).

#![allow(non_upper_case_globals, non_snake_case)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::os::raw::{c_char, c_void};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use paracord_codec::video::DecodedFrameHandle;
use tauri::Manager;

use super::{SurfaceGeometry, SurfaceId, VideoSurface};

// ── Objective-C runtime + CoreGraphics scalar types ──────────────────────────

/// An Objective-C object pointer (`id`) or class pointer (`Class`).
type Id = *mut c_void;
/// A selector (`SEL`).
type Sel = *const c_void;
/// A method implementation function pointer (`IMP`).
type Imp = unsafe extern "C" fn();
/// Objective-C `BOOL` (signed char on every Apple ABI this ships on).
type Bool = i8;
const YES: Bool = 1;
const NO: Bool = 0;
/// `NSInteger`.
type NSInteger = isize;
/// `NSWindowAbove` (`NSWindowOrderingMode`) — order the subview above its
/// siblings (the WKWebView) when inserting it (spec §3.5).
const NS_WINDOW_ABOVE: NSInteger = 1;

/// `CGFloat` is `double` on 64-bit Apple platforms (the only targets here).
type CGFloat = f64;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: CGFloat,
    y: CGFloat,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: CGFloat,
    height: CGFloat,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

impl CGRect {
    const ZERO: CGRect = CGRect {
        origin: CGPoint { x: 0.0, y: 0.0 },
        size: CGSize {
            width: 0.0,
            height: 0.0,
        },
    };

    fn new(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> Self {
        CGRect {
            origin: CGPoint { x, y },
            size: CGSize {
                width: w,
                height: h,
            },
        }
    }
}

// ── CoreMedia / CoreFoundation FFI (spec §3.5 enqueue path) ───────────────────

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFIndex = isize;
type OSStatus = i32;
type CVImageBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

impl CMTime {
    /// `kCMTimeInvalid` — a zeroed, non-`Valid` time. With the
    /// `DisplayImmediately` attachment the layer ignores the timestamps.
    const INVALID: CMTime = CMTime {
        value: 0,
        timescale: 0,
        flags: 0,
        epoch: 0,
    };
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMSampleTimingInfo {
    duration: CMTime,
    presentationTimeStamp: CMTime,
    decodeTimeStamp: CMTime,
}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
    fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra_bytes: usize) -> Id;
    fn objc_registerClassPair(cls: Id);
    fn class_addMethod(cls: Id, name: Sel, imp: Imp, types: *const c_char) -> Bool;
    /// Struct-return message send, required on x86_64 for returns larger than two
    /// eightbytes (e.g. `CGRect`). On aarch64 the ordinary `objc_msgSend` returns
    /// such structs via the indirect-result register, so this symbol does not
    /// exist there and is only declared under x86_64.
    #[cfg(target_arch = "x86_64")]
    fn objc_msgSend_stret();
}

#[link(name = "CoreMedia", kind = "framework")]
#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "AVFoundation", kind = "framework")]
#[link(name = "QuartzCore", kind = "framework")]
#[link(name = "AppKit", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) -> *const c_void;
    fn CFDictionarySetValue(dict: CFMutableDictionaryRef, key: *const c_void, value: *const c_void);
    static kCFBooleanTrue: CFTypeRef;

    fn CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: CFAllocatorRef,
        image_buffer: CVImageBufferRef,
        format_description_out: *mut CMFormatDescriptionRef,
    ) -> OSStatus;
    fn CMSampleBufferCreateForImageBuffer(
        allocator: CFAllocatorRef,
        image_buffer: CVImageBufferRef,
        data_ready: Bool,
        make_data_ready_callback: *const c_void,
        make_data_ready_refcon: *mut c_void,
        format_description: CMFormatDescriptionRef,
        sample_timing: *const CMSampleTimingInfo,
        sample_buffer_out: *mut CMSampleBufferRef,
    ) -> OSStatus;
    fn CMSampleBufferGetSampleAttachmentsArray(
        sbuf: CMSampleBufferRef,
        create_if_necessary: Bool,
    ) -> CFArrayRef;
    static kCMSampleAttachmentKey_DisplayImmediately: CFStringRef;
}

// ── Objective-C message-send helpers (transmuted `objc_msgSend`) ──────────────
//
// `objc_msgSend` is variadic/untyped at the symbol level; every call transmutes
// it to the concrete signature the message actually has. This mirrors what
// `objc2`/`cocoa` generate and is the standard raw-FFI idiom.

#[inline]
unsafe fn class(name: &std::ffi::CStr) -> Id {
    objc_getClass(name.as_ptr())
}

#[inline]
unsafe fn sel(name: &std::ffi::CStr) -> Sel {
    sel_registerName(name.as_ptr())
}

/// `id (id, SEL)` — e.g. `alloc`, `init`, `contentView`, `layer`.
#[inline]
unsafe fn send(obj: Id, op: Sel) -> Id {
    let f: unsafe extern "C" fn(Id, Sel) -> Id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `void (id, SEL)` — e.g. `removeFromSuperview`, `release`.
#[inline]
unsafe fn send_void(obj: Id, op: Sel) {
    let f: unsafe extern "C" fn(Id, Sel) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `void (id, SEL, id)` — e.g. `setLayer:`, `enqueueSampleBuffer:`.
#[inline]
unsafe fn send_void_id(obj: Id, op: Sel, a: Id) {
    let f: unsafe extern "C" fn(Id, Sel, Id) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `void (id, SEL, BOOL)` — e.g. `setWantsLayer:`, `setHidden:`, `setMasksToBounds:`.
#[inline]
unsafe fn send_void_bool(obj: Id, op: Sel, a: Bool) {
    let f: unsafe extern "C" fn(Id, Sel, Bool) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `void (id, SEL, CGFloat)` — e.g. `setCornerRadius:`.
#[inline]
unsafe fn send_void_cgfloat(obj: Id, op: Sel, a: CGFloat) {
    let f: unsafe extern "C" fn(Id, Sel, CGFloat) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `NSInteger (id, SEL)` — e.g. `status`.
#[inline]
unsafe fn send_nsinteger(obj: Id, op: Sel) -> NSInteger {
    let f: unsafe extern "C" fn(Id, Sel) -> NSInteger =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `id (id, SEL, CGRect)` — `initWithFrame:`.
#[inline]
unsafe fn send_init_rect(obj: Id, op: Sel, r: CGRect) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, CGRect) -> Id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, r)
}

/// `void (id, SEL, CGRect)` — `setFrame:`.
#[inline]
unsafe fn send_void_rect(obj: Id, op: Sel, r: CGRect) {
    let f: unsafe extern "C" fn(Id, Sel, CGRect) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, r)
}

/// `void (id, SEL, id, NSInteger, id)` — `addSubview:positioned:relativeTo:`.
#[inline]
unsafe fn send_add_subview(obj: Id, op: Sel, view: Id, place: NSInteger, other: Id) {
    let f: unsafe extern "C" fn(Id, Sel, Id, NSInteger, Id) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, view, place, other)
}

/// `CGRect (id, SEL)` — `bounds` / `frame`. Uses the struct-return ABI: on
/// x86_64 that is `objc_msgSend_stret` (indirect result as the first argument);
/// on aarch64 the ordinary `objc_msgSend` returns the struct indirectly.
#[cfg(target_arch = "x86_64")]
#[inline]
unsafe fn send_rect(obj: Id, op: Sel) -> CGRect {
    let f: unsafe extern "C" fn(*mut CGRect, Id, Sel) =
        std::mem::transmute(objc_msgSend_stret as unsafe extern "C" fn());
    let mut out = CGRect::ZERO;
    f(&mut out, obj, op);
    out
}

#[cfg(not(target_arch = "x86_64"))]
#[inline]
unsafe fn send_rect(obj: Id, op: Sel) -> CGRect {
    let f: unsafe extern "C" fn(Id, Sel) -> CGRect =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

// ── Pass-through NSView subclass (hitTest: → nil) ─────────────────────────────

/// `hitTest:` override returning `nil` so mouse events pass through to the
/// webview below the overlay (spec §3.3/§3.6 input pass-through).
unsafe extern "C" fn passthrough_hit_test(_this: Id, _cmd: Sel, _point: CGPoint) -> Id {
    std::ptr::null_mut()
}

/// The runtime-registered pass-through `NSView` subclass, created once. Stored as
/// a `usize` so the `OnceLock` is `Send + Sync`; the class object is process-
/// global and valid for the program's life.
fn passthrough_view_class() -> Id {
    static CLASS: OnceLock<usize> = OnceLock::new();
    let raw = *CLASS.get_or_init(|| unsafe {
        let name = c"ParacordPassthroughView";
        let superclass = class(c"NSView");
        let cls = objc_allocateClassPair(superclass, name.as_ptr(), 0);
        if cls.is_null() {
            // Already registered (e.g. a prior init) — reuse the existing class.
            return objc_getClass(name.as_ptr()) as usize;
        }
        // `@@:{CGPoint=dd}`: returns id (@), implicit self (@) + _cmd (:), takes
        // one NSPoint/CGPoint argument (two doubles).
        let imp: unsafe extern "C" fn(Id, Sel, CGPoint) -> Id = passthrough_hit_test;
        class_addMethod(
            cls,
            sel(c"hitTest:"),
            std::mem::transmute::<unsafe extern "C" fn(Id, Sel, CGPoint) -> Id, Imp>(imp),
            c"@@:{CGPoint=dd}".as_ptr(),
        );
        objc_registerClassPair(cls);
        cls as usize
    });
    raw as Id
}

// ── Geometry helpers (pure; unit-testable) ────────────────────────────────────

/// Flip a top-left-origin (DOM) rect to AppKit's bottom-left `contentView`
/// space: the AppKit `y` of a tile is `content_height - (top + height)`. A
/// non-positive `content_height` (an unreadable bounds) leaves `y` unflipped.
fn flip_y(content_height: f64, top: f64, height: f64) -> f64 {
    if content_height > 0.0 {
        content_height - top - height
    } else {
        top
    }
}

/// The corner radius in logical points for `CALayer::cornerRadius`, clamped so it
/// never exceeds half the shorter logical side (a pill mask, never inverted).
fn logical_corner_radius(geometry: &SurfaceGeometry) -> f32 {
    let (_, _, w, h) = geometry.logical_rect();
    let half_min = (w.min(h) as f32) / 2.0;
    geometry.corner_radius.max(0.0).min(half_min)
}

// ── Main-thread surface registry (thread-local) ──────────────────────────────

/// A track's AppKit surface, owned by the main thread. `view` is our pass-through
/// `NSView` (its backing layer is `layer`); `layer` is the
/// `AVSampleBufferDisplayLayer` frames are enqueued on; `content_view` is the
/// window's `contentView`, read for the Y-flip height. All are retained until
/// [`destroy_surface_on_main`].
struct MainSurface {
    view: Id,
    layer: Id,
    content_view: Id,
    geometry: RefCell<SurfaceGeometry>,
}

thread_local! {
    /// Live surfaces by id (main thread only).
    static SURFACES: RefCell<HashMap<u64, MainSurface>> = RefCell::new(HashMap::new());
}

/// Build one `NSView` + `AVSampleBufferDisplayLayer` on the main thread and add
/// it above the webview (spec §3.5). Created hidden at a zero rect (spec §3.1).
fn create_surface_on_main(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main webview window not found")?;
    let ns_window = window.ns_window().map_err(|e| format!("ns_window: {e}"))? as Id;
    if ns_window.is_null() {
        return Err("ns_window returned null".into());
    }

    unsafe {
        let content_view = send(ns_window, sel(c"contentView"));
        if content_view.is_null() {
            return Err("window contentView is null".into());
        }

        // AVSampleBufferDisplayLayer: [[AVSampleBufferDisplayLayer alloc] init].
        let layer_class = class(c"AVSampleBufferDisplayLayer");
        if layer_class.is_null() {
            return Err("AVSampleBufferDisplayLayer class not found".into());
        }
        let layer = send(send(layer_class, sel(c"alloc")), sel(c"init"));
        if layer.is_null() {
            return Err("AVSampleBufferDisplayLayer init failed".into());
        }

        // Pass-through NSView hosting the display layer as its backing layer
        // ([view setLayer:]; then [view setWantsLayer:YES]).
        let view = send_init_rect(
            send(passthrough_view_class(), sel(c"alloc")),
            sel(c"initWithFrame:"),
            CGRect::ZERO,
        );
        if view.is_null() {
            send_void(layer, sel(c"release"));
            return Err("NSView init failed".into());
        }
        send_void_id(view, sel(c"setLayer:"), layer);
        send_void_bool(view, sel(c"setWantsLayer:"), YES);
        send_void_bool(view, sel(c"setHidden:"), YES);
        send_void_bool(layer, sel(c"setMasksToBounds:"), YES);

        // Add above the WKWebView sibling.
        send_add_subview(
            content_view,
            sel(c"addSubview:positioned:relativeTo:"),
            view,
            NS_WINDOW_ABOVE,
            std::ptr::null_mut(),
        );

        SURFACES.with(|surfaces| {
            surfaces.borrow_mut().insert(
                id,
                MainSurface {
                    view,
                    layer,
                    content_view,
                    geometry: RefCell::new(SurfaceGeometry {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        dpr: 1.0,
                        corner_radius: 0.0,
                        visible: false,
                    }),
                },
            );
        });
    }
    Ok(())
}

/// Apply geometry / corner radius / visibility to a surface on the main thread.
fn update_geometry_on_main(id: u64, geometry: SurfaceGeometry) {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let Some(surface) = surfaces.get(&id) else {
            return;
        };
        *surface.geometry.borrow_mut() = geometry;

        let (lx, ly, lw, lh) = geometry.logical_rect();
        unsafe {
            let content_h = send_rect(surface.content_view, sel(c"bounds")).size.height;
            let ns_y = flip_y(content_h, ly as f64, lh as f64);
            let rect = CGRect::new(lx as f64, ns_y, lw as f64, lh as f64);
            send_void_rect(surface.view, sel(c"setFrame:"), rect);
            send_void_cgfloat(
                surface.layer,
                sel(c"setCornerRadius:"),
                logical_corner_radius(&geometry) as CGFloat,
            );
            send_void_bool(
                surface.view,
                sel(c"setHidden:"),
                if geometry.visible { NO } else { YES },
            );
        }
    });
}

/// Drain the keep-latest slot and enqueue the frame on a surface's display layer
/// (main thread). A `None` slot (already consumed) is a no-op. Consecutive
/// enqueue failures accumulate in `failures` (reset on success) so `present()`
/// can surface persistent layer breakage as real errors (spec §3.7).
fn present_on_main(id: u64, slot: &Arc<Mutex<Option<DecodedFrameHandle>>>, failures: &AtomicU32) {
    let handle = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(handle) = handle else {
        return;
    };
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let Some(surface) = surfaces.get(&id) else {
            return;
        };
        match handle {
            DecodedFrameHandle::CvPixelBuffer(frame) => unsafe {
                if enqueue_pixel_buffer(surface.layer, frame.pixel_buffer()) {
                    failures.store(0, Ordering::Relaxed);
                } else {
                    failures.fetch_add(1, Ordering::Relaxed);
                }
                // `frame` drops here, releasing our CFRetain on the pixel buffer;
                // the enqueued sample buffer holds its own reference.
            },
            // present() rejects non-CVPixelBuffer handles before scheduling, so
            // this is unreachable; kept exhaustive and loud (spec §3.7).
            other => {
                tracing::error!(
                    "macOS native surface drained a non-CVPixelBuffer handle: {other:?}"
                );
            }
        }
    });
}

/// `AVSampleBufferDisplayLayer.status` value meaning the layer has failed and
/// silently discards every subsequent `enqueueSampleBuffer:` until `flush`ed
/// (`AVQueuedSampleBufferRenderingStatusFailed`).
const AV_RENDERING_STATUS_FAILED: NSInteger = 2;

/// If the display layer is in the failed state, log the failure (with the
/// layer's `error` when present) and `flush` it — per AVFoundation semantics
/// flush is what resets a failed layer so enqueues work again (spec §3.7:
/// never silently blank). Returns true when a failed state was hit.
unsafe fn recover_failed_layer(layer: Id, when: &str) -> bool {
    if send_nsinteger(layer, sel(c"status")) != AV_RENDERING_STATUS_FAILED {
        return false;
    }
    let error = send(layer, sel(c"error"));
    tracing::error!(
        has_error_object = !error.is_null(),
        "AVSampleBufferDisplayLayer in failed state ({when}); flushing to recover"
    );
    send_void(layer, sel(c"flush"));
    true
}

/// Wrap a decoded `CVPixelBuffer` in a `CMSampleBuffer` and enqueue it for
/// immediate display (spec §3.5). Returns false on any failure — including the
/// layer reporting the failed rendering status, which otherwise silently
/// discards frames forever. Callers count consecutive failures so persistent
/// breakage surfaces through the present() streak (spec §3.7).
unsafe fn enqueue_pixel_buffer(layer: Id, pb: CVImageBufferRef) -> bool {
    if pb.is_null() {
        tracing::error!("macOS native surface: null CVPixelBuffer");
        return false;
    }
    // A layer that failed earlier (display change, backgrounding, decode
    // session invalidation) must be flushed before it accepts frames again.
    // Count the frame as failed either way; the post-enqueue check below
    // decides whether the recovery took.
    let was_failed = recover_failed_layer(layer, "before enqueue");
    let mut fmt: CMFormatDescriptionRef = std::ptr::null_mut();
    let st = CMVideoFormatDescriptionCreateForImageBuffer(std::ptr::null(), pb, &mut fmt);
    if st != 0 || fmt.is_null() {
        tracing::error!("CMVideoFormatDescriptionCreateForImageBuffer failed: OSStatus {st}");
        return false;
    }

    let timing = CMSampleTimingInfo {
        duration: CMTime::INVALID,
        presentationTimeStamp: CMTime::INVALID,
        decodeTimeStamp: CMTime::INVALID,
    };
    let mut sbuf: CMSampleBufferRef = std::ptr::null_mut();
    let st = CMSampleBufferCreateForImageBuffer(
        std::ptr::null(),
        pb,
        YES, // the image buffer is ready
        std::ptr::null(),
        std::ptr::null_mut(),
        fmt,
        &timing,
        &mut sbuf,
    );
    CFRelease(fmt as CFTypeRef);
    if st != 0 || sbuf.is_null() {
        tracing::error!("CMSampleBufferCreateForImageBuffer failed: OSStatus {st}");
        return false;
    }

    // Tell the layer to display this frame immediately (no timebase is set).
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sbuf, YES);
    if !attachments.is_null() && CFArrayGetCount(attachments) > 0 {
        let dict = CFArrayGetValueAtIndex(attachments, 0) as CFMutableDictionaryRef;
        if !dict.is_null() {
            CFDictionarySetValue(
                dict,
                kCMSampleAttachmentKey_DisplayImmediately as *const c_void,
                kCFBooleanTrue as *const c_void,
            );
        }
    }

    send_void_id(layer, sel(c"enqueueSampleBuffer:"), sbuf);
    CFRelease(sbuf as CFTypeRef);
    // The failed state typically becomes observable only after an enqueue
    // attempt; recover here so the NEXT frame lands, and report this one as
    // failed so the streak counter sees persistent breakage.
    let failed_now = recover_failed_layer(layer, "after enqueue");
    !(was_failed || failed_now)
}

/// Remove and release a surface's `NSView` + layer on the main thread. Retain
/// balance: `alloc` gives us +1 on both view and layer; `addSubview:` gives the
/// superview +1 on the view; `setLayer:` gives the view +1 on the layer.
/// `removeFromSuperview` drops the superview's view ref; releasing the view then
/// deallocs it (dropping its layer ref); releasing the layer deallocs it.
fn destroy_surface_on_main(id: u64) {
    SURFACES.with(|surfaces| {
        if let Some(surface) = surfaces.borrow_mut().remove(&id) {
            unsafe {
                send_void(surface.view, sel(c"removeFromSuperview"));
                send_void(surface.view, sel(c"release"));
                send_void(surface.layer, sel(c"release"));
            }
        }
    });
}

// ── Send handle ──────────────────────────────────────────────────────────────

/// The `Send` surface handle held by the registry and the dispatch layer. Holds
/// no AppKit object; every operation marshals to the main thread via
/// `run_on_main_thread` (spec §3.5), exactly like the Linux backend.
pub struct MacosVideoSurface {
    id: SurfaceId,
    app: tauri::AppHandle,
    /// Keep-latest frame slot shared with the main-thread enqueue.
    slot: Arc<Mutex<Option<DecodedFrameHandle>>>,
    /// Coalesces wakes to at most one in-flight main-thread hop.
    wake_pending: Arc<AtomicBool>,
    /// Consecutive display-layer enqueue failures recorded on the main thread
    /// (reset on success). Read by `present()` so a layer stuck in the failed
    /// state despite flush-recovery turns into real errors that feed the
    /// dispatch layer's teardown streak (spec §3.7: never silently blank).
    enqueue_failures: Arc<AtomicU32>,
}

impl VideoSurface for MacosVideoSurface {
    fn new(app: &tauri::AppHandle, surface_id: SurfaceId) -> Result<Self, String> {
        let id = surface_id.0;
        let create_app = app.clone();

        // Create the view/layer on the main thread and block for the result (this
        // runs inside `spawn_blocking`, so blocking is fine — matches Linux).
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(create_surface_on_main(&create_app, id));
        })
        .map_err(|e| format!("run_on_main_thread (surface create) failed: {e}"))?;
        rx.recv()
            .map_err(|e| format!("surface create channel closed: {e}"))??;

        Ok(MacosVideoSurface {
            id: surface_id,
            app: app.clone(),
            slot: Arc::new(Mutex::new(None)),
            wake_pending: Arc::new(AtomicBool::new(false)),
            enqueue_failures: Arc::new(AtomicU32::new(0)),
        })
    }

    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String> {
        // Fire-and-forget at the display cadence (never block the async worker).
        let id = self.id.0;
        self.app
            .run_on_main_thread(move || update_geometry_on_main(id, geometry))
            .map_err(|e| format!("run_on_main_thread (geometry) failed: {e}"))
    }

    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String> {
        // The macOS surface presents VideoToolbox `CVPixelBuffer`s via
        // `AVSampleBufferDisplayLayer`. Any other handle means the wrong decode
        // route reached this surface — a loud error, never a silent drop or a
        // CPU-side conversion (spec §0/§3.7). This is the inverse of the Linux
        // tier-2 check, and gives the dispatch layer a real error to count toward
        // the >30-consecutive teardown streak (spec §3.7).
        if !matches!(frame, DecodedFrameHandle::CvPixelBuffer(_)) {
            return Err(format!(
                "macOS native surface received a non-CVPixelBuffer handle ({frame:?}); the \
                 AVSampleBufferDisplayLayer path requires VideoToolbox CVPixelBuffer output"
            ));
        }

        // A layer that stays failed despite per-frame flush recovery must not
        // blank silently: after 10 consecutive enqueue failures every present()
        // becomes an error, feeding the dispatch layer's >30 teardown streak
        // (spec §3.7) so the subscription dies loudly with
        // media_native_render_failed.
        let failures = self.enqueue_failures.load(Ordering::Relaxed);
        if failures >= 10 {
            return Err(format!(
                "AVSampleBufferDisplayLayer stuck in failed state ({failures} consecutive \
                 enqueue failures despite flush recovery)"
            ));
        }

        // Keep-latest: replace the pending frame and wake one enqueue.
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(frame);
        if !self.wake_pending.swap(true, Ordering::SeqCst) {
            let id = self.id.0;
            let wake = self.wake_pending.clone();
            let slot = self.slot.clone();
            let failures = self.enqueue_failures.clone();
            let _ = self.app.run_on_main_thread(move || {
                wake.store(false, Ordering::SeqCst);
                present_on_main(id, &slot, &failures);
            });
        }
        Ok(())
    }

    fn destroy(self) {
        // Real teardown runs in `Drop` so the boxed-trait-object case the registry
        // holds tears down identically (mirrors the Linux backend).
    }
}

impl Drop for MacosVideoSurface {
    fn drop(&mut self) {
        let id = self.id.0;
        let _ = self
            .app
            .run_on_main_thread(move || destroy_surface_on_main(id));
    }
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
    fn flip_y_maps_top_left_to_bottom_left() {
        // A 100-tall tile whose top is 50 from the DOM top sits, in a 600-tall
        // content view, at AppKit y = 600 - 50 - 100 = 450.
        assert_eq!(flip_y(600.0, 50.0, 100.0), 450.0);
        // A tile flush to the top fills up to the content height.
        assert_eq!(flip_y(600.0, 0.0, 600.0), 0.0);
        // An unreadable content height leaves the top coordinate unflipped.
        assert_eq!(flip_y(0.0, 50.0, 100.0), 50.0);
    }

    #[test]
    fn logical_corner_radius_clamps_to_half_short_side() {
        // 8pt radius at dpr 2 → the logical rect is 200x150; 8 < 75, unclamped.
        assert_eq!(logical_corner_radius(&geo(0, 0, 400, 300, 2.0, 8.0)), 8.0);
        // A huge radius clamps to half the shorter logical side (150/2 = 75).
        assert_eq!(
            logical_corner_radius(&geo(0, 0, 400, 300, 2.0, 9999.0)),
            75.0
        );
        // Negative floors to zero.
        assert_eq!(logical_corner_radius(&geo(0, 0, 400, 300, 1.0, -4.0)), 0.0);
    }
}
