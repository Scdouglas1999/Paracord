//! macOS native-surface backend (spec §3.5): an **underlay** below a
//! transparent WKWebView, like the Linux backend.
//!
//! # Underlay compositing
//! [`install_render_host`] clears the WKWebView's own background
//! (`drawsBackground = NO`, what wry does for a transparent webview) and paints
//! the window background the app's ground color (`--bg-base`, reported by the
//! renderer through [`set_ground_color`]). Each surface is a pass-through
//! `NSView` inserted into the webview's superview directly BELOW the webview.
//! The page punches a transparent hole where a video tile is, so the video
//! shows through it while every piece of page chrome drawn over the tile (the
//! stage's title, its buttons, the controls capsule, menus, dialogs) renders
//! ABOVE the video and receives input first. Whatever the page leaves
//! transparent with no surface beneath it falls through to the window
//! background, which is the ground color.
//!
//! Bottom to top: the window background (ground color) → the webview's
//! superview (draws nothing) → the surfaces → the WKWebView.
//!
//! # Layers
//! Each surface view hosts its own clipping `CALayer` (layer-hosting:
//! `setLayer:` before `setWantsLayer:`), which rounds and clips the tile
//! (`cornerRadius` + `masksToBounds`) and paints the letterbox bars black, as
//! the Linux shader does. The `AVSampleBufferDisplayLayer` is a sublayer of
//! it, laid out from each frame's dimensions with [`SurfaceFit::uv_window`],
//! the same math the Linux shader samples through: `contain` letterboxes,
//! `cover` fills the tile and crops around its anchor (camera tiles keep faces
//! in frame with `y: 0.35`), and a mirrored geometry (the self-view) flips the
//! display layer left to right about its center. The display layer stretches
//! the frame to its own bounds (`AVLayerVideoGravityResize`), which always have
//! the frame's proportions. Every layer change runs inside a `CATransaction`
//! with actions disabled, so nothing animates implicitly.
//!
//! # Frames
//! `present()` runs on the track's decode worker and accepts two handles:
//! - [`DecodedFrameHandle::CvPixelBuffer`]: VideoToolbox H.264 output
//!   (`'420v'` NV12), enqueued as it is, the OS's own zero-copy video path;
//! - [`DecodedFrameHandle::CpuI420`]: libvpx VP9 (or any CPU decode), copied
//!   on the worker into an IOSurface-backed `'420v'` `CVPixelBuffer` from a
//!   per-surface `CVPixelBufferPool`, with its colorimetry attached (the
//!   frame's YCbCr matrix, BT.709 primaries and transfer function), then
//!   enqueued the same way.
//!
//! Anything else is a loud error. **Nothing crosses IPC but geometry, stills
//! and stats** (spec §0/§2).
//!
//! # Reveal confirmation
//! A surface fires its [`ShownNotifier`] with a geometry's `generation` once,
//! when the view is shown at that geometry and the display layer has a frame.
//! The layer keeps showing its last enqueued frame, so when one was enqueued
//! before, the notifier fires right after the visible geometry is committed;
//! otherwise it fires after the first enqueue while visible.
//!
//! # Failure law (spec §3.7)
//! A display layer that stays in the failed state despite per-frame `flush`
//! recovery records a sticky error after [`STUCK_LAYER_FAILURES`] consecutive
//! failed enqueues; `present()` returns it on every call from then on, so the
//! decode worker's error streak tears the subscription down with
//! `media_native_render_failed` instead of the tile blanking silently.
//!
//! # Compile-unverified
//! This file is `#[cfg(target_os = "macos")]` and links the AppKit /
//! AVFoundation / CoreMedia / CoreVideo / CoreGraphics / QuartzCore / Foundation
//! frameworks and the Objective-C runtime. The Linux toolchain cannot build it
//! (no Apple SDK for the C dependencies), so it is reviewed line by line (spec
//! §8). The FFI follows the VideoToolbox encoder's idiom in `paracord-codec`:
//! raw `#[link(kind = "framework")]` externs plus `objc_msgSend` transmuted to
//! each method's real signature, no external crate.
//!
//! # Threading (mirrors [`linux`](super::linux))
//! The `Send` [`MacosVideoSurface`] handle holds no AppKit object: an
//! [`AppHandle`](tauri::AppHandle) for `run_on_main_thread`, a keep-latest
//! slot of ready-to-enqueue pixel buffers, a coalesced wake flag, the sticky
//! error slot and its pixel buffer pool. The views and layers live in a
//! main-thread `thread_local` keyed by [`SurfaceId`]; every AppKit and Core
//! Animation call runs on the main thread.
//!
//! # Input pass-through
//! The surface view is an instance of a runtime-registered `NSView` subclass
//! whose `hitTest:` returns `nil`. It sits below the webview, so the webview
//! receives input first anyway; the override makes sure no stacking quirk can
//! ever let a surface take a click meant for the page.

#![allow(non_upper_case_globals, non_snake_case)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::os::raw::{c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use paracord_codec::video::handle::{i420_to_nv12, CvPixelBufferFrame};
use paracord_codec::video::{ColorSpace, DecodedFrameHandle, PixelFormat};
use tauri::Manager;

use super::{ShownNotifier, SurfaceFit, SurfaceGeometry, SurfaceId, UvWindow, VideoSurface};

// ── Objective-C runtime + CoreGraphics scalar types ──────────────────────────

/// An Objective-C object pointer (`id`) or class pointer (`Class`).
type Id = *mut c_void;
/// A selector (`SEL`).
type Sel = *const c_void;
/// A method implementation function pointer (`IMP`).
type Imp = unsafe extern "C" fn();
/// Objective-C `BOOL` (signed char on x86_64; `bool` on arm64, which has the
/// same one-byte, 0-or-1 calling convention).
type Bool = i8;
const YES: Bool = 1;
const NO: Bool = 0;
/// CoreFoundation `Boolean` (`unsigned char`), distinct from `BOOL`.
type Boolean = u8;
/// `NSInteger`.
type NSInteger = isize;
/// `NSWindowBelow` (`NSWindowOrderingMode`): insert a subview directly below
/// the view it is positioned relative to (the WKWebView).
const NS_WINDOW_BELOW: NSInteger = -1;

/// `CGFloat` is `double` on 64-bit Apple platforms (the only targets here).
type CGFloat = f64;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct CGPoint {
    x: CGFloat,
    y: CGFloat,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct CGSize {
    width: CGFloat,
    height: CGFloat,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
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

/// `CGAffineTransform` (`a b c d tx ty`, six `CGFloat`s), passed by value to
/// `-[CALayer setAffineTransform:]`.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct CGAffineTransform {
    a: CGFloat,
    b: CGFloat,
    c: CGFloat,
    d: CGFloat,
    tx: CGFloat,
    ty: CGFloat,
}

impl CGAffineTransform {
    const IDENTITY: CGAffineTransform = CGAffineTransform {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        tx: 0.0,
        ty: 0.0,
    };
    /// Flip left to right about the layer's anchor point (its center).
    const MIRROR_X: CGAffineTransform = CGAffineTransform {
        a: -1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        tx: 0.0,
        ty: 0.0,
    };
}

// ── CoreFoundation / CoreVideo / CoreMedia FFI ───────────────────────────────

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFNumberRef = *const c_void;
type CFIndex = isize;
/// `CFNumberType` is `CF_ENUM(CFIndex, ...)`.
type CFNumberType = CFIndex;
/// `CFStringEncoding` is `UInt32`.
type CFStringEncoding = u32;
type OSStatus = i32;
type CVReturn = i32;
type CVImageBufferRef = *mut c_void;
type CVPixelBufferRef = *mut c_void;
type CVPixelBufferPoolRef = *mut c_void;
/// `CVAttachmentMode` is `CF_ENUM(uint32_t, ...)`.
type CVAttachmentMode = u32;
type CMFormatDescriptionRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CGColorRef = *mut c_void;

const kCFNumberSInt32Type: CFNumberType = 3;
const kCFStringEncodingUTF8: CFStringEncoding = 0x0800_0100;
const kCVAttachmentMode_ShouldPropagate: CVAttachmentMode = 1;
/// `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` (`'420v'`): NV12, limited
/// range, the format VideoToolbox decodes to here and CPU frames are wrapped in.
const kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: u32 = 0x3432_3076;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

impl CMTime {
    /// `kCMTimeInvalid`: a zeroed, non-`Valid` time. With the
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
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(context: *mut c_void);
    /// Struct-return message send, required on x86_64 for returns larger than two
    /// eightbytes (e.g. `CGRect`). On aarch64 the ordinary `objc_msgSend` returns
    /// such structs via the indirect-result register, so this symbol does not
    /// exist there and is only declared under x86_64.
    #[cfg(target_arch = "x86_64")]
    fn objc_msgSend_stret();
}

// One extern block per framework (one `#[link]` each). AppKit, QuartzCore and
// Foundation export no symbol used here directly: their classes (`NSView`,
// `NSColor`, `CALayer`, `CATransaction`) are looked up at run time with
// `objc_getClass`, so those blocks only make sure the frameworks are loaded.
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "QuartzCore", kind = "framework")]
extern "C" {}

