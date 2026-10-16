//! How WebKitGTK hands each composited frame to the window on Linux.
//!
//! Decided once, before GTK starts, from the machine and the environment. The
//! decision and its reason are printed at startup and written to the client
//! log (see [`startup_line`]); nothing switches it later.
//!
//! WebKitGTK 2.5x always composites. The web process renders every frame on
//! the GPU and then gives it to this (UI) process in one of two ways:
//!
//! - **GPU (dmabuf).** The frame stays a GPU buffer. GTK draws it into the
//!   window with EGL and hands the window to the compositor as a GPU buffer
//!   too. No pixel is copied by the CPU.
//! - **Shared memory.** The web process reads the frame back into shared
//!   memory, this process paints it into GTK's own shared-memory window buffer,
//!   and the compositor uploads that again. At 5120x1412 that is about 29 MB
//!   three times per frame; measured in a nested KWin on the RTX 4080, motion
//!   presents at about 38 frames a second this way against 59 on the GPU path
//!   (docs/design/desktop-framerate.md).
//!
//! ## NVIDIA on Wayland
//!
//! The GPU path used to kill the window at startup on NVIDIA with
//! `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`.
//! The compositor's reason (`WAYLAND_DEBUG=client`) is
//! `wp_linux_drm_syncobj_surface_v1: explicit sync is used, but no acquire
//! point is set`. NVIDIA's EGL (egl-wayland2) puts the window's surface under
//! explicit sync the first time GTK draws a WebKit frame with EGL; GTK 3 had
//! painted the frames before that with cairo into `wl_shm` buffers, and the
//! next such commit on the same surface carries no acquire point, which is a
//! protocol error. Mesa's EGL does not use explicit sync, so it never hits it.
//!
//! `GDK_GL=always` makes GTK paint every frame of every window with EGL from
//! the first one (GTK 3 reads it at `gtk_init`, `gdk_window_new` creates the
//! paint context), so a surface never mixes the two kinds of buffer and every
//! commit carries its acquire point. With that, the GPU path runs on NVIDIA.
//!
//! The variable is inherited by processes the app starts (a GTK 3 program
//! opened through `xdg-open` paints with GL too, which is a supported GTK
//! mode). It is not removed after `gtk_init` because changing the environment
//! while other threads run is not safe.
//!
//! ## What is still shared memory
//!
//! - NVIDIA when GTK will run on X11 (`GDK_BACKEND=x11`, or no Wayland
//!   display). There the GPU path paints nothing: in a nested Xwayland on the
//!   RTX 4080 (driver 615.71.09, WebKitGTK 2.52.6) the window showed only its
//!   background and `requestAnimationFrame` never fired, while shared memory
//!   painted and ran at 60 frames a second.
//! - NVIDIA with `GDK_GL` set to `disable`: GTK cannot paint with GL, so the
//!   explicit-sync conflict above would return.
//! - Anything set in the environment wins: `WEBKIT_DMABUF_RENDERER_FORCE_SHM`
//!   or `WEBKIT_DISABLE_DMABUF_RENDERER` already present is left alone.
//!
//! Do NOT reach for `hardware-acceleration-policy = Never` either. wry gives no
//! hook to set it before the page exists, and flipping it on a live page makes
//! WebKit tear its compositor down the next time the layer tree changes (the
//! first pressed-state transform is enough). The window then never paints
//! again while both processes sit idle — it looks like a hang on first click.
//!
//! ## Page rendering rate ([`release_page_rendering_rate`])
//!
//! WebKitGTK paces what the page's main thread drives (`requestAnimationFrame`,
//! scrolling, layout) by its display link, and by default it also holds those
//! rendering updates near 60 a second whatever the display's rate
//! (`PreferPageRenderingUpdatesNear60FPS`, on by default in the GTK port). The
//! app turns that preference off on the main webview through WebKit's public
//! `WebKitFeature` API (WebKitGTK 2.42 and later), so page updates follow the
//! display link's rate wherever the display link knows the real refresh.
//!
//! It changes nothing on a machine whose display link is WebKit's fallback
//! timer (NVIDIA, where the DRM vblank monitor cannot be used): that timer
//! ticks about 60 times a second, so the page stays near 60 there
//! (docs/design/index-checkpoints/route-c.md). Idle pages cost nothing extra:
//! the display link stops when no page asks for frames.

