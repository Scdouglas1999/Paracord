//! The window's own chrome (`docs/design/index-checkpoints/window-chrome.md`).
//!
//! Linux and Windows run without native decorations: the page draws the
//! minimize, maximize and close buttons, marks its drag regions and (Linux) its
//! resize edges (`client/src/lib/windowChrome/`). macOS keeps its native traffic
//! lights, inset into the content (`tauri.macos.conf.json`: `titleBarStyle`
//! Overlay, hidden title).
//!
//! What the shell does for it:
//!
//! - **Linux**: drops the GTK header bar tao installs on Wayland and tells
//!   the compositor not to decorate ([`undecorate`]), so the toplevel is a plain, opaque window: no
//!   client-side decoration, no shadow margin, no RGBA visual (frame pacing,
//!   `docs/design/desktop-framerate.md`). Square corners: rounding them would
//!   need a transparent toplevel and webview (measured in the checkpoint).
//! - **Windows**: asks DWM for rounded corners (Windows 11; the undecorated
//!   window keeps its shadow and resize border through `shadow: true`).
//! - **Everywhere**: a double click on a drag region does what the desktop's
//!   own title bars do ([`window_titlebar_double_click`]).

/// The action a double click on the title bar takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoubleClick {
    ToggleMaximize,
    Minimize,
    Lower,
    Nothing,
}

impl DoubleClick {
    fn as_str(self) -> &'static str {
        match self {
            DoubleClick::ToggleMaximize => "toggle-maximize",
            DoubleClick::Minimize => "minimize",
            DoubleClick::Lower => "lower",
            DoubleClick::Nothing => "nothing",
        }
    }
}

/// GTK's `gtk-titlebar-double-click` (which KDE and GNOME set from their own
/// title bar setting). GTK 3 cannot maximize along one axis, so the
/// horizontal and vertical variants maximize; "menu" needs the click's event to
/// place a window menu, which a page click does not have, so it does nothing.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn gtk_double_click(setting: Option<&str>) -> DoubleClick {
    match setting.unwrap_or("toggle-maximize") {
        "minimize" => DoubleClick::Minimize,
        "lower" => DoubleClick::Lower,
        "none" | "menu" => DoubleClick::Nothing,
        _ => DoubleClick::ToggleMaximize,
    }
}

/// macOS's "Double-click a window's title bar to" (`AppleActionOnDoubleClick`,
/// with the older `AppleMiniaturizeOnDoubleClick`). Zoom, Fill and Maximize all
/// fill the screen here: Tauri's maximize is a zoom to the visible frame.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_double_click(action: Option<&str>, miniaturize: Option<&str>) -> DoubleClick {
    match action.map(str::trim) {
        Some("Minimize") => DoubleClick::Minimize,
        Some("None") | Some("No Action") => DoubleClick::Nothing,
        Some(_) => DoubleClick::ToggleMaximize,
        None if miniaturize.map(str::trim) == Some("1") => DoubleClick::Minimize,
        None => DoubleClick::ToggleMaximize,
    }
}

#[cfg(target_os = "macos")]
fn read_global_default(key: &str) -> Option<String> {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", key])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// What a double click on a drag region does here, read from the desktop's own
/// setting at the moment of the click (it can change while the app runs).
fn double_click_action(window: &tauri::WebviewWindow) -> Result<DoubleClick, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                use gtk::prelude::GtkSettingsExt;
                let setting = gtk::Settings::default()
                    .and_then(|settings| settings.gtk_titlebar_double_click())
                    .map(|value| value.to_string());
                let _ = tx.send(setting);
            })
            .map_err(|e| e.to_string())?;
        let setting = rx.recv().map_err(|e| e.to_string())?;
        Ok(gtk_double_click(setting.as_deref()))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        Ok(macos_double_click(
            read_global_default("AppleActionOnDoubleClick").as_deref(),
            read_global_default("AppleMiniaturizeOnDoubleClick").as_deref(),
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Windows' caption always maximizes and restores.
        let _ = window;
        Ok(DoubleClick::ToggleMaximize)
    }
}

