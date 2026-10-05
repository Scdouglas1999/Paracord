//! Paces the main window by the compositor's frame callbacks (Wayland, GTK 3).
//!
//! ## The problem
//!
//! GTK 3 paces a window's painting with a `GdkFrameClock`. When it paints with
//! cairo into `wl_shm` buffers it commits the buffer itself, asks for a
//! `wl_surface.frame` callback with the commit, freezes the clock and thaws it
//! when the compositor answers. The window then paints at most once per
//! compositor frame, in step with the display, at any refresh rate.
//!
//! When the window paints with GL (WebKit's GPU frames, the video underlay's
//! `GLArea`, and every frame on NVIDIA where `linux_webkit` sets
//! `GDK_GL=always`), the commit happens inside `eglSwapBuffers`, GTK sets a swap
//! interval of 0 and skips its own commit, and with it the frame callback and
//! the freeze (`gdk_window_impl_wayland_end_paint`, `on_frame_clock_after_paint`
//! in `gdkwindow-wayland.c`). The clock then free-runs on its fallback timer:
//! one paint every 16.667 ms, rounded to whole milliseconds, with no relation
//! to the display's refresh. On a 240 Hz monitor every WebKit frame waits for
//! that timer, and WebKit's own compositor waits for the paint
//! (`AcceleratedBackingStore::frameDone`), so even animations that run on
//! WebKit's compositor thread were held near 60 a second and landed on the
//! display's 4.17 ms grid unevenly.
//!
//! ## What this does
//!
//! It gives the GL path the same contract GTK's own `wl_shm` path has:
//!
//! 1. When GTK paints the window (the toplevel's `draw`, on the cairo context
//!    of a real paint of its own `GdkWindow`), it asks for a `wl_surface.frame`
//!    callback. The request rides on the paint's commit (`eglSwapBuffers`).
//! 2. After the paint the window's frame clock is frozen until the compositor
//!    answers (`gdk_window_freeze_toplevel_updates_libgtk_only`, the frame
//!    clock freeze GTK's own code uses for this).
//! 3. The answer thaws the clock as soon as something in the window is waiting
//!    to be painted (the toplevel's invalidate handler sees every redraw that
//!    is queued), so the next WebKit frame is painted the moment it arrives.
//!    With nothing waiting the clock stays frozen until something is, or for
//!    one refresh at most, so layout and resizes never wait longer than that.
//! 4. The frame clock is told the display's refresh interval (it learns it
//!    only from its own frame callbacks, so on the GL path it assumed 60 Hz
//!    and kept 16.667 ms between paint cycles; see `note_refresh_interval`).
//!
//! The window then paints once per compositor frame at the display's rate, and
//! WebKit's compositor (paced by those paints) can deliver a frame per refresh.
//! A window the compositor does not draw (minimized, fully covered) gets no
//! answer and paints nothing until it is drawn again, which is what GTK's
//! `wl_shm` path does too. Hiding the window destroys its surface, so the
//! pending request is dropped and the clock thawed then.
//!
//! On a window GTK paints with `wl_shm` (no GL yet), GTK's own callback and
//! freeze run as well; the two answers arrive together, which changes nothing.
//!
//! ## Frame trace
//!
//! With `PARACORD_FRAME_TRACE=1` each commit of the main window also asks
//! `wp_presentation` when it reached the screen, and prints one line per
//! commit to stderr:
//!
//! ```text
//! [frame] commit=<µs> present=<µs> seq=<vblank> refresh=<ns> flags=<bits>
//! [frame] commit=<µs> discarded
//! [frame] paint=<µs>                     (how long GTK's paint of the window took)
//! [frame] answer=<µs> asked=<µs> frozen=<bool>   (the compositor's frame callback)
//! ```
//!
//! Times are `CLOCK_MONOTONIC` (the clock KWin reports in). `seq` is the
//! display's vblank counter, so the difference between two lines is how many
//! refreshes a frame stayed on screen. `docs/design/desktop-framerate.md`
//! reads these.

use std::cell::Cell;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
use std::sync::OnceLock;

use gtk::glib;
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;