#[link(name = "Foundation", kind = "framework")]
extern "C" {}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) -> *const c_void;
    fn CFDictionaryCreateMutable(
        allocator: CFAllocatorRef,
        capacity: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFMutableDictionaryRef;
    fn CFDictionarySetValue(dict: CFMutableDictionaryRef, key: *const c_void, value: *const c_void);
    fn CFNumberCreate(
        allocator: CFAllocatorRef,
        the_type: CFNumberType,
        value_ptr: *const c_void,
    ) -> CFNumberRef;
    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        c_str: *const c_char,
        encoding: CFStringEncoding,
    ) -> CFStringRef;
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorCreateGenericRGB(
        red: CGFloat,
        green: CGFloat,
        blue: CGFloat,
        alpha: CGFloat,
    ) -> CGColorRef;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferPoolCreate(
        allocator: CFAllocatorRef,
        pool_attributes: CFDictionaryRef,
        pixel_buffer_attributes: CFDictionaryRef,
        pool_out: *mut CVPixelBufferPoolRef,
    ) -> CVReturn;
    fn CVPixelBufferPoolCreatePixelBuffer(
        allocator: CFAllocatorRef,
        pixel_buffer_pool: CVPixelBufferPoolRef,
        pixel_buffer_out: *mut CVPixelBufferRef,
    ) -> CVReturn;
    fn CVPixelBufferLockBaseAddress(pixel_buffer: CVPixelBufferRef, lock_flags: u64) -> CVReturn;
    fn CVPixelBufferUnlockBaseAddress(
        pixel_buffer: CVPixelBufferRef,
        unlock_flags: u64,
    ) -> CVReturn;
    fn CVPixelBufferGetBaseAddressOfPlane(
        pixel_buffer: CVPixelBufferRef,
        plane_index: usize,
    ) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRowOfPlane(
        pixel_buffer: CVPixelBufferRef,
        plane_index: usize,
    ) -> usize;
    fn CVPixelBufferGetHeightOfPlane(pixel_buffer: CVPixelBufferRef, plane_index: usize) -> usize;
    fn CVPixelBufferGetPlaneCount(pixel_buffer: CVPixelBufferRef) -> usize;
    fn CVBufferSetAttachment(
        buffer: CVImageBufferRef,
        key: CFStringRef,
        value: CFTypeRef,
        attachment_mode: CVAttachmentMode,
    );
    static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
    static kCVPixelBufferWidthKey: CFStringRef;
    static kCVPixelBufferHeightKey: CFStringRef;
    static kCVPixelBufferIOSurfacePropertiesKey: CFStringRef;
    static kCVImageBufferYCbCrMatrixKey: CFStringRef;
    static kCVImageBufferYCbCrMatrix_ITU_R_709_2: CFStringRef;
    static kCVImageBufferYCbCrMatrix_ITU_R_601_4: CFStringRef;
    static kCVImageBufferColorPrimariesKey: CFStringRef;
    static kCVImageBufferColorPrimaries_ITU_R_709_2: CFStringRef;
    static kCVImageBufferTransferFunctionKey: CFStringRef;
    static kCVImageBufferTransferFunction_ITU_R_709_2: CFStringRef;
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: CFAllocatorRef,
        image_buffer: CVImageBufferRef,
        format_description_out: *mut CMFormatDescriptionRef,
    ) -> OSStatus;
    fn CMSampleBufferCreateForImageBuffer(
        allocator: CFAllocatorRef,
        image_buffer: CVImageBufferRef,
        data_ready: Boolean,
        make_data_ready_callback: *const c_void,
        make_data_ready_refcon: *mut c_void,
        format_description: CMFormatDescriptionRef,
        sample_timing: *const CMSampleTimingInfo,
        sample_buffer_out: *mut CMSampleBufferRef,
    ) -> OSStatus;
    fn CMSampleBufferGetSampleAttachmentsArray(
        sbuf: CMSampleBufferRef,
        create_if_necessary: Boolean,
    ) -> CFArrayRef;
    static kCMSampleAttachmentKey_DisplayImmediately: CFStringRef;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    /// `AVLayerVideoGravity` (an `NSString *`) that stretches the frame to the
    /// layer's bounds. The bounds always have the frame's proportions here, so
    /// nothing is distorted.
    static AVLayerVideoGravityResize: Id;
}

// ── Objective-C message-send helpers (transmuted `objc_msgSend`) ──────────────
//
// `objc_msgSend` is variadic/untyped at the symbol level; every call transmutes
// it to the concrete signature the message actually has. This mirrors what
// `objc2`/`cocoa` generate and is the standard raw-FFI idiom. Struct arguments
// (`CGRect`, `CGPoint`, `CGAffineTransform`) are passed by value with their
// `#[repr(C)]` layout, which the platform C ABI then places in registers or
// memory exactly as the callee expects.

#[inline]
unsafe fn class(name: &std::ffi::CStr) -> Id {
    objc_getClass(name.as_ptr())
}

#[inline]
unsafe fn sel(name: &std::ffi::CStr) -> Sel {
    sel_registerName(name.as_ptr())
}