use std::sync::OnceLock;

pub const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
pub const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
pub const GDK_GL: &str = "GDK_GL";

/// The transport WebKit will use, and what this process set to get it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BufferTransport {
    /// GPU buffers (WebKit's default). `gdk_gl` is the `GDK_GL` value this
    /// process sets so GTK paints with EGL from the first frame, if any.
    Gpu { gdk_gl: Option<String> },
    /// Shared memory, forced by this process.
    SharedMemory,
    /// The environment already chose; nothing was changed.
    FromEnvironment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub transport: BufferTransport,
    pub reason: String,
}

/// The machine facts the decision reads, gathered once.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub nvidia_egl: bool,
    pub force_shm: Option<String>,
    pub disable_dmabuf: Option<String>,
    pub gdk_gl: Option<String>,
    pub gdk_backend: Option<String>,
    pub wayland_display: Option<String>,
}

impl Inputs {
    fn from_environment() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Inputs {
            nvidia_egl: nvidia_egl_is_active(),
            force_shm: var(FORCE_SHM),
            disable_dmabuf: var(DISABLE_DMABUF),
            gdk_gl: var(GDK_GL),
            gdk_backend: var("GDK_BACKEND"),
            wayland_display: var("WAYLAND_DISPLAY"),
        }
    }

    /// Whether GTK will open a Wayland display. GTK 3 tries Wayland first when
    /// `WAYLAND_DISPLAY` is set, unless `GDK_BACKEND` puts another backend first.
    fn gtk_on_wayland(&self) -> bool {
        let display = self
            .wayland_display
            .as_deref()
            .is_some_and(|d| !d.trim().is_empty());
        let backend_allows = match self.gdk_backend.as_deref().map(str::trim) {
            None | Some("") | Some("*") => true,
            Some(list) => list
                .split(',')
                .map(str::trim)
                .find(|b| !b.is_empty())
                .is_some_and(|first| first == "wayland" || first == "*"),
        };
        display && backend_allows
    }
}

/// Decide the transport. Pure, so every branch is tested.
pub fn decide(inputs: &Inputs) -> Decision {
    if let Some(value) = &inputs.force_shm {
        return Decision {
            transport: BufferTransport::FromEnvironment,
            reason: format!("{FORCE_SHM}={value} is set in the environment"),
        };
    }
    if let Some(value) = &inputs.disable_dmabuf {
        return Decision {
            transport: BufferTransport::FromEnvironment,
            reason: format!("{DISABLE_DMABUF}={value} is set in the environment"),
        };
    }
    if !inputs.nvidia_egl {
        return Decision {
            transport: BufferTransport::Gpu { gdk_gl: None },
            reason: "EGL is not NVIDIA's: WebKit's default GPU transport".into(),
        };
    }
    if !inputs.gtk_on_wayland() {
        return Decision {
            transport: BufferTransport::SharedMemory,
            reason: "NVIDIA EGL and GTK on X11: the GPU transport paints nothing there".into(),
        };
    }
    let gdk_gl = match inputs.gdk_gl.as_deref().map(str::trim) {
        None | Some("") => "always".to_string(),
        Some(flags) => {
            let list: Vec<&str> = flags.split([',', ':', ' ']).map(str::trim).collect();
            if list.iter().any(|f| f.eq_ignore_ascii_case("disable")) {
                return Decision {
                    transport: BufferTransport::SharedMemory,
                    reason: format!(
                        "NVIDIA EGL on Wayland with GDK_GL={flags}: GTK cannot paint with GL, \
                         so a GPU frame would put the window under explicit sync next to \
                         shared-memory commits (protocol error 71)"
                    ),
                };
            }
            if list.iter().any(|f| f.eq_ignore_ascii_case("always")) {
                flags.to_string()
            } else {
                format!("{flags},always")
            }
        }
    };
    Decision {
        reason: format!(
            "NVIDIA EGL on Wayland: GPU transport, GDK_GL={gdk_gl} so GTK paints every \
             frame with EGL (no shared-memory commit on an explicit-sync surface)"
        ),
        transport: BufferTransport::Gpu {
            gdk_gl: Some(gdk_gl),
        },
    }
}