/// The head of GTK 3's `struct _GdkFrameTimings` (`gdkframeclockprivate.h`,
/// unchanged through 3.24), up to the field the pacer writes. `repr(C)` lays
/// it out as the C compiler does, so the offset holds on every target; it is
/// still checked against the public getter on every write.
#[repr(C)]
#[allow(dead_code)] // a layout description: only its offsets are used
struct FrameTimingsHead {
    ref_count: u32,
    frame_counter: i64,
    cookie: u64,
    frame_time: i64,
    smoothed_frame_time: i64,
    drawn_time: i64,
    presentation_time: i64,
    refresh_interval: i64,
}

const TIMINGS_REFRESH_INTERVAL_OFFSET: usize =
    std::mem::offset_of!(FrameTimingsHead, refresh_interval);

/// The environment variable that turns the frame trace on.
pub const TRACE_ENV: &str = "PARACORD_FRAME_TRACE";

// ── libwayland-client, loaded from the copy GTK already uses ────────────────

#[repr(C)]
struct WlMessage {
    name: *const c_char,
    signature: *const c_char,
    types: *const *const WlInterface,
}

#[repr(C)]
struct WlInterface {
    name: *const c_char,
    version: c_int,
    method_count: c_int,
    methods: *const WlMessage,
    event_count: c_int,
    events: *const WlMessage,
}

/// An opaque `wl_proxy`.
type Proxy = c_void;

type MarshalFlags = unsafe extern "C" fn(
    proxy: *mut Proxy,
    opcode: u32,
    interface: *const WlInterface,
    version: u32,
    flags: u32,
    ...
) -> *mut Proxy;
type AddListener =
    unsafe extern "C" fn(proxy: *mut Proxy, listener: *const c_void, data: *mut c_void) -> c_int;
type ProxyDestroy = unsafe extern "C" fn(proxy: *mut Proxy);
type ProxyGetVersion = unsafe extern "C" fn(proxy: *mut Proxy) -> u32;

const WL_SURFACE_FRAME: u32 = 3;
const WL_DISPLAY_GET_REGISTRY: u32 = 1;
const WL_REGISTRY_BIND: u32 = 0;
const WP_PRESENTATION_FEEDBACK: u32 = 1;

struct Wayland {
    _lib: libloading::Library,
    marshal_flags: MarshalFlags,
    add_listener: AddListener,
    destroy: ProxyDestroy,
    get_version: ProxyGetVersion,
    callback_interface: *const WlInterface,
    registry_interface: *const WlInterface,
    /// `wp_presentation` and `wp_presentation_feedback`, which libwayland does
    /// not ship (protocol code is generated per program). Built once, never freed.
    presentation_interface: *const WlInterface,
    feedback_interface: *const WlInterface,
}

// Only ever used on the GTK main thread; the raw pointers are read-only
// protocol descriptions with static lifetime.
unsafe impl Send for Wayland {}
unsafe impl Sync for Wayland {}

static WAYLAND: OnceLock<Result<Wayland, String>> = OnceLock::new();

fn wayland() -> Result<&'static Wayland, String> {
    WAYLAND
        .get_or_init(load_wayland)
        .as_ref()
        .map_err(Clone::clone)
}

fn leak<T>(value: T) -> *const T {
    Box::into_raw(Box::new(value))
}