/// `id (id, SEL)`: `alloc`, `init`, `superview`, `clearColor`, `error`.
#[inline]
unsafe fn send(obj: Id, op: Sel) -> Id {
    let f: unsafe extern "C" fn(Id, Sel) -> Id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `void (id, SEL)`: `removeFromSuperview`, `release`, `flush`, `+begin`.
#[inline]
unsafe fn send_void(obj: Id, op: Sel) {
    let f: unsafe extern "C" fn(Id, Sel) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `void (id, SEL, id)`: `setLayer:`, `addSublayer:`, `enqueueSampleBuffer:`,
/// `setVideoGravity:`, `setBackgroundColor:` (an `NSColor *`, or a
/// `CGColorRef` for `CALayer`, both pointers).
#[inline]
unsafe fn send_void_id(obj: Id, op: Sel, a: Id) {
    let f: unsafe extern "C" fn(Id, Sel, Id) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `void (id, SEL, id, id)`: `setValue:forKey:`.
#[inline]
unsafe fn send_void_id_id(obj: Id, op: Sel, a: Id, b: Id) {
    let f: unsafe extern "C" fn(Id, Sel, Id, Id) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a, b)
}

/// `void (id, SEL, BOOL)`: `setWantsLayer:`, `setHidden:`, `setMasksToBounds:`,
/// `setGeometryFlipped:`, `+setDisableActions:`.
#[inline]
unsafe fn send_void_bool(obj: Id, op: Sel, a: Bool) {
    let f: unsafe extern "C" fn(Id, Sel, Bool) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `BOOL (id, SEL)`: `isGeometryFlipped`.
#[inline]
unsafe fn send_bool(obj: Id, op: Sel) -> Bool {
    let f: unsafe extern "C" fn(Id, Sel) -> Bool =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `BOOL (id, SEL, SEL)`: `respondsToSelector:`.
#[inline]
unsafe fn send_bool_sel(obj: Id, op: Sel, a: Sel) -> Bool {
    let f: unsafe extern "C" fn(Id, Sel, Sel) -> Bool =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `void (id, SEL, CGFloat)`: `setCornerRadius:`, `setContentsScale:`.
#[inline]
unsafe fn send_void_cgfloat(obj: Id, op: Sel, a: CGFloat) {
    let f: unsafe extern "C" fn(Id, Sel, CGFloat) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, a)
}

/// `CGFloat (id, SEL)`: `backingScaleFactor`. A `double` return comes back in
/// a floating-point register through plain `objc_msgSend` on both arm64 and
/// x86_64 (`objc_msgSend_fpret` is only needed for `long double` on x86_64).
#[inline]
unsafe fn send_cgfloat(obj: Id, op: Sel) -> CGFloat {
    let f: unsafe extern "C" fn(Id, Sel) -> CGFloat =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `id (Class, SEL, CGFloat, CGFloat, CGFloat, CGFloat)`:
/// `+[NSColor colorWithSRGBRed:green:blue:alpha:]`.
#[inline]
unsafe fn send_rgba(obj: Id, op: Sel, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, CGFloat, CGFloat, CGFloat, CGFloat) -> Id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, r, g, b, a)
}

/// `NSInteger (id, SEL)`: `status`.
#[inline]
unsafe fn send_nsinteger(obj: Id, op: Sel) -> NSInteger {
    let f: unsafe extern "C" fn(Id, Sel) -> NSInteger =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op)
}

/// `id (id, SEL, CGRect)`: `initWithFrame:`.
#[inline]
unsafe fn send_init_rect(obj: Id, op: Sel, r: CGRect) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, CGRect) -> Id =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, r)
}

/// `void (id, SEL, CGRect)`: `setFrame:`, `setBounds:`.
#[inline]
unsafe fn send_void_rect(obj: Id, op: Sel, r: CGRect) {
    let f: unsafe extern "C" fn(Id, Sel, CGRect) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, r)
}

/// `void (id, SEL, CGPoint)`: `-[CALayer setPosition:]`.
#[inline]
unsafe fn send_void_point(obj: Id, op: Sel, p: CGPoint) {
    let f: unsafe extern "C" fn(Id, Sel, CGPoint) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, p)
}

/// `void (id, SEL, CGAffineTransform)`: `-[CALayer setAffineTransform:]`.
#[inline]
unsafe fn send_void_affine(obj: Id, op: Sel, t: CGAffineTransform) {
    let f: unsafe extern "C" fn(Id, Sel, CGAffineTransform) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, t)
}

/// `void (id, SEL, id, NSInteger, id)`: `addSubview:positioned:relativeTo:`.
#[inline]
unsafe fn send_add_subview(obj: Id, op: Sel, view: Id, place: NSInteger, other: Id) {
    let f: unsafe extern "C" fn(Id, Sel, Id, NSInteger, Id) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(obj, op, view, place, other)
}

/// `CGRect (id, SEL)`: `frame`. Uses the struct-return ABI: on x86_64 that is
/// `objc_msgSend_stret` (indirect result as the first argument); on aarch64
/// the ordinary `objc_msgSend` returns the struct indirectly (x8).
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

/// Whether `obj` implements `selector` (`-[NSObject respondsToSelector:]`).
#[inline]
unsafe fn responds(obj: Id, selector: &std::ffi::CStr) -> bool {
    send_bool_sel(obj, sel(c"respondsToSelector:"), sel(selector)) != NO
}

/// Run `f` inside an autorelease pool, so the autoreleased objects AppKit hands
/// back (`+[NSColor ...]`, getters) are freed when this main-thread hop ends
/// rather than whenever the run loop next drains.
fn with_autorelease_pool<T>(f: impl FnOnce() -> T) -> T {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let out = f();
        objc_autoreleasePoolPop(pool);
        out
    }
}

/// Run `f` inside an explicit `CATransaction` with implicit animations
/// disabled, so frame, bounds, position, transform and corner changes land at
/// once instead of animating over a quarter second.
unsafe fn without_animation<T>(f: impl FnOnce() -> T) -> T {
    let transaction = class(c"CATransaction");
    send_void(transaction, sel(c"begin"));
    send_void_bool(transaction, sel(c"setDisableActions:"), YES);
    let out = f();
    send_void(transaction, sel(c"commit"));
    out
}

// ── Pass-through NSView subclass (hitTest: → nil) ─────────────────────────────

/// `hitTest:` override returning `nil`, so the surface view never takes a mouse
/// event (spec §3.3/§3.6 input pass-through).
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
            // Already registered (e.g. a prior init): reuse the existing class.
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