/// A double click on one of the page's drag regions. Returns what it did.
///
/// Async, so it runs off the main thread: the GTK setting is read on the main
/// thread and waited for here.
#[tauri::command]
pub async fn window_titlebar_double_click(
    window: tauri::WebviewWindow,
) -> Result<&'static str, String> {
    let action = double_click_action(&window)?;
    match action {
        DoubleClick::ToggleMaximize => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize().map_err(|e| e.to_string())?;
            } else {
                window.maximize().map_err(|e| e.to_string())?;
            }
        }
        DoubleClick::Minimize => window.minimize().map_err(|e| e.to_string())?,
        DoubleClick::Lower => {
            #[cfg(target_os = "linux")]
            {
                let target = window.clone();
                window
                    .run_on_main_thread(move || {
                        use gtk::prelude::WidgetExt;
                        match target.gtk_window() {
                            Ok(gtk_window) => {
                                if let Some(gdk_window) = gtk_window.window() {
                                    gdk_window.lower();
                                }
                            }
                            Err(err) => eprintln!("[window] could not lower the window: {err}"),
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
        }
        DoubleClick::Nothing => {}
    }
    Ok(action.as_str())
}

/// Make the toplevel a plain, undecorated window.
///
/// tao puts a GTK header bar on every Wayland window, wrapped in an event box
/// that sits above it (its buttons never see a click), and with it GTK runs as
/// a client-side-decorated window (the `csd` style, an RGBA toplevel with
/// shadow margins). Dropping it leaves a plain window, but GTK 3 then tells
/// KWin (`org_kde_kwin_server_decoration`) to draw its own title bar, and KWin
/// does, whatever `decorations: false` said. So once the window exists the
/// mode is announced as client-side: the client draws the chrome (the page
/// does), and with GTK's own decoration off nothing is drawn but the page.
#[cfg(target_os = "linux")]
pub fn undecorate(window: &gtk::ApplicationWindow) {
    use gtk::prelude::{GtkWindowExt, WidgetExt};
    window.set_titlebar(None::<&gtk::Widget>);
    window.set_decorated(false);
    if window.is_realized() {
        announce_client_side(window);
    }
    window.connect_realize(announce_client_side);
}

#[cfg(target_os = "linux")]
fn announce_client_side(window: &gtk::ApplicationWindow) {
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::WidgetExt;
    let Some(gdk_window) = window.window() else {
        return;
    };
    let raw: *mut gdk::ffi::GdkWindow = gdk_window.to_glib_none().0;
    // SAFETY: a live GdkWindow, checked to be a Wayland one before the call.
    unsafe {
        let wayland = glib::gobject_ffi::g_type_check_instance_is_a(
            raw.cast(),
            gdk_wayland_sys::gdk_wayland_window_get_type(),
        ) != 0;
        if wayland {
            gdk_wayland_sys::gdk_wayland_window_announce_csd(raw.cast());
        }
    }
}

/// Windows 11 rounds an undecorated window only on request. Windows 10 has no
/// rounded windows; the call fails there and the corners stay square.
#[cfg(windows)]
pub fn round_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let preference: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND;
    // SAFETY: a valid window handle and a pointer to a value of the attribute's size.
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        )
    }
    .map_err(|e| format!("rounded corners not available (Windows 10?): {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gtk_title_bar_setting_maps_to_an_action() {
        assert_eq!(gtk_double_click(None), DoubleClick::ToggleMaximize);
        assert_eq!(
            gtk_double_click(Some("toggle-maximize")),
            DoubleClick::ToggleMaximize
        );
        assert_eq!(
            gtk_double_click(Some("toggle-maximize-vertically")),
            DoubleClick::ToggleMaximize
        );
        assert_eq!(gtk_double_click(Some("minimize")), DoubleClick::Minimize);
        assert_eq!(gtk_double_click(Some("lower")), DoubleClick::Lower);
        assert_eq!(gtk_double_click(Some("none")), DoubleClick::Nothing);
        assert_eq!(gtk_double_click(Some("menu")), DoubleClick::Nothing);
    }

    #[test]
    fn macos_title_bar_setting_maps_to_an_action() {
        assert_eq!(macos_double_click(None, None), DoubleClick::ToggleMaximize);
        assert_eq!(
            macos_double_click(Some("Maximize"), None),
            DoubleClick::ToggleMaximize
        );
        assert_eq!(
            macos_double_click(Some("Fill"), None),
            DoubleClick::ToggleMaximize
        );
        assert_eq!(
            macos_double_click(Some("Minimize"), None),
            DoubleClick::Minimize
        );
        assert_eq!(macos_double_click(Some("None"), None), DoubleClick::Nothing);
        assert_eq!(macos_double_click(None, Some("1")), DoubleClick::Minimize);
        assert_eq!(
            macos_double_click(Some("Maximize"), Some("1")),
            DoubleClick::ToggleMaximize
        );
    }

    /// Linux and Windows draw their own chrome; macOS keeps the traffic lights
    /// over the content. The macOS window must otherwise be the same window.
    #[test]
    fn the_window_config_is_frameless_and_macos_differs_only_in_its_title_bar() {
        let base: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let mac: serde_json::Value = serde_json::from_str(include_str!("../tauri.macos.conf.json"))
            .expect("tauri.macos.conf.json");
        let base = base["app"]["windows"][0]
            .as_object()
            .expect("a main window")
            .clone();
        let mac = mac["app"]["windows"][0]
            .as_object()
            .expect("a macOS window")
            .clone();
        assert_eq!(base["decorations"], false);
        assert_eq!(base["shadow"], true);
        assert_eq!(
            base.get("transparent"),
            None,
            "the toplevel stays opaque (frame pacing)"
        );
        assert_eq!(mac["decorations"], true);
        assert_eq!(mac["titleBarStyle"], "Overlay");
        assert_eq!(mac["hiddenTitle"], true);
        assert!(mac["trafficLightPosition"].is_object());
        let title_bar = [
            "decorations",
            "shadow",
            "titleBarStyle",
            "hiddenTitle",
            "trafficLightPosition",
        ];
        let strip = |map: &serde_json::Map<String, serde_json::Value>| {
            map.iter()
                .filter(|(key, _)| !title_bar.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        };
        assert_eq!(strip(&base), strip(&mac));
    }

    #[test]
    fn the_page_may_drag_resize_and_drive_the_window() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("capability");
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for wanted in [
            "core:window:allow-start-dragging",
            "core:window:allow-start-resize-dragging",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
        ] {
            assert!(permissions.contains(&wanted), "missing {wanted}");
        }
    }
}