fn load_wayland() -> Result<Wayland, String> {
    unsafe {
        let lib = libloading::Library::new("libwayland-client.so.0")
            .map_err(|e| format!("libwayland-client.so.0: {e}"))?;
        let marshal_flags = *lib
            .get::<MarshalFlags>(b"wl_proxy_marshal_flags\0")
            .map_err(|e| format!("wl_proxy_marshal_flags: {e}"))?;
        let add_listener = *lib
            .get::<AddListener>(b"wl_proxy_add_listener\0")
            .map_err(|e| format!("wl_proxy_add_listener: {e}"))?;
        let destroy = *lib
            .get::<ProxyDestroy>(b"wl_proxy_destroy\0")
            .map_err(|e| format!("wl_proxy_destroy: {e}"))?;
        let get_version = *lib
            .get::<ProxyGetVersion>(b"wl_proxy_get_version\0")
            .map_err(|e| format!("wl_proxy_get_version: {e}"))?;
        let interface = |name: &[u8]| -> Result<*const WlInterface, String> {
            lib.get::<*const WlInterface>(name)
                .map(|symbol| *symbol)
                .map_err(|e| format!("{}: {e}", String::from_utf8_lossy(name)))
        };
        let callback_interface = interface(b"wl_callback_interface\0")?;
        let registry_interface = interface(b"wl_registry_interface\0")?;
        let surface_interface = interface(b"wl_surface_interface\0")?;
        let output_interface = interface(b"wl_output_interface\0")?;

        // presentation-time.xml, version 1.
        let none: *const *const WlInterface = leak([ptr::null::<WlInterface>(); 7]).cast();
        let feedback_interface = Box::into_raw(Box::new(WlInterface {
            name: c"wp_presentation_feedback".as_ptr(),
            version: 1,
            method_count: 0,
            methods: ptr::null(),
            event_count: 3,
            events: ptr::null(),
        }));
        let feedback_events = leak([
            WlMessage {
                name: c"sync_output".as_ptr(),
                signature: c"o".as_ptr(),
                types: leak([output_interface]).cast(),
            },
            WlMessage {
                name: c"presented".as_ptr(),
                signature: c"uuuuuuu".as_ptr(),
                types: none,
            },
            WlMessage {
                name: c"discarded".as_ptr(),
                signature: c"".as_ptr(),
                types: none,
            },
        ]);
        (*feedback_interface).events = feedback_events.cast();
        let presentation_methods = leak([
            WlMessage {
                name: c"destroy".as_ptr(),
                signature: c"".as_ptr(),
                types: none,
            },
            WlMessage {
                name: c"feedback".as_ptr(),
                signature: c"on".as_ptr(),
                types: leak([surface_interface, feedback_interface.cast_const()]).cast(),
            },
        ]);
        let presentation_events = leak([WlMessage {
            name: c"clock_id".as_ptr(),
            signature: c"u".as_ptr(),
            types: none,
        }]);
        let presentation_interface = leak(WlInterface {
            name: c"wp_presentation".as_ptr(),
            version: 1,
            method_count: 2,
            methods: presentation_methods.cast(),
            event_count: 1,
            events: presentation_events.cast(),
        });

        Ok(Wayland {
            _lib: lib,
            marshal_flags,
            add_listener,
            destroy,
            get_version,
            callback_interface,
            registry_interface,
            presentation_interface,
            feedback_interface,
        })
    }
}

// ── The pacer ────────────────────────────────────────────────────────────────

/// One per main window, leaked: GTK and the compositor hold pointers to it for
/// the life of the process. Main thread only.
struct Pacer {
    window: gdk::Window,
    /// The frame callback in flight, or null.
    callback: Cell<*mut Proxy>,
    /// When it was asked for (`CLOCK_MONOTONIC` µs), for the trace.
    callback_asked: Cell<i64>,
    /// When the paint now running began, for the trace.
    paint_began: Cell<i64>,
    /// The toplevel drew during the paint now running.
    drew: Cell<bool>,
    /// This pacer holds one freeze of the window's frame clock.
    frozen: Cell<bool>,
    /// The refresh interval could not be written into the frame timings.
    timings_unwritable: Cell<bool>,
    /// Something in the window was invalidated since the last paint began.
    invalidated: Cell<bool>,
    /// The compositor has answered but nothing needed painting yet: the
    /// clock stays frozen until something does, or one refresh has passed.
    holding: Cell<Option<glib::SourceId>>,
    /// The display's refresh interval in µs, from the window's monitor.
    refresh_us: Cell<i64>,
    /// `wp_presentation`, bound when the trace is on and the compositor has it.
    presentation: Cell<*mut Proxy>,
    trace: bool,
}

#[repr(C)]
struct CallbackListener {
    done: unsafe extern "C" fn(*mut c_void, *mut Proxy, u32),
}

static CALLBACK_LISTENER: CallbackListener = CallbackListener { done: frame_done };

impl Pacer {
    fn raw_window(&self) -> *mut gdk::ffi::GdkWindow {
        self.window.to_glib_none().0
    }

    fn surface(&self) -> *mut Proxy {
        unsafe { gdk_wayland_sys::gdk_wayland_window_get_wl_surface(self.raw_window().cast()) }
    }