/// Flip a top-left-origin (DOM) rect to AppKit's bottom-left space: the AppKit
/// `y` of a tile is `container_height - (top + height)`, from the container's
/// bottom edge. A non-positive
/// `container_height` (an unreadable bounds) leaves `y` unflipped.
fn flip_y(container_height: f64, top: f64, height: f64) -> f64 {
    if container_height > 0.0 {
        container_height - top - height
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

/// Where the display layer sits in its tile: its center (`CALayer.position`,
/// in the clipping layer's own bottom-left-origin space), its size, and
/// whether it is flipped left to right.
#[derive(Debug, Clone, Copy, PartialEq)]
struct DisplayLayout {
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    mirrored: bool,
}

/// Lay the display layer out so the tile shows exactly what the Linux shader
/// samples through `window` ([`UvWindow`]): a tile point `uv` (0..1, top-left
/// origin) shows the frame at `(uv - 0.5) * scale + center`. Solving for the
/// frame's own middle (0.5) puts it at `uv = 0.5 + (0.5 - center) / scale`,
/// and the frame spans `1 / |scale|` of the tile on each axis. A negative
/// horizontal scale (a mirrored window) runs the frame right to left, which is
/// the same rectangle flipped about its center. The vertical position is
/// turned into the layer's bottom-left space at the end.
fn display_layout(window: UvWindow, tile_w: f64, tile_h: f64) -> DisplayLayout {
    let finite_or_one = |v: f32| -> f64 {
        let v = f64::from(v);
        if v.is_finite() && v != 0.0 {
            v
        } else {
            1.0
        }
    };
    let (sx, sy) = (
        finite_or_one(window.scale[0]),
        finite_or_one(window.scale[1]),
    );
    let (cx, cy) = (f64::from(window.center[0]), f64::from(window.center[1]));
    let middle_u = 0.5 + (0.5 - cx) / sx;
    let middle_v_from_top = 0.5 + (0.5 - cy) / sy;
    DisplayLayout {
        center_x: middle_u * tile_w,
        center_y: (1.0 - middle_v_from_top) * tile_h,
        width: tile_w / sx.abs(),
        height: tile_h / sy.abs(),
        mirrored: sx < 0.0,
    }
}

/// Whether a surface should confirm a reveal now: it has a frame on its layer,
/// it is visible, and its geometry's generation has not been confirmed yet.
fn reveal_due(has_frame: bool, geometry: &SurfaceGeometry, confirmed: u64) -> bool {
    has_frame && geometry.visible && geometry.generation > confirmed
}

// ── Render host (main thread) ─────────────────────────────────────────────────

/// The window's views the surfaces are stacked between. Held for the life of
/// the process (the main window is never re-created).
///
/// Retain balance: `webview` and `ns_window` each arrive with a +1 from
/// `with_webview` (tauri-runtime-wry hands them over with
/// `Retained::into_raw`) and keep it; `host_view` is `[webview superview]`,
/// retained +1 here. None is released: the host lives as long as the app.
struct RenderHost {
    ns_window: Id,
    webview: Id,
    host_view: Id,
}

thread_local! {
    /// Set once by [`install_render_host`] (main thread only).
    static RENDER_HOST: RefCell<Option<RenderHost>> = const { RefCell::new(None) };
    /// Live surfaces by id (main thread only).
    static SURFACES: RefCell<HashMap<u64, MainSurface>> = RefCell::new(HashMap::new());
}

/// The app's ground color (`--bg-base`), as the renderer resolved it, `#rrggbb`.
/// See the Linux backend's `GROUND_COLOR` for why the shell repeats what the
/// renderer says instead of holding a literal. `None` until the renderer has
/// spoken; until then the window keeps AppKit's own background.
static GROUND_COLOR: Mutex<Option<String>> = Mutex::new(None);

/// Paint the window background `color` (main thread). `+[NSColor
/// colorWithSRGBRed:...]` is autoreleased; `setBackgroundColor:` retains it.
unsafe fn paint_ground(ns_window: Id, color: &str) {
    let [r, g, b] = super::ground_rgb(color);
    let ns_color = send_rgba(
        class(c"NSColor"),
        sel(c"colorWithSRGBRed:green:blue:alpha:"),
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
        1.0,
    );
    send_void_id(ns_window, sel(c"setBackgroundColor:"), ns_color);
}

/// Paint `color` if the host is installed (main thread), and say so in the
/// client log.
fn paint_ground_on_main(app: &tauri::AppHandle, color: &str) {
    let painted = RENDER_HOST.with(|host| match host.borrow().as_ref() {
        Some(host) => {
            with_autorelease_pool(|| unsafe { paint_ground(host.ns_window, color) });
            true
        }
        None => false,
    });
    if painted {
        let _ = crate::commands::append_client_log(
            app.clone(),
            format!("[native-render] underlay ground color is now {color} (--bg-base)"),
        );
    }
}

/// The renderer's answer for `--bg-base`, already validated as `#rrggbb`
/// (`super::validated_ground_color`). Remembered even when no host is
/// installed yet, so the color is in hand when one is.
pub fn set_ground_color(app: &tauri::AppHandle, color: &str) -> Result<(), String> {
    let color = color.to_string();
    {
        let mut slot = GROUND_COLOR.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_deref() == Some(color.as_str()) {
            return Ok(());
        }
        *slot = Some(color.clone());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || paint_ground_on_main(&handle, &color))
        .map_err(|e| format!("run_on_main_thread (ground color) failed: {e}"))
}

/// Make the main window's WKWebView transparent and get the window ready for
/// surfaces below it. Runs on the main thread (the Tauri `setup` hook).
///
/// The WKWebView comes from `with_webview`, which on the main thread runs its
/// callback synchronously (tauri-runtime-wry's `send_user_message` handles the
/// message in place); a callback that did not run is an error, not a reason
/// to look for the webview some other way.
pub fn install_render_host(app: &tauri::AppHandle) -> Result<(), String> {
    if RENDER_HOST.with(|h| h.borrow().is_some()) {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main webview window not found")?;

    // (webview, user content controller, NSWindow), as addresses so the
    // closure is `Send`.
    let handed: Arc<Mutex<Option<(usize, usize, usize)>>> = Arc::new(Mutex::new(None));
    let sink = handed.clone();
    window
        .with_webview(move |platform| {
            *sink.lock().unwrap_or_else(|e| e.into_inner()) = Some((
                platform.inner() as usize,
                platform.controller() as usize,
                platform.ns_window() as usize,
            ));
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;
    let Some((webview, controller, ns_window)) =
        handed.lock().unwrap_or_else(|e| e.into_inner()).take()
    else {
        return Err(
            "with_webview did not hand over the WKWebView synchronously; the video host must \
             be installed on the main thread (the Tauri setup hook)"
                .to_string(),
        );
    };

    with_autorelease_pool(|| unsafe {
        install_on_main(app, webview as Id, controller as Id, ns_window as Id)
    })
}

/// The body of [`install_render_host`]. Each of the three pointers arrives
/// with a +1 that is ours (see [`RenderHost`]): the controller's is dropped
/// here; the webview's and the window's are kept on success and dropped on
/// failure.
unsafe fn install_on_main(
    app: &tauri::AppHandle,
    webview: Id,
    controller: Id,
    ns_window: Id,
) -> Result<(), String> {
    if !controller.is_null() {
        send_void(controller, sel(c"release"));
    }
    let fail = |reason: String| -> Result<(), String> {
        if !webview.is_null() {
            send_void(webview, sel(c"release"));
        }
        if !ns_window.is_null() {
            send_void(ns_window, sel(c"release"));
        }
        Err(reason)
    };
    if webview.is_null() || ns_window.is_null() {
        return fail("with_webview handed over a null WKWebView or NSWindow".to_string());
    }

    // 1. Clear the webview's own background. Without this WebKit paints an
    // opaque page background and no surface below can ever show through, so a
    // webview that cannot be made transparent is a hard install error. The key
    // is private (wry uses the same KVC on the same instance for its
    // `transparent` webviews); KVC finds it through `setDrawsBackground:` or
    // `_setDrawsBackground:`. Checking for either first keeps an unknown key
    // from raising `NSUnknownKeyException` through Rust.
    if !responds(webview, c"setDrawsBackground:") && !responds(webview, c"_setDrawsBackground:") {
        return fail(
            "this WKWebView has no drawsBackground setter; it cannot be made transparent, so \
             no video can show below it"
                .to_string(),
        );
    }
    let key = CFStringCreateWithCString(
        std::ptr::null(),
        c"drawsBackground".as_ptr(),
        kCFStringEncodingUTF8,
    );
    if key.is_null() {
        return fail("CFStringCreateWithCString(drawsBackground) failed".to_string());
    }
    // `kCFBooleanFalse` is toll-free bridged to `NSNumber` (@NO).
    send_void_id_id(
        webview,
        sel(c"setValue:forKey:"),
        kCFBooleanFalse as Id,
        key as Id,
    );
    CFRelease(key);
    // The color WebKit shows past the page's edges while rubber-band
    // scrolling (macOS 12+). Clear, so an overscroll shows what is below
    // rather than a solid sheet over it.
    if responds(webview, c"setUnderPageBackgroundColor:") {
        let clear = send(class(c"NSColor"), sel(c"clearColor"));
        send_void_id(webview, sel(c"setUnderPageBackgroundColor:"), clear);
    }

    // 2. The surfaces' container: the webview's superview (wry's
    // `WryWebViewParent`, the window's contentView, which draws nothing). Make
    // the whole subtree layer-backed so the surfaces, the webview and their
    // order composite as layers.
    let host_view = send(webview, sel(c"superview"));
    if host_view.is_null() {
        return fail("the WKWebView has no superview to put video below it in".to_string());
    }
    send_void_bool(host_view, sel(c"setWantsLayer:"), YES);
    send(host_view, sel(c"retain"));

    RENDER_HOST.with(|h| {
        *h.borrow_mut() = Some(RenderHost {
            ns_window,
            webview,
            host_view,
        })
    });

    // 3. The ground: whatever the page leaves transparent with no surface below
    // it shows the window background. A color reported before the host
    // existed is not lost.
    let known = GROUND_COLOR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(color) = known {
        paint_ground_on_main(app, &color);
    }
    tracing::info!(
        "native surface backend installed: AVSampleBufferDisplayLayer UNDERLAY below a \
         transparent WKWebView; VideoToolbox CVPixelBuffers enqueued as they are, CPU I420 \
         copied into pooled NV12 CVPixelBuffers"
    );
    Ok(())
}

// ── Main-thread surfaces ──────────────────────────────────────────────────────

/// After this many consecutive failed enqueues the surface records a sticky
/// error (see the module's failure law).
const STUCK_LAYER_FAILURES: u32 = 10;

/// A track's AppKit surface, owned by the main thread.
///
/// Retain balance: `view`, `clip` and `display` each hold the +1 from their
/// `alloc`/`init`. While attached, the host view holds a +1 on `view`
/// (`addSubview:`), `view` holds a +1 on `clip` (`setLayer:`), and `clip`
/// holds a +1 on `display` (`addSublayer:`). [`destroy_surface_on_main`]
/// detaches both, then drops our three.
struct MainSurface {
    view: Id,
    clip: Id,
    display: Id,
    fit: SurfaceFit,
    geometry: Cell<SurfaceGeometry>,
    /// The size of the last frame enqueued, which the layout follows.
    frame_size: Cell<Option<(u32, u32)>>,
    /// Whether the display layer has a frame to show (cleared when it fails).
    has_frame: Cell<bool>,
    /// The last generation [`ShownNotifier::fire`] was called with.
    confirmed: Cell<u64>,
    shown: ShownNotifier,
    /// Consecutive failed enqueues.
    failures: Cell<u32>,
    /// Shared with the `Send` handle; see [`MacosVideoSurface::error_slot`].
    error_slot: Arc<Mutex<Option<String>>>,
}

/// Build one surface on the main thread and put it directly below the
/// webview. Created hidden at a zero rect (spec §3.1).
fn create_surface_on_main(
    id: u64,
    fit: SurfaceFit,
    shown: ShownNotifier,
    error_slot: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    RENDER_HOST.with(|host| {
        let host = host.borrow();
        let host = host
            .as_ref()
            .ok_or("native render host not installed (the WKWebView was not made transparent)")?;
        unsafe {
            let layer_class = class(c"CALayer");
            let display_class = class(c"AVSampleBufferDisplayLayer");
            if layer_class.is_null() || display_class.is_null() {
                return Err("CALayer or AVSampleBufferDisplayLayer class not found".to_string());
            }
            let clip = send(send(layer_class, sel(c"alloc")), sel(c"init"));
            if clip.is_null() {
                return Err("CALayer init failed".to_string());
            }
            let display = send(send(display_class, sel(c"alloc")), sel(c"init"));
            if display.is_null() {
                send_void(clip, sel(c"release"));
                return Err("AVSampleBufferDisplayLayer init failed".to_string());
            }
            let view = send_init_rect(
                send(passthrough_view_class(), sel(c"alloc")),
                sel(c"initWithFrame:"),
                CGRect::ZERO,
            );
            if view.is_null() {
                send_void(display, sel(c"release"));
                send_void(clip, sel(c"release"));
                return Err("NSView init failed".to_string());
            }

            let scale = send_cgfloat(host.ns_window, sel(c"backingScaleFactor"));
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            // CGColorCreateGenericRGB is +1; the layer retains what it is given.
            let black = CGColorCreateGenericRGB(0.0, 0.0, 0.0, 1.0);
            without_animation(|| {
                // The clipping layer: rounds and clips the tile, paints the
                // letterbox bars black (as the Linux shader's empty samples),
                // and keeps the unflipped bottom-left geometry the layout
                // math below converts into.
                send_void_bool(clip, sel(c"setMasksToBounds:"), YES);
                send_void_bool(clip, sel(c"setGeometryFlipped:"), NO);
                send_void_cgfloat(clip, sel(c"setContentsScale:"), scale);
                if !black.is_null() {
                    send_void_id(clip, sel(c"setBackgroundColor:"), black);
                }
                send_void_id(display, sel(c"setVideoGravity:"), AVLayerVideoGravityResize);
                send_void_cgfloat(display, sel(c"setContentsScale:"), scale);
                send_void_id(clip, sel(c"addSublayer:"), display);
            });
            if !black.is_null() {
                CFRelease(black as CFTypeRef);
            }

            // Layer-hosting: `setLayer:` before `setWantsLayer:`, so the view
            // hosts our clipping layer instead of making a backing layer of
            // its own.
            send_void_id(view, sel(c"setLayer:"), clip);
            send_void_bool(view, sel(c"setWantsLayer:"), YES);
            send_void_bool(view, sel(c"setHidden:"), YES);
            send_add_subview(
                host.host_view,
                sel(c"addSubview:positioned:relativeTo:"),
                view,
                NS_WINDOW_BELOW,
                host.webview,
            );

            tracing::debug!(
                surface_id = shown.surface_id().0,
                "macOS native surface created below the webview"
            );
            SURFACES.with(|surfaces| {
                surfaces.borrow_mut().insert(
                    id,
                    MainSurface {
                        view,
                        clip,
                        display,
                        fit,
                        geometry: Cell::new(SurfaceGeometry {
                            x: 0,
                            y: 0,
                            width: 1,
                            height: 1,
                            dpr: 1.0,
                            corner_radius: 0.0,
                            visible: false,
                            generation: 0,
                            mirrored: false,
                        }),
                        frame_size: Cell::new(None),
                        has_frame: Cell::new(false),
                        confirmed: Cell::new(0),
                        shown,
                        failures: Cell::new(0),
                        error_slot,
                    },
                );
            });
        }
        Ok(())
    })
}

/// Lay the display layer out for the surface's current geometry and frame
/// size (call inside [`without_animation`]). Nothing to lay out before the
/// first frame. Uses `bounds` + `position` + `affineTransform` rather than
/// `frame`, which is undefined under a non-identity transform.
unsafe fn layout_display(surface: &MainSurface) {
    let Some((frame_w, frame_h)) = surface.frame_size.get() else {
        return;
    };
    let geometry = surface.geometry.get();
    let (_, _, tile_w, tile_h) = geometry.logical_rect();
    let mut window =
        surface
            .fit
            .uv_window(tile_w as f32, tile_h as f32, frame_w as f32, frame_h as f32);
    if geometry.mirrored {
        window = window.mirrored();
    }
    let layout = display_layout(window, f64::from(tile_w), f64::from(tile_h));
    // The clipping layer is created unflipped (bottom-left origin), which is
    // what `display_layout` answers in. Should AppKit ever flip a hosted
    // layer's geometry, measure from the top instead rather than move the
    // crop to the wrong end.
    let center_y = if send_bool(surface.clip, sel(c"isGeometryFlipped")) != NO {
        f64::from(tile_h) - layout.center_y
    } else {
        layout.center_y
    };
    send_void_rect(
        surface.display,
        sel(c"setBounds:"),
        CGRect::new(0.0, 0.0, layout.width, layout.height),
    );
    send_void_point(
        surface.display,
        sel(c"setPosition:"),
        CGPoint {
            x: layout.center_x,
            y: center_y,
        },
    );
    send_void_affine(
        surface.display,
        sel(c"setAffineTransform:"),
        if layout.mirrored {
            CGAffineTransform::MIRROR_X
        } else {
            CGAffineTransform::IDENTITY
        },
    );
}

/// Fire the surface's notifier if a reveal is due (see [`reveal_due`]).
fn confirm_reveal(surface: &MainSurface) {
    let geometry = surface.geometry.get();
    if reveal_due(surface.has_frame.get(), &geometry, surface.confirmed.get()) {
        surface.confirmed.set(geometry.generation);
        surface.shown.fire(geometry.generation);
    }
}

/// Apply geometry / corner radius / visibility / mirroring on the main thread,
/// then confirm a reveal once the transaction that shows the view is
/// committed.
fn update_geometry_on_main(id: u64, geometry: SurfaceGeometry) {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let Some(surface) = surfaces.get(&id) else {
            return;
        };
        surface.geometry.set(geometry);
        // The webview's frame in the host view (it fills it in a Tauri
        // window, but nothing below depends on that).
        let webview_frame = RENDER_HOST.with(|host| {
            host.borrow()
                .as_ref()
                .map(|host| unsafe { send_rect(host.webview, sel(c"frame")) })
                .unwrap_or(CGRect::ZERO)
        });
        let (lx, ly, lw, lh) = geometry.logical_rect();
        unsafe {
            without_animation(|| {
                // DOM coordinates are top-left within the webview; the host
                // view's are bottom-left (it is not flipped).
                let ns_x = webview_frame.origin.x + f64::from(lx);
                let ns_y = webview_frame.origin.y
                    + flip_y(webview_frame.size.height, f64::from(ly), f64::from(lh));
                send_void_rect(
                    surface.view,
                    sel(c"setFrame:"),
                    CGRect::new(ns_x, ns_y, f64::from(lw), f64::from(lh)),
                );
                send_void_cgfloat(
                    surface.clip,
                    sel(c"setCornerRadius:"),
                    CGFloat::from(logical_corner_radius(&geometry)),
                );
                layout_display(surface);
                send_void_bool(
                    surface.view,
                    sel(c"setHidden:"),
                    if geometry.visible { NO } else { YES },
                );
            });
        }
        confirm_reveal(surface);
    });
}

/// Drain the keep-latest slot and enqueue the frame on the surface's display
/// layer (main thread). An empty slot (already consumed) is a no-op.
fn present_on_main(id: u64, slot: &Arc<Mutex<Option<CvPixelBufferFrame>>>) {
    let Some(buffer) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.borrow();
        let Some(surface) = surfaces.get(&id) else {
            return;
        };
        let size = (buffer.width(), buffer.height());
        unsafe {
            if surface.frame_size.get() != Some(size) {
                surface.frame_size.set(Some(size));
                without_animation(|| layout_display(surface));
            }
            match enqueue_pixel_buffer(surface.display, buffer.pixel_buffer()) {
                Ok(()) => {
                    surface.failures.set(0);
                    surface.has_frame.set(true);
                    confirm_reveal(surface);
                }
                Err(reason) => {
                    tracing::error!("macOS native surface enqueue failed: {reason}");
                    surface.has_frame.set(false);
                    let failures = surface.failures.get().saturating_add(1);
                    surface.failures.set(failures);
                    if failures >= STUCK_LAYER_FAILURES {
                        let mut sticky =
                            surface.error_slot.lock().unwrap_or_else(|e| e.into_inner());
                        if sticky.is_none() {
                            *sticky = Some(format!(
                                "AVSampleBufferDisplayLayer failed {failures} enqueues in a row \
                                 despite flush recovery (last: {reason})"
                            ));
                        }
                    }
                }
            }
        }
    });
    // `buffer` drops here, releasing the handle's reference; the enqueued
    // sample buffer holds its own.
}

/// `AVSampleBufferDisplayLayer.status` value meaning the layer has failed and
/// silently discards every subsequent `enqueueSampleBuffer:` until `flush`ed
/// (`AVQueuedSampleBufferRenderingStatusFailed`).
const AV_RENDERING_STATUS_FAILED: NSInteger = 2;

/// If the display layer is in the failed state, log the failure (with whether
/// the layer has an `error`) and `flush` it; per AVFoundation semantics flush
/// is what resets a failed layer so enqueues work again (spec §3.7: never
/// silently blank). Returns true when a failed state was hit.
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

/// Wrap a `CVPixelBuffer` in a `CMSampleBuffer` and enqueue it for immediate
/// display (spec §3.5). Fails with the reason on any error, including the
/// layer reporting the failed rendering status, which otherwise silently
/// discards frames forever.
///
/// Retain balance: the format description and the sample buffer are created
/// +1 here and released here; the sample buffer retains the pixel buffer and
/// the layer retains the sample buffer it queues.
unsafe fn enqueue_pixel_buffer(layer: Id, pb: CVImageBufferRef) -> Result<(), String> {
    if pb.is_null() {
        return Err("null CVPixelBuffer".to_string());
    }
    // A layer that failed earlier (display change, backgrounding, decode
    // session invalidation) must be flushed before it accepts frames again.
    // Count the frame as failed either way; the post-enqueue check below
    // decides whether the recovery took.
    let was_failed = recover_failed_layer(layer, "before enqueue");
    let mut fmt: CMFormatDescriptionRef = std::ptr::null_mut();
    let st = CMVideoFormatDescriptionCreateForImageBuffer(std::ptr::null(), pb, &mut fmt);
    if st != 0 || fmt.is_null() {
        return Err(format!(
            "CMVideoFormatDescriptionCreateForImageBuffer failed: OSStatus {st}"
        ));
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
        1, // the image buffer is ready
        std::ptr::null(),
        std::ptr::null_mut(),
        fmt,
        &timing,
        &mut sbuf,
    );
    CFRelease(fmt as CFTypeRef);
    if st != 0 || sbuf.is_null() {
        return Err(format!(
            "CMSampleBufferCreateForImageBuffer failed: OSStatus {st}"
        ));
    }

    // Tell the layer to display this frame immediately (no timebase is set).
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sbuf, 1);
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
    if was_failed || failed_now {
        return Err("the layer was in the failed rendering state and was flushed".to_string());
    }
    Ok(())
}