static DECISION: OnceLock<Decision> = OnceLock::new();

/// Decide and apply. WebKit reads its variables when the first web process
/// starts and GTK reads `GDK_GL` in `gtk_init`, so this runs before the Tauri
/// builder, while the process is still single-threaded.
pub fn configure_buffer_transport() {
    let decision = decide(&Inputs::from_environment());
    match &decision.transport {
        BufferTransport::Gpu {
            gdk_gl: Some(flags),
        } => std::env::set_var(GDK_GL, flags),
        BufferTransport::SharedMemory => std::env::set_var(FORCE_SHM, "1"),
        BufferTransport::Gpu { gdk_gl: None } | BufferTransport::FromEnvironment => {}
    }
    eprintln!("{}", line_for(&decision));
    let _ = DECISION.set(decision);
}

fn line_for(decision: &Decision) -> String {
    let transport = match decision.transport {
        BufferTransport::Gpu { .. } => "GPU (dmabuf)",
        BufferTransport::SharedMemory => "shared memory",
        BufferTransport::FromEnvironment => "as the environment says",
    };
    format!(
        "[webkit] frame transport: {transport} ({})",
        decision.reason
    )
}

/// The startup decision as a log line, for the client log once the app exists.
pub fn startup_line() -> Option<String> {
    DECISION.get().map(line_for)
}

/// Whether this machine's active EGL vendor is NVIDIA's proprietary driver.
///
/// libglvnd picks an EGL implementation from the JSON manifests in
/// `/usr/share/glvnd/egl_vendor.d`, honoring `__EGL_VENDOR_LIBRARY_FILENAMES`
/// when it is set. NVIDIA's entry sorts first by convention (`10_nvidia.json`),
/// so on a machine with both it is the one WebKit ends up on.
pub fn nvidia_egl_is_active() -> bool {
    if let Ok(explicit) = std::env::var("__EGL_VENDOR_LIBRARY_FILENAMES") {
        return explicit.to_ascii_lowercase().contains("nvidia");
    }
    // The kernel module's presence is the cheap, reliable signal; the manifest
    // directory confirms the userspace half is installed too.
    let module_loaded = std::path::Path::new("/sys/module/nvidia/version").exists();
    let manifest = std::fs::read_dir("/usr/share/glvnd/egl_vendor.d")
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("nvidia")
            })
        })
        .unwrap_or(false);
    module_loaded && manifest
}

/// WebKit's identifier for the preference that holds page rendering updates
/// near 60 a second (`WebKitFeature`, WebKitGTK 2.42 and later).
pub const NEAR_60_FPS_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPS";

/// The part of WebKit's feature API the page-rate change uses. A trait so the
/// decision is tested without WebKit as well as against it.
pub trait FeatureApi {
    /// WebKitGTK's version, for the log line.
    fn version(&self) -> String;
    /// The identifier of every feature WebKit lists, in WebKit's order, or
    /// why the feature API is missing.
    fn identifiers(&self) -> Result<Vec<String>, String>;
    fn enabled(&self, index: usize) -> bool;
    fn set_enabled(&mut self, index: usize, enabled: bool);
}

/// Turn [`NEAR_60_FPS_FEATURE`] off and read it back. `Ok` says what changed;
/// `Err` says why page rendering stays held near 60 a second.
pub fn turn_off_near_60(api: &mut impl FeatureApi) -> Result<String, String> {
    let version = api.version();
    let identifiers = api
        .identifiers()
        .map_err(|reason| format!("WebKitGTK {version}: {reason}"))?;
    let Some(index) = identifiers.iter().position(|id| id == NEAR_60_FPS_FEATURE) else {
        return Err(format!(
            "WebKitGTK {version} lists no {NEAR_60_FPS_FEATURE} feature (of {})",
            identifiers.len()
        ));
    };
    let was_on = api.enabled(index);
    if was_on {
        api.set_enabled(index, false);
    }
    if api.enabled(index) {
        return Err(format!(
            "WebKitGTK {version} kept {NEAR_60_FPS_FEATURE} on after it was turned off"
        ));
    }
    Ok(format!(
        "{NEAR_60_FPS_FEATURE} off (was {}; WebKitGTK {version}): page rendering follows \
         WebKit's display link",
        if was_on { "on" } else { "already off" }
    ))
}