    /// The toplevel draws. On the cairo context of a real paint of its own
    /// window that paint ends in a commit (`eglSwapBuffers`, or GTK's own
    /// `wl_shm` commit), and what is asked for now rides on it. Any other
    /// context (an offscreen render of the widget) commits nothing, so nothing
    /// is asked for.
    fn draw(&self, cr: &gtk::cairo::Context) {
        let painting = unsafe {
            let context = gdk::ffi::gdk_cairo_get_drawing_context(cr.to_raw_none());
            !context.is_null()
                && gdk::ffi::gdk_drawing_context_get_window(context) == self.raw_window()
        };
        if !painting || self.drew.replace(true) {
            return;
        }
        let surface = self.surface();
        if surface.is_null() {
            return;
        }
        let Ok(wl) = wayland() else {
            return;
        };
        unsafe {
            if self.trace {
                self.request_feedback(wl, surface);
            }
            if self.callback.get().is_null() {
                let callback = (wl.marshal_flags)(
                    surface,
                    WL_SURFACE_FRAME,
                    wl.callback_interface,
                    (wl.get_version)(surface),
                    0,
                    ptr::null_mut::<c_void>(),
                );
                if callback.is_null() {
                    return;
                }
                (wl.add_listener)(
                    callback,
                    ptr::from_ref(&CALLBACK_LISTENER).cast(),
                    ptr::from_ref(self).cast_mut().cast(),
                );
                self.callback.set(callback);
                self.callback_asked.set(glib::monotonic_time());
            }
        }
    }

    /// GTK's paint is over. While the compositor has not answered for the
    /// last commit, the window waits for it.
    fn after_paint(&self, clock: &gdk::FrameClock) {
        if self.trace && self.drew.get() {
            let now = glib::monotonic_time();
            eprintln!("[frame] paint={}", now - self.paint_began.get());
        }
        self.drew.set(false);
        self.note_refresh_interval(clock);
        if !self.callback.get().is_null() && !self.frozen.get() {
            self.frozen.set(true);
            // GTK's own name for "freeze this toplevel's frame clock"; the
            // `_libgtk_only` suffix is a deprecation label, not a private symbol.
            unsafe { gdk::ffi::gdk_window_freeze_toplevel_updates_libgtk_only(self.raw_window()) };
        }
    }

    /// Tell the frame clock how long the display's refresh is.
    ///
    /// GTK learns it from its own frame callbacks and presentation feedback,
    /// which the GL path never asks for, so the clock assumes 60 Hz: after any
    /// paint cycle it waits until 16.667 ms after the last one before it will
    /// paint again (`gdk_frame_clock_paint_idle`, `min_next_frame_time`). A
    /// thaw schedules such a cycle (`gdk_window_thaw_toplevel_updates`), so
    /// every WebKit frame that arrived just after the compositor's answer
    /// waited out the rest of a 60 Hz period. With the real refresh in the
    /// frame's timings that wait is at most one refresh.
    ///
    /// `GdkFrameTimings` has getters only; the field is written at its offset
    /// in GTK 3's `struct _GdkFrameTimings` and read back through
    /// `gdk_frame_timings_get_refresh_interval`. A read-back that does not
    /// match puts the old value back and stops trying, loudly.
    fn note_refresh_interval(&self, clock: &gdk::FrameClock) {
        let Some(monitor) = self.window.display().monitor_at_window(&self.window) else {
            return;
        };
        let refresh_mhz = i64::from(monitor.refresh_rate());
        if refresh_mhz <= 0 {
            return;
        }
        let interval_us = 1_000_000_000 / refresh_mhz;
        self.refresh_us.set(interval_us);
        if self.timings_unwritable.get() {
            return;
        }
        unsafe {
            let raw_clock: *mut gdk::ffi::GdkFrameClock = clock.to_glib_none().0;
            let timings = gdk::ffi::gdk_frame_clock_get_current_timings(raw_clock);
            if timings.is_null() {
                return;
            }
            let field = timings
                .cast::<u8>()
                .add(TIMINGS_REFRESH_INTERVAL_OFFSET)
                .cast::<i64>();
            let previous = field.read();
            field.write(interval_us);
            if gdk::ffi::gdk_frame_timings_get_refresh_interval(timings) != interval_us {
                field.write(previous);
                self.timings_unwritable.set(true);
                let line = "[window] frame pacing: GdkFrameTimings.refresh_interval is not where \
                            GTK 3 keeps it; the frame clock keeps its 60 Hz fallback between paints";
                eprintln!("{line}");
                tracing::error!("{line}");
            }
        }
    }

