//! A desktop notification that makes no sound, for while this app shares a
//! screen with its sound (stream-fix V5).
//!
//! A shared screen's sound is everything the computer plays except this app's
//! own process tree (`pulse_router.rs`, V4). An OS notification's sound is
//! played by the desktop's notification service, outside that tree, so a
//! message notification during a share went out to every viewer in the stream
//! audio. While sharing with sound the client sends its notifications here
//! instead of through the notification plugin; the popup still shows.
//!
//! - **Linux** (freedesktop notifications): the plugin sets no sound hint, so
//!   the notification server plays its default; this sets `suppress-sound`.
//! - **Windows and macOS**: the plugin is already silent there (a Windows toast
//!   without a sound is sent with `<audio silent="true"/>`; a macOS
//!   notification without a sound name plays none), so this goes through it
//!   unchanged.

/// The freedesktop notification this command sends: what the plugin would
/// send (application name, title, body, the app's icon) plus `suppress-sound`.
#[cfg(target_os = "linux")]
fn quiet_linux_notification(title: &str, body: &str) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(title)
        .body(body)
        .auto_icon()
        .hint(notify_rust::Hint::SuppressSound(true));
    notification
}

/// Show a notification without its sound. Fails loudly (the client logs it)
/// rather than falling back to a notification that would make one.
#[tauri::command]
pub async fn notification_show_quiet(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = &app;
        let notification = quiet_linux_notification(&title, &body);
        tauri::async_runtime::spawn_blocking(move || notification.show().map(|_| ()))
            .await
            .map_err(|error| format!("the quiet notification task failed: {error}"))?
            .map_err(|error| format!("could not show a quiet notification: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| format!("could not show a notification: {error}"))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_notification_asks_the_server_for_no_sound() {
        let notification = quiet_linux_notification("Vincent", "hello");
        assert_eq!(notification.summary, "Vincent");
        assert_eq!(notification.body, "hello");
        assert!(notification
            .hints
            .contains(&notify_rust::Hint::SuppressSound(true)));
        // No sound name either: the hint is the whole request.
        assert!(!notification
            .hints
            .iter()
            .any(|hint| matches!(hint, notify_rust::Hint::SoundName(_))));
    }
}