/// Remove and release a surface's view and layers on the main thread (see
/// [`MainSurface`] for the retain balance). The display layer is emptied and
/// detached from the clipping layer, the view from the host view; then our
/// three +1s go, deallocating all three.
fn destroy_surface_on_main(id: u64) {
    let Some(surface) = SURFACES.with(|surfaces| surfaces.borrow_mut().remove(&id)) else {
        return;
    };
    unsafe {
        without_animation(|| {
            send_void(surface.display, sel(c"flushAndRemoveImage"));
            send_void(surface.display, sel(c"removeFromSuperlayer"));
            send_void(surface.view, sel(c"removeFromSuperview"));
        });
        send_void(surface.view, sel(c"release"));
        send_void(surface.display, sel(c"release"));
        send_void(surface.clip, sel(c"release"));
    }
}

// ── CPU I420 → CVPixelBuffer (decode worker) ─────────────────────────────────

/// A `CVPixelBufferPool` of IOSurface-backed `'420v'` buffers of one size, so
/// wrapping CPU frames does not allocate per frame. The pool is created +1 and
/// released on drop. CoreVideo pools are thread-safe; this one is only used
/// through `&mut` from the decode worker.
struct Nv12Pool {
    pool: CVPixelBufferPoolRef,
    width: u32,
    height: u32,
}