    /// The compositor answered for the last commit. Paint again at once if
    /// something is waiting to be painted. Otherwise stay frozen until
    /// something is invalidated (a WebKit frame usually lands within a few ms):
    /// thawing an idle clock runs an empty paint cycle, and the clock then
    /// holds off its next paint for a refresh after it, so the frame that
    /// arrives a moment later would miss the compositor's next frame. A
    /// refresh later the clock is thawed regardless, so nothing else that
    /// needs it (layout, a resize) waits longer than that.
    fn answered(&'static self) {
        if !self.frozen.get() {
            return;
        }
        if self.invalidated.get() || self.refresh_us.get() <= 0 {
            self.thaw();
            return;
        }
        let wait = std::time::Duration::from_micros(self.refresh_us.get().unsigned_abs());
        let source = glib::timeout_add_local_once(wait, move || {
            // The source is finished once this runs; forget it, then thaw.
            self.holding.set(None);
            self.thaw();
        });
        if let Some(previous) = self.holding.replace(Some(source)) {
            previous.remove();
        }
    }

    /// Cancel a hold. True when there was one.
    fn release_hold(&self) -> bool {
        match self.holding.take() {
            Some(source) => {
                source.remove();
                true
            }
            None => false,
        }
    }

    fn thaw(&self) {
        self.release_hold();
        if self.frozen.replace(false) {
            unsafe { gdk::ffi::gdk_window_thaw_toplevel_updates_libgtk_only(self.raw_window()) };
        }
    }

    /// The window is being hidden, which destroys its surface: the answer will
    /// never come.
    fn drop_callback(&self) {
        let callback = self.callback.replace(ptr::null_mut());
        if !callback.is_null() {
            if let Ok(wl) = wayland() {
                unsafe { (wl.destroy)(callback) };
            }
        }
        self.drew.set(false);
        self.thaw();
    }
}

unsafe extern "C" fn frame_done(data: *mut c_void, callback: *mut Proxy, _time: u32) {
    let pacer = &*(data as *const Pacer);
    if let Ok(wl) = wayland() {
        (wl.destroy)(callback);
    }
    if pacer.callback.get() == callback {
        pacer.callback.set(ptr::null_mut());
        if pacer.trace {
            let now = glib::monotonic_time();
            eprintln!(
                "[frame] answer={now} asked={} frozen={}",
                pacer.callback_asked.get(),
                pacer.frozen.get()
            );
        }
    }
    pacer.answered();
}

/// The toplevel's invalidate handler: GDK calls it for every region queued
/// for redraw anywhere in the window, before it schedules the paint.
unsafe extern "C" fn window_invalidated(
    _window: *mut gdk::ffi::GdkWindow,
    _region: *mut gtk::cairo::ffi::cairo_region_t,
) {
    PACER.with(|pacer| {
        if let Some(pacer) = pacer.get() {
            pacer.invalidated.set(true);
            if pacer.release_hold() {
                pacer.thaw();
            }
        }
    });
}

thread_local! {
    /// The main window's pacer, for the invalidate handler (which carries no
    /// user data). Main thread only.
    static PACER: Cell<Option<&'static Pacer>> = const { Cell::new(None) };
}

// ── Frame trace (PARACORD_FRAME_TRACE) ───────────────────────────────────────

#[repr(C)]
struct RegistryListener {
    global: unsafe extern "C" fn(*mut c_void, *mut Proxy, u32, *const c_char, u32),
    global_remove: unsafe extern "C" fn(*mut c_void, *mut Proxy, u32),
}

static REGISTRY_LISTENER: RegistryListener = RegistryListener {
    global: registry_global,
    global_remove: registry_global_remove,
};

#[repr(C)]
struct PresentationListener {
    clock_id: unsafe extern "C" fn(*mut c_void, *mut Proxy, u32),
}

static PRESENTATION_LISTENER: PresentationListener = PresentationListener {
    clock_id: presentation_clock_id,
};

#[repr(C)]
struct FeedbackListener {
    sync_output: unsafe extern "C" fn(*mut c_void, *mut Proxy, *mut Proxy),
    presented: unsafe extern "C" fn(*mut c_void, *mut Proxy, u32, u32, u32, u32, u32, u32, u32),
    discarded: unsafe extern "C" fn(*mut c_void, *mut Proxy),
}

static FEEDBACK_LISTENER: FeedbackListener = FeedbackListener {
    sync_output: feedback_sync_output,
    presented: feedback_presented,
    discarded: feedback_discarded,
};