/// The feature API of the WebKitGTK this process runs, on one `WebKitSettings`.
///
/// The functions are looked up at run time rather than linked: the
/// `webkit2gtk` crate binds WebKitGTK only up to 2.40, and on an older
/// WebKitGTK their absence must be a logged error, not a failure to start.
struct SystemFeatures {
    settings: *mut webkit2gtk::ffi::WebKitSettings,
    list: *mut std::ffi::c_void,
    features: Vec<*mut std::ffi::c_void>,
    api: Option<FeatureFns>,
}

#[derive(Clone, Copy)]
struct FeatureFns {
    get_identifier: unsafe extern "C" fn(*mut std::ffi::c_void) -> *const std::ffi::c_char,
    get_enabled: unsafe extern "C" fn(
        *mut webkit2gtk::ffi::WebKitSettings,
        *mut std::ffi::c_void,
    ) -> glib::ffi::gboolean,
    set_enabled: unsafe extern "C" fn(
        *mut webkit2gtk::ffi::WebKitSettings,
        *mut std::ffi::c_void,
        glib::ffi::gboolean,
    ),
    list_unref: unsafe extern "C" fn(*mut std::ffi::c_void),
}

impl SystemFeatures {
    /// # Safety
    /// `settings` must be a live `WebKitSettings` for as long as this exists.
    unsafe fn load(settings: *mut webkit2gtk::ffi::WebKitSettings) -> Self {
        let mut this = SystemFeatures {
            settings,
            list: std::ptr::null_mut(),
            features: Vec::new(),
            api: None,
        };
        // The process's global symbol scope: libwebkit2gtk-4.1 is linked in.
        let process = libloading::os::unix::Library::this();
        macro_rules! sym {
            ($name:literal, $ty:ty) => {
                match process.get::<$ty>($name) {
                    Ok(symbol) => *symbol,
                    Err(_) => return this,
                }
            };
        }
        let all: unsafe extern "C" fn() -> *mut std::ffi::c_void =
            sym!(b"webkit_settings_get_all_features\0", _);
        let len: unsafe extern "C" fn(*mut std::ffi::c_void) -> usize =
            sym!(b"webkit_feature_list_get_length\0", _);
        let get: unsafe extern "C" fn(*mut std::ffi::c_void, usize) -> *mut std::ffi::c_void =
            sym!(b"webkit_feature_list_get\0", _);
        let fns = FeatureFns {
            get_identifier: sym!(b"webkit_feature_get_identifier\0", _),
            get_enabled: sym!(b"webkit_settings_get_feature_enabled\0", _),
            set_enabled: sym!(b"webkit_settings_set_feature_enabled\0", _),
            list_unref: sym!(b"webkit_feature_list_unref\0", _),
        };
        // (transfer full); released in Drop.
        this.list = all();
        if !this.list.is_null() {
            this.features = (0..len(this.list)).map(|i| get(this.list, i)).collect();
        }
        this.api = Some(fns);
        this
    }
}

impl Drop for SystemFeatures {
    fn drop(&mut self) {
        if let (Some(api), false) = (self.api, self.list.is_null()) {
            unsafe { (api.list_unref)(self.list) };
        }
    }
}

impl FeatureApi for SystemFeatures {
    fn version(&self) -> String {
        use webkit2gtk::ffi::{
            webkit_get_major_version, webkit_get_micro_version, webkit_get_minor_version,
        };
        unsafe {
            format!(
                "{}.{}.{}",
                webkit_get_major_version(),
                webkit_get_minor_version(),
                webkit_get_micro_version()
            )
        }
    }

    fn identifiers(&self) -> Result<Vec<String>, String> {
        let Some(api) = self.api else {
            return Err("no WebKitFeature API (WebKitGTK 2.42 or later is needed)".into());
        };
        if self.list.is_null() {
            return Err("webkit_settings_get_all_features returned nothing".into());
        }
        Ok(self
            .features
            .iter()
            .map(|&feature| {
                let id = unsafe { (api.get_identifier)(feature) };
                if id.is_null() {
                    String::new()
                } else {
                    unsafe { std::ffi::CStr::from_ptr(id) }
                        .to_string_lossy()
                        .into_owned()
                }
            })
            .collect())
    }