// Safety: a `CVPixelBufferPool` is a thread-safe CF object; the pointer is only
// used through `&mut self` (or dropped) by whichever thread owns the handle.
unsafe impl Send for Nv12Pool {}

impl Nv12Pool {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        unsafe {
            let attrs = CFDictionaryCreateMutable(
                std::ptr::null(),
                0,
                &kCFTypeDictionaryKeyCallBacks as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const c_void,
            );
            if attrs.is_null() {
                return Err("CFDictionaryCreateMutable (pool attributes) failed".to_string());
            }
            let format = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange as i32;
            let (w, h) = (width as i32, height as i32);
            let numbers = [
                (kCVPixelBufferPixelFormatTypeKey, &format),
                (kCVPixelBufferWidthKey, &w),
                (kCVPixelBufferHeightKey, &h),
            ];
            for (key, value) in numbers {
                let number = CFNumberCreate(
                    std::ptr::null(),
                    kCFNumberSInt32Type,
                    value as *const i32 as *const c_void,
                );
                if number.is_null() {
                    CFRelease(attrs as CFTypeRef);
                    return Err("CFNumberCreate (pool attributes) failed".to_string());
                }
                // The dictionary retains what it is given.
                CFDictionarySetValue(attrs, key as *const c_void, number);
                CFRelease(number);
            }
            // An empty IOSurface properties dictionary asks for IOSurface
            // backing, which the display layer takes without a copy.
            let iosurface = CFDictionaryCreateMutable(
                std::ptr::null(),
                0,
                &kCFTypeDictionaryKeyCallBacks as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const c_void,
            );
            if iosurface.is_null() {
                CFRelease(attrs as CFTypeRef);
                return Err("CFDictionaryCreateMutable (IOSurface properties) failed".to_string());
            }
            CFDictionarySetValue(
                attrs,
                kCVPixelBufferIOSurfacePropertiesKey as *const c_void,
                iosurface as *const c_void,
            );
            CFRelease(iosurface as CFTypeRef);