impl Pacer {
    fn bind_presentation(&'static self, wl: &Wayland) {
        let display: *mut gdk::ffi::GdkDisplay = self.window.display().to_glib_none().0;
        unsafe {
            let wl_display = gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.cast());
            if wl_display.is_null() {
                return;
            }
            let registry = (wl.marshal_flags)(
                wl_display,
                WL_DISPLAY_GET_REGISTRY,
                wl.registry_interface,
                (wl.get_version)(wl_display),
                0,
                ptr::null_mut::<c_void>(),
            );
            if !registry.is_null() {
                (wl.add_listener)(
                    registry,
                    ptr::from_ref(&REGISTRY_LISTENER).cast(),
                    ptr::from_ref(self).cast_mut().cast(),
                );
            }
        }
    }

    unsafe fn request_feedback(&self, wl: &Wayland, surface: *mut Proxy) {
        let presentation = self.presentation.get();
        if presentation.is_null() {
            return;
        }
        let commit_us = glib::monotonic_time();
        let feedback = (wl.marshal_flags)(
            presentation,
            WP_PRESENTATION_FEEDBACK,
            wl.feedback_interface,
            (wl.get_version)(presentation),
            0,
            surface,
            ptr::null_mut::<c_void>(),
        );
        if !feedback.is_null() {
            (wl.add_listener)(
                feedback,
                ptr::from_ref(&FEEDBACK_LISTENER).cast(),
                Box::into_raw(Box::new(commit_us)).cast(),
            );
        }
    }
}

unsafe extern "C" fn registry_global(
    data: *mut c_void,
    registry: *mut Proxy,
    name: u32,
    interface: *const c_char,
    _version: u32,
) {
    let pacer = &*(data as *const Pacer);
    if CStr::from_ptr(interface).to_bytes() != b"wp_presentation"
        || !pacer.presentation.get().is_null()
    {
        return;
    }
    let Ok(wl) = wayland() else {
        return;
    };
    let presentation = (wl.marshal_flags)(
        registry,
        WL_REGISTRY_BIND,
        wl.presentation_interface,
        1,
        0,
        name,
        (*wl.presentation_interface).name,
        1u32,
        ptr::null_mut::<c_void>(),
    );
    if presentation.is_null() {
        return;
    }
    (wl.add_listener)(
        presentation,
        ptr::from_ref(&PRESENTATION_LISTENER).cast(),
        data,
    );
    pacer.presentation.set(presentation);
    eprintln!("[frame] trace on: wp_presentation bound");
}

unsafe extern "C" fn registry_global_remove(_: *mut c_void, _: *mut Proxy, _: u32) {}

unsafe extern "C" fn presentation_clock_id(_: *mut c_void, _: *mut Proxy, clock: u32) {
    let monotonic = clock == libc::CLOCK_MONOTONIC as u32;
    eprintln!(
        "[frame] presentation clock {clock}{}",
        if monotonic {
            " (CLOCK_MONOTONIC)"
        } else {
            " (not CLOCK_MONOTONIC: commit and present times are not comparable)"
        }
    );
}

unsafe extern "C" fn feedback_sync_output(_: *mut c_void, _: *mut Proxy, _: *mut Proxy) {}

#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn feedback_presented(
    data: *mut c_void,
    feedback: *mut Proxy,
    sec_hi: u32,
    sec_lo: u32,
    nsec: u32,
    refresh: u32,
    seq_hi: u32,
    seq_lo: u32,
    flags: u32,
) {
    let commit_us = *Box::from_raw(data as *mut i64);
    let secs = (u64::from(sec_hi) << 32) | u64::from(sec_lo);
    let present_us = secs * 1_000_000 + u64::from(nsec) / 1_000;
    let seq = (u64::from(seq_hi) << 32) | u64::from(seq_lo);
    eprintln!(
        "[frame] commit={commit_us} present={present_us} seq={seq} refresh={refresh} flags={flags}"
    );
    if let Ok(wl) = wayland() {
        (wl.destroy)(feedback);
    }
}

unsafe extern "C" fn feedback_discarded(data: *mut c_void, feedback: *mut Proxy) {
    let commit_us = *Box::from_raw(data as *mut i64);
    eprintln!("[frame] commit={commit_us} discarded");
    if let Ok(wl) = wayland() {
        (wl.destroy)(feedback);
    }
}

