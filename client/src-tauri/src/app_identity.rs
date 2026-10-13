//! One name for the app in every desktop's eyes
//! (`docs/design/index-checkpoints/window-chrome.md`).
//!
//! A taskbar finds a window's icon by the name the window gives itself, so that
//! name, the desktop entry, the icon and the installers' shortcuts must agree.
//! The name is the bundle identifier from `tauri.conf.json`,
//! `com.paracord.desktop` (reverse DNS, as freedesktop and Wayland ask):
//!
//! - **Linux**: the GTK program name, which GTK sends as the Wayland
//!   `xdg_toplevel` app id and as the X11 `WM_CLASS` instance (set before GTK
//!   starts), and the GDK program class, the `WM_CLASS` class (set once GTK has
//!   started, before the first window: [`claim_window_class`]). The desktop entry is
//!   `com.paracord.desktop.desktop`, `Icon=com.paracord.desktop`,
//!   `StartupWMClass=com.paracord.desktop` (`deep_link_desktop`, the packaged
//!   copy in `client/src-tauri/linux/`).
//! - **Windows**: the process's explicit AppUserModelID. The NSIS and MSI
//!   installers stamp the same id on their shortcuts (the Tauri bundler uses
//!   the identifier), and the Inno script names it on its own.
//! - **macOS**: the bundle identifier itself; nothing to set at run time.
//!
//! Without this the GTK program name was the binary's, `paracord-desktop`,
//! which no desktop entry was called, and KDE showed its generic icon.

/// The app's one identity. Equal to `identifier` in `tauri.conf.json` (tested).
pub const APP_ID: &str = "com.paracord.desktop";

/// What people read.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const APP_NAME: &str = "Paracord";

/// Claim the identity for this process. Must run before GTK (or anything else
/// that reads the program name) starts, which is before the Tauri builder.
pub fn claim_process_identity() {
    #[cfg(target_os = "linux")]
    linux::claim();
    #[cfg(windows)]
    windows_aumid::claim();
}

/// Linux, X11: the `WM_CLASS` class. After the Tauri builder has built (GTK
/// is up) and before the app runs (the windows are created when it starts).
#[cfg(target_os = "linux")]
pub fn claim_window_class() {
    linux::claim_window_class();
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{APP_ID, APP_NAME};

    pub fn claim() {
        // The program name is the Wayland app id and the X11 WM_CLASS instance;
        // GTK reads it when it creates the toplevel.
        glib::set_prgname(Some(APP_ID));
        // Without an application name GLib shows the program name where a
        // person reads it (the sound mixer's stream names, for one).
        glib::set_application_name(APP_NAME);
    }

    /// The X11 `WM_CLASS` class. GDK sets it at init from the program name,
    /// capitalized ("Com.paracord.desktop"), whatever was set before, so this
    /// runs after GTK starts and before the first window exists.
    pub fn claim_window_class() {
        gdk::set_program_class(APP_ID);
    }
}

#[cfg(windows)]
mod windows_aumid {
    use super::APP_ID;

    pub fn claim() {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        // SAFETY: a plain Win32 call with a valid, NUL-terminated wide string.
        if let Err(err) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) }
        {
            // The taskbar would then group by executable path instead; say so.
            eprintln!("[window] could not set the AppUserModelID {APP_ID}: {err}");
        }
    }
}

/// The window icon, for X11 (`_NET_WM_ICON`) and anything else that asks the
/// window rather than the desktop entry. Tauri's default is the first PNG in
/// `bundle.icon`, the 32 px one, which an Alt+Tab switcher scales up blurred.
#[cfg(target_os = "linux")]
pub fn set_window_icons(window: &gtk::ApplicationWindow) -> Result<(), String> {
    use gtk::prelude::GtkWindowExt;

    const ICONS: [&[u8]; 5] = [
        include_bytes!("../icons/32x32.png"),
        include_bytes!("../icons/64x64.png"),
        include_bytes!("../icons/128x128.png"),
        include_bytes!("../icons/128x128@2x.png"),
        include_bytes!("../icons/icon.png"),
    ];
    let mut list = Vec::with_capacity(ICONS.len());
    for bytes in ICONS {
        let stream = gtk::gio::MemoryInputStream::from_bytes(&gtk::glib::Bytes::from_static(bytes));
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_stream(&stream, None::<&gtk::gio::Cancellable>)
            .map_err(|err| format!("could not decode a window icon: {err}"))?;
        list.push(pixbuf);
    }
    window.set_icon_list(&list);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_id_is_the_bundle_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["identifier"].as_str(), Some(APP_ID));
    }
}