            let mut pool: CVPixelBufferPoolRef = std::ptr::null_mut();
            let status =
                CVPixelBufferPoolCreate(std::ptr::null(), std::ptr::null(), attrs, &mut pool);
            CFRelease(attrs as CFTypeRef);
            if status != 0 || pool.is_null() {
                return Err(format!(
                    "CVPixelBufferPoolCreate ({width}x{height} '420v') failed: CVReturn {status}"
                ));
            }
            Ok(Self {
                pool,
                width,
                height,
            })
        }
    }
}

impl Drop for Nv12Pool {
    fn drop(&mut self) {
        if !self.pool.is_null() {
            unsafe { CFRelease(self.pool as CFTypeRef) };
        }
    }
}

/// Attach the colorimetry the Linux shader assumes: the frame's own YCbCr
/// matrix, with BT.709 primaries and transfer function. The Linux surface does
/// no gamut conversion, so the primaries are the ones (BT.709, which sRGB
/// shares) that keep macOS from converting either; only the matrix follows the
/// frame.
unsafe fn attach_colorimetry(pb: CVPixelBufferRef, colorspace: ColorSpace) {
    let matrix = match colorspace {
        ColorSpace::Bt709 => kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ColorSpace::Bt601 => kCVImageBufferYCbCrMatrix_ITU_R_601_4,
    };
    CVBufferSetAttachment(
        pb,
        kCVImageBufferYCbCrMatrixKey,
        matrix,
        kCVAttachmentMode_ShouldPropagate,
    );
    CVBufferSetAttachment(
        pb,
        kCVImageBufferColorPrimariesKey,
        kCVImageBufferColorPrimaries_ITU_R_709_2,
        kCVAttachmentMode_ShouldPropagate,
    );
    CVBufferSetAttachment(
        pb,
        kCVImageBufferTransferFunctionKey,
        kCVImageBufferTransferFunction_ITU_R_709_2,
        kCVAttachmentMode_ShouldPropagate,
    );
}

/// Copy a tightly packed I420 frame into a locked `'420v'` buffer's planes.
unsafe fn fill_nv12(
    pb: CVPixelBufferRef,
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<(), String> {
    if CVPixelBufferGetPlaneCount(pb) != 2 {
        return Err("the pooled '420v' buffer does not have two planes".to_string());
    }
    let status = CVPixelBufferLockBaseAddress(pb, 0);
    if status != 0 {
        return Err(format!(
            "CVPixelBufferLockBaseAddress failed: CVReturn {status}"
        ));
    }
    let y_base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) as *mut u8;
    let uv_base = CVPixelBufferGetBaseAddressOfPlane(pb, 1) as *mut u8;
    let result = if y_base.is_null() || uv_base.is_null() {
        Err("a '420v' plane has no base address".to_string())
    } else {
        let y_stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0);
        let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1);
        // Each plane holds `stride * rows` bytes while locked.
        let y =
            std::slice::from_raw_parts_mut(y_base, y_stride * CVPixelBufferGetHeightOfPlane(pb, 0));
        let uv = std::slice::from_raw_parts_mut(
            uv_base,
            uv_stride * CVPixelBufferGetHeightOfPlane(pb, 1),
        );
        i420_to_nv12(
            data,
            width as usize,
            height as usize,
            y,
            y_stride,
            uv,
            uv_stride,
        )
    };
    CVPixelBufferUnlockBaseAddress(pb, 0);
    result
}

// ── Send handle ──────────────────────────────────────────────────────────────

/// The `Send` surface handle held by the registry and the dispatch layer. Holds
/// no AppKit object; every AppKit operation marshals to the main thread via
/// `run_on_main_thread` (spec §3.5), exactly like the Linux backend.
pub struct MacosVideoSurface {
    id: SurfaceId,
    app: tauri::AppHandle,
    /// Keep-latest slot of a ready-to-enqueue pixel buffer, shared with the
    /// main-thread enqueue.
    slot: Arc<Mutex<Option<CvPixelBufferFrame>>>,
    /// Coalesces wakes to at most one in-flight main-thread hop.
    wake_pending: Arc<AtomicBool>,
    /// The sticky main-thread failure (a display layer stuck in the failed
    /// state). `present()` returns it on every call once set, so the decode
    /// worker's error streak tears the subscription down (spec §3.7).
    error_slot: Arc<Mutex<Option<String>>>,
    /// Pool for wrapping CPU I420 frames, re-created when their size changes.
    pool: Option<Nv12Pool>,
}

impl MacosVideoSurface {
    /// Copy a CPU I420 frame into a pooled `'420v'` `CVPixelBuffer` carrying
    /// its colorimetry (decode worker). Retain balance: the pool hands out the
    /// buffer +1; the returned handle takes its own +1 and ours is released.
    fn wrap_i420(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        colorspace: ColorSpace,
    ) -> Result<CvPixelBufferFrame, String> {
        let expected = PixelFormat::I420.frame_size(width, height);
        if width < 2 || height < 2 || data.len() < expected {
            return Err(format!(
                "a CPU I420 frame of {} bytes cannot be a {width}x{height} frame ({expected} \
                 expected)",
                data.len()
            ));
        }
        let reuse = self
            .pool
            .as_ref()
            .is_some_and(|pool| pool.width == width && pool.height == height);
        if !reuse {
            // Drop the old pool first; its buffers stay alive while in use.
            self.pool = None;
            self.pool = Some(Nv12Pool::new(width, height)?);
        }
        let pool = self
            .pool
            .as_ref()
            .map(|pool| pool.pool)
            .unwrap_or(std::ptr::null_mut());
        unsafe {
            let mut pb: CVPixelBufferRef = std::ptr::null_mut();
            let status = CVPixelBufferPoolCreatePixelBuffer(std::ptr::null(), pool, &mut pb);
            if status != 0 || pb.is_null() {
                return Err(format!(
                    "CVPixelBufferPoolCreatePixelBuffer failed: CVReturn {status}"
                ));
            }
            if let Err(reason) = fill_nv12(pb, data, width, height) {
                CFRelease(pb as CFTypeRef);
                return Err(reason);
            }
            attach_colorimetry(pb, colorspace);
            let frame = CvPixelBufferFrame::retain(pb, width, height, colorspace);
            CFRelease(pb as CFTypeRef);
            Ok(frame)
        }
    }
}