// ── Install ──────────────────────────────────────────────────────────────────

/// Pace `toplevel` by the compositor's frame callbacks. Main thread, once, on
/// the main window. Returns what it did, for the client log; does nothing when
/// GTK is not on Wayland.
pub fn install(toplevel: &gtk::ApplicationWindow) -> Result<String, String> {
    let Some(window) = toplevel.window() else {
        return Err("the main window has no GdkWindow yet".into());
    };
    let is_wayland = unsafe {
        let instance: *mut gdk::ffi::GdkWindow = window.to_glib_none().0;
        glib::gobject_ffi::g_type_check_instance_is_a(
            instance.cast(),
            gdk_wayland_sys::gdk_wayland_window_get_type(),
        ) != 0
    };
    if !is_wayland {
        return Ok("not on Wayland: GTK's own frame clock".into());
    }
    let wl = wayland().map_err(|e| format!("libwayland-client could not be loaded: {e}"))?;
    let Some(clock) = window.frame_clock() else {
        return Err("the main window has no frame clock".into());
    };
    let trace = std::env::var(TRACE_ENV).is_ok_and(|v| !v.is_empty() && v != "0");
    let pacer: &'static Pacer = Box::leak(Box::new(Pacer {
        window,
        callback: Cell::new(ptr::null_mut()),
        callback_asked: Cell::new(0),
        paint_began: Cell::new(0),
        drew: Cell::new(false),
        frozen: Cell::new(false),
        timings_unwritable: Cell::new(false),
        invalidated: Cell::new(false),
        holding: Cell::new(None),
        refresh_us: Cell::new(0),
        presentation: Cell::new(ptr::null_mut()),
        trace,
    }));

    toplevel.connect_draw(move |_, cr| {
        pacer.draw(cr);
        glib::Propagation::Proceed
    });
    clock.connect_before_paint(move |_| {
        pacer.invalidated.set(false);
        if pacer.trace {
            pacer.paint_began.set(glib::monotonic_time());
        }
    });
    clock.connect_after_paint(move |clock| pacer.after_paint(clock));
    PACER.with(|slot| slot.set(Some(pacer)));
    unsafe {
        gdk::ffi::gdk_window_set_invalidate_handler(pacer.raw_window(), Some(window_invalidated));
    }
    toplevel.connect_unmap(move |_| pacer.drop_callback());
    if trace {
        pacer.bind_presentation(wl);
    }
    Ok(format!(
        "paced by the compositor's frame callbacks (Wayland){}",
        if trace { "; frame trace on" } else { "" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_interval_sits_after_a_padded_guint_and_six_gint64s() {
        // gdkframeclockprivate.h on a 64-bit target: ref_count (4 bytes,
        // padded to 8), then frame_counter, cookie, frame_time,
        // smoothed_frame_time, drawn_time, presentation_time.
        #[cfg(target_pointer_width = "64")]
        assert_eq!(TIMINGS_REFRESH_INTERVAL_OFFSET, 56);
        assert_eq!(
            TIMINGS_REFRESH_INTERVAL_OFFSET % std::mem::align_of::<i64>(),
            0
        );
    }

    #[test]
    fn presentation_feedback_request_names_the_surface_before_the_new_object() {
        // presentation-time.xml: feedback(surface: object, callback: new_id).
        // The signature order is what libwayland marshals the varargs by; "no"
        // reads the surface as the new id and fails with EINVAL, which kills
        // the whole Wayland connection.
        let wl = match wayland() {
            Ok(wl) => wl,
            // No libwayland-client on this machine: nothing to check.
            Err(_) => return,
        };
        unsafe {
            let presentation = &*wl.presentation_interface;
            assert_eq!(presentation.method_count, 2);
            let feedback = &*presentation.methods.add(WP_PRESENTATION_FEEDBACK as usize);
            assert_eq!(CStr::from_ptr(feedback.name).to_bytes(), b"feedback");
            assert_eq!(CStr::from_ptr(feedback.signature).to_bytes(), b"on");
            assert_eq!(*feedback.types.add(1), wl.feedback_interface);
            let events = &*wl.feedback_interface;
            assert_eq!(events.event_count, 3);
            let presented = &*events.events.add(1);
            assert_eq!(CStr::from_ptr(presented.signature).to_bytes(), b"uuuuuuu");
        }
    }
}