    fn enabled(&self, index: usize) -> bool {
        let api = self.api.expect("identifiers() succeeded first");
        unsafe { (api.get_enabled)(self.settings, self.features[index]) != 0 }
    }

    fn set_enabled(&mut self, index: usize, enabled: bool) {
        let api = self.api.expect("identifiers() succeeded first");
        unsafe {
            (api.set_enabled)(
                self.settings,
                self.features[index],
                glib::ffi::gboolean::from(enabled),
            )
        };
    }
}

/// Turn [`NEAR_60_FPS_FEATURE`] off on `view`'s settings (main thread).
pub fn release_page_rendering_rate(view: &webkit2gtk::WebView) -> Result<String, String> {
    use glib::translate::ToGlibPtr;
    use webkit2gtk::WebViewExt;

    let settings = WebViewExt::settings(view).ok_or("the webview has no WebKitSettings")?;
    let raw: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
    // `settings` holds a reference for the whole call.
    let mut api = unsafe { SystemFeatures::load(raw) };
    turn_off_near_60(&mut api)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WebKit stand-in for the decision's branches.
    struct FakeFeatures {
        ids: Result<Vec<String>, String>,
        on: Vec<bool>,
        sticky: bool,
    }

    impl FeatureApi for FakeFeatures {
        fn version(&self) -> String {
            "2.52.6".into()
        }
        fn identifiers(&self) -> Result<Vec<String>, String> {
            self.ids.clone()
        }
        fn enabled(&self, index: usize) -> bool {
            self.on[index]
        }
        fn set_enabled(&mut self, index: usize, enabled: bool) {
            if !self.sticky {
                self.on[index] = enabled;
            }
        }
    }

    fn fake(on: bool) -> FakeFeatures {
        FakeFeatures {
            ids: Ok(vec!["WebGL".into(), NEAR_60_FPS_FEATURE.into()]),
            on: vec![true, on],
            sticky: false,
        }
    }

    #[test]
    fn near_60_is_turned_off_and_reported() {
        let mut api = fake(true);
        let line = turn_off_near_60(&mut api).expect("turned off");
        assert!(!api.on[1], "the feature is off");
        assert!(api.on[0], "no other feature changes");
        assert!(line.contains("was on"), "{line}");
        assert!(line.contains("2.52.6"), "{line}");
    }

    #[test]
    fn near_60_already_off_is_not_an_error() {
        let line = turn_off_near_60(&mut fake(false)).expect("off");
        assert!(line.contains("already off"), "{line}");
    }

    #[test]
    fn missing_feature_api_fails_loudly() {
        let mut api = fake(true);
        api.ids = Err("no WebKitFeature API (WebKitGTK 2.42 or later is needed)".into());
        let err = turn_off_near_60(&mut api).expect_err("an old WebKit is an error");
        assert!(err.contains("2.42"), "{err}");
    }

    #[test]
    fn missing_feature_fails_loudly() {
        let mut api = fake(true);
        api.ids = Ok(vec!["WebGL".into()]);
        let err = turn_off_near_60(&mut api).expect_err("no such feature");
        assert!(err.contains(NEAR_60_FPS_FEATURE), "{err}");
    }

    #[test]
    fn a_setting_that_does_not_stick_fails_loudly() {
        let mut api = fake(true);
        api.sticky = true;
        let err = turn_off_near_60(&mut api).expect_err("still on");
        assert!(err.contains("kept"), "{err}");
    }

    /// Against the WebKitGTK this machine has: the feature exists, starts on
    /// (the GTK port's default) and is off after the change. WebKitGTK 2.52
    /// makes a `WebKitSettings` without a display, but older releases (CI's
    /// Ubuntu) build a GtkStyleContext for it and abort the whole test binary
    /// when there is none, so this runs only where a display exists.
    #[test]
    fn the_system_webkit_turns_near_60_off() {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            eprintln!("skipped: no display, and an older WebKitGTK aborts without one");
            return;
        }
        let settings = unsafe { webkit2gtk::ffi::webkit_settings_new() };
        assert!(!settings.is_null());
        let line = {
            let mut api = unsafe { SystemFeatures::load(settings) };
            let ids = api.identifiers().expect("WebKitFeature API");
            let index = ids
                .iter()
                .position(|id| id == NEAR_60_FPS_FEATURE)
                .expect("the feature is listed");
            assert!(api.enabled(index), "on by default in WebKitGTK");
            let line = turn_off_near_60(&mut api).expect("turned off");
            assert!(!api.enabled(index));
            line
        };
        assert!(line.contains("was on"), "{line}");
        unsafe { glib::gobject_ffi::g_object_unref(settings.cast()) };
    }

    fn nvidia_wayland() -> Inputs {
        Inputs {
            nvidia_egl: true,
            wayland_display: Some("wayland-0".into()),
            ..Inputs::default()
        }
    }

    #[test]
    fn nvidia_on_wayland_takes_the_gpu_path_with_gl_painting() {
        let decision = decide(&nvidia_wayland());
        assert_eq!(
            decision.transport,
            BufferTransport::Gpu {
                gdk_gl: Some("always".into())
            }
        );
    }

    #[test]
    fn existing_gdk_gl_flags_keep_theirs_and_gain_always() {
        let mut inputs = nvidia_wayland();
        inputs.gdk_gl = Some("gles".into());
        assert_eq!(
            decide(&inputs).transport,
            BufferTransport::Gpu {
                gdk_gl: Some("gles,always".into())
            }
        );
        inputs.gdk_gl = Some("always".into());
        assert_eq!(
            decide(&inputs).transport,
            BufferTransport::Gpu {
                gdk_gl: Some("always".into())
            }
        );
    }

    #[test]
    fn gl_disabled_in_gtk_keeps_shared_memory_on_nvidia() {
        let mut inputs = nvidia_wayland();
        inputs.gdk_gl = Some("disable".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::SharedMemory);
    }

    #[test]
    fn nvidia_on_x11_keeps_shared_memory() {
        let mut inputs = nvidia_wayland();
        inputs.gdk_backend = Some("x11".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::SharedMemory);
        inputs.gdk_backend = Some("x11,wayland".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::SharedMemory);
        let no_display = Inputs {
            nvidia_egl: true,
            ..Inputs::default()
        };
        assert_eq!(decide(&no_display).transport, BufferTransport::SharedMemory);
    }

    #[test]
    fn wayland_first_in_gdk_backend_counts_as_wayland() {
        let mut inputs = nvidia_wayland();
        inputs.gdk_backend = Some("wayland,x11".into());
        assert!(matches!(
            decide(&inputs).transport,
            BufferTransport::Gpu { gdk_gl: Some(_) }
        ));
    }

    #[test]
    fn other_vendors_keep_webkits_default() {
        let inputs = Inputs {
            nvidia_egl: false,
            wayland_display: Some("wayland-0".into()),
            ..Inputs::default()
        };
        assert_eq!(
            decide(&inputs).transport,
            BufferTransport::Gpu { gdk_gl: None }
        );
    }

    #[test]
    fn the_environment_wins() {
        let mut inputs = nvidia_wayland();
        inputs.force_shm = Some("1".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::FromEnvironment);
        let mut inputs = nvidia_wayland();
        inputs.force_shm = Some("0".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::FromEnvironment);
        let mut inputs = nvidia_wayland();
        inputs.disable_dmabuf = Some("1".into());
        assert_eq!(decide(&inputs).transport, BufferTransport::FromEnvironment);
    }

    /// An explicit vendor-library override is the strongest statement about
    /// which EGL is in play, so detection reads it before anything else.
    #[test]
    fn nvidia_detection_honors_an_explicit_vendor_library() {
        std::env::set_var(
            "__EGL_VENDOR_LIBRARY_FILENAMES",
            "/usr/share/glvnd/egl_vendor.d/50_mesa.json",
        );
        assert!(
            !nvidia_egl_is_active(),
            "an explicit Mesa vendor is not NVIDIA"
        );
        std::env::set_var(
            "__EGL_VENDOR_LIBRARY_FILENAMES",
            "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
        );
        assert!(
            nvidia_egl_is_active(),
            "an explicit NVIDIA vendor is NVIDIA"
        );
        std::env::remove_var("__EGL_VENDOR_LIBRARY_FILENAMES");
    }
}