impl VideoSurface for MacosVideoSurface {
    fn new(
        app: &tauri::AppHandle,
        surface_id: SurfaceId,
        fit: SurfaceFit,
        shown: ShownNotifier,
    ) -> Result<Self, String> {
        let id = surface_id.0;
        let error_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let error_slot_main = error_slot.clone();

        // Create the view and layers on the main thread and block for the
        // result (this runs inside `spawn_blocking`, so blocking is fine;
        // matches Linux).
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let created =
                with_autorelease_pool(|| create_surface_on_main(id, fit, shown, error_slot_main));
            let _ = tx.send(created);
        })
        .map_err(|e| format!("run_on_main_thread (surface create) failed: {e}"))?;
        rx.recv()
            .map_err(|e| format!("surface create channel closed: {e}"))??;

        Ok(MacosVideoSurface {
            id: surface_id,
            app: app.clone(),
            slot: Arc::new(Mutex::new(None)),
            wake_pending: Arc::new(AtomicBool::new(false)),
            error_slot,
            pool: None,
        })
    }

    fn update_geometry(&mut self, geometry: SurfaceGeometry) -> Result<(), String> {
        // Fire-and-forget at the display cadence (never block the async worker).
        let id = self.id.0;
        self.app
            .run_on_main_thread(move || {
                with_autorelease_pool(|| update_geometry_on_main(id, geometry))
            })
            .map_err(|e| format!("run_on_main_thread (geometry) failed: {e}"))
    }

    fn present(&mut self, frame: DecodedFrameHandle) -> Result<(), String> {
        if let Some(err) = self
            .error_slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Err(err);
        }

        // VideoToolbox output is enqueued as it is; CPU I420 (libvpx VP9) is
        // copied into a pooled NV12 buffer here on the decode worker, off the
        // main thread. Anything else means a decode route this surface cannot
        // draw: a loud error that counts toward the teardown streak (spec
        // §3.7), never a silent drop.
        let buffer = match frame {
            DecodedFrameHandle::CvPixelBuffer(buffer) => buffer,
            DecodedFrameHandle::CpuI420 {
                data,
                width,
                height,
                colorspace,
            } => self.wrap_i420(&data, width, height, colorspace)?,
            #[allow(unreachable_patterns)]
            other => {
                return Err(format!(
                    "macOS native surface received {other:?}; it draws VideoToolbox \
                     CVPixelBuffers and CPU I420 only"
                ))
            }
        };

        // Keep-latest: replace the pending frame and wake one enqueue.
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(buffer);
        if !self.wake_pending.swap(true, Ordering::SeqCst) {
            let id = self.id.0;
            let wake = self.wake_pending.clone();
            let slot = self.slot.clone();
            let scheduled = self.app.run_on_main_thread(move || {
                wake.store(false, Ordering::SeqCst);
                with_autorelease_pool(|| present_on_main(id, &slot));
            });
            if let Err(err) = scheduled {
                // Nothing will ever clear the flag if the hop never runs.
                self.wake_pending.store(false, Ordering::SeqCst);
                return Err(format!("run_on_main_thread (present) failed: {err}"));
            }
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
            .run_on_main_thread(move || with_autorelease_pool(|| destroy_surface_on_main(id)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_media::native_render::SurfaceAnchor;

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

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    /// What a tile point (0..1, top-left origin) shows of the frame (0..1)
    /// under a layout: the inverse of placing the frame's rectangle.
    fn shown_at(layout: DisplayLayout, tile_w: f64, tile_h: f64, u: f64, v: f64) -> (f64, f64) {
        let left = layout.center_x - layout.width / 2.0;
        let top_from_top = (tile_h - layout.center_y) - layout.height / 2.0;
        let mut fx = (u * tile_w - left) / layout.width;
        if layout.mirrored {
            fx = 1.0 - fx;
        }
        let fy = (v * tile_h - top_from_top) / layout.height;
        (fx, fy)
    }

    fn sample_at(window: UvWindow, u: f64, v: f64) -> (f64, f64) {
        (
            (u - 0.5) * f64::from(window.scale[0]) + f64::from(window.center[0]),
            (v - 0.5) * f64::from(window.scale[1]) + f64::from(window.center[1]),
        )
    }

    #[test]
    fn flip_y_maps_top_left_to_bottom_left() {
        // A 100-tall tile whose top is 50 from the DOM top sits, in a 600-tall
        // container, at AppKit y = 600 - 50 - 100 = 450.
        assert_eq!(flip_y(600.0, 50.0, 100.0), 450.0);
        // A tile flush to the top fills up to the container height.
        assert_eq!(flip_y(600.0, 0.0, 600.0), 0.0);
        // An unreadable container height leaves the top coordinate unflipped.
        assert_eq!(flip_y(0.0, 50.0, 100.0), 50.0);
    }

    #[test]
    fn logical_corner_radius_clamps_to_half_short_side() {
        // 8pt radius at dpr 2: the logical rect is 200x150; 8 < 75, unclamped.
        assert_eq!(logical_corner_radius(&geo(0, 0, 400, 300, 2.0, 8.0)), 8.0);
        // A huge radius clamps to half the shorter logical side (150/2 = 75).
        assert_eq!(
            logical_corner_radius(&geo(0, 0, 400, 300, 2.0, 9999.0)),
            75.0
        );
        // Negative floors to zero.
        assert_eq!(logical_corner_radius(&geo(0, 0, 400, 300, 1.0, -4.0)), 0.0);
    }

    #[test]
    fn the_layout_shows_what_the_linux_shader_samples() {
        let fits = [
            SurfaceFit::Contain,
            SurfaceFit::Cover {
                anchor: SurfaceAnchor::CENTER,
            },
            SurfaceFit::Cover {
                anchor: SurfaceAnchor { x: 0.5, y: 0.35 },
            },
            SurfaceFit::Cover {
                anchor: SurfaceAnchor { x: 0.0, y: 1.0 },
            },
        ];
        let tiles = [(400.0, 200.0), (200.0, 400.0), (320.0, 180.0)];
        let frames = [(1280.0, 720.0), (600.0, 800.0), (640.0, 480.0)];
        for fit in fits {
            for (tw, th) in tiles {
                for (fw, fh) in frames {
                    for mirrored in [false, true] {
                        let mut window = fit.uv_window(tw as f32, th as f32, fw as f32, fh as f32);
                        if mirrored {
                            window = window.mirrored();
                        }
                        let layout = display_layout(window, tw, th);
                        assert_eq!(layout.mirrored, mirrored);
                        for (u, v) in [(0.0, 0.0), (1.0, 1.0), (0.25, 0.8), (0.5, 0.5)] {
                            let (ax, ay) = shown_at(layout, tw, th, u, v);
                            let (ex, ey) = sample_at(window, u, v);
                            assert!(
                                close(ax, ex) && close(ay, ey),
                                "{fit:?} {tw}x{th} tile, {fw}x{fh} frame, mirrored {mirrored}, \
                                 at ({u}, {v}): layer shows ({ax}, {ay}), shader samples ({ex}, {ey})"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_camera_anchor_keeps_the_top_of_a_tall_frame_on_screen() {
        // A 3:4 portrait camera in a 2:1 tile, anchored at y 0.35: the frame is
        // as wide as the tile and 35% of its overflow is off the top.
        let fit = SurfaceFit::Cover {
            anchor: SurfaceAnchor { x: 0.5, y: 0.35 },
        };
        let layout = display_layout(fit.uv_window(400.0, 200.0, 600.0, 800.0), 400.0, 200.0);
        assert!(close(layout.width, 400.0));
        let overflow = layout.height - 200.0;
        // The layer's top edge, in the tile's bottom-left space, past the tile's.
        let top_overhang = layout.center_y + layout.height / 2.0 - 200.0;
        assert!(close(top_overhang, 0.35 * overflow), "{layout:?}");
    }

    #[test]
    fn a_reveal_is_confirmed_once_per_generation_with_a_frame() {
        let mut g = geo(0, 0, 100, 100, 1.0, 0.0);
        g.generation = 3;
        assert!(reveal_due(true, &g, 2));
        assert!(!reveal_due(true, &g, 3), "already confirmed");
        assert!(!reveal_due(false, &g, 2), "no frame on the layer yet");
        g.visible = false;
        assert!(!reveal_due(true, &g, 2), "hidden");
    }
}
