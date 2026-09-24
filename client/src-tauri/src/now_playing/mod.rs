//! "Share what I'm listening to": reads what the system's media controls say
//! is playing and hands it to the web layer, which turns it into a
//! "Listening to" presence activity.
//!
//! * Linux — MPRIS on the session bus ([`mpris`]).
//! * Windows — the system media transport controls ([`gsmtc`]).
//! * macOS — there is no public API for another app's now-playing info, and
//!   the private MediaRemote framework is off limits, so the feature reports
//!   itself unavailable there.
//!
//! The web layer starts the reader only while the setting is on
//! (`now_playing_start`) and stops it when the setting goes off
//! (`now_playing_stop`). While it runs, every change arrives as a
//! `now_playing_changed` event carrying a [`model::NowPlaying`] or `null`; a
//! reader that dies emits `now_playing_failed` with the reason. Only the title,
//! artist, player name, status, position and length ever leave this module.

// macOS (and anything else) has no reader, so the shared model goes unused there.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
mod model;

#[cfg(target_os = "linux")]
mod mpris;

#[cfg(windows)]
mod gsmtc;

use std::sync::{Arc, Mutex};

use serde::Serialize;
#[cfg(any(target_os = "linux", windows))]
use tauri::Emitter;

#[cfg_attr(not(any(target_os = "linux", windows)), allow(unused_imports))]
pub use model::NowPlaying;

pub const NOW_PLAYING_CHANGED_EVENT: &str = "now_playing_changed";
pub const NOW_PLAYING_FAILED_EVENT: &str = "now_playing_failed";

/// What a backend reports.
#[derive(Clone, Debug)]
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub enum Update {
    Track(Option<NowPlaying>),
    Failed(String),
}

#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub type Sink = Arc<dyn Fn(Update) + Send + Sync>;

#[derive(Serialize)]
pub struct NowPlayingSupport {
    supported: bool,
    /// Why not, in words the settings page shows as-is.
    reason: Option<&'static str>,
}

#[tauri::command]
pub fn now_playing_support() -> NowPlayingSupport {
    if cfg!(any(target_os = "linux", windows)) {
        NowPlayingSupport {
            supported: true,
            reason: None,
        }
    } else if cfg!(target_os = "macos") {
        NowPlayingSupport {
            supported: false,
            reason: Some("Not available on macOS yet."),
        }
    } else {
        NowPlayingSupport {
            supported: false,
            reason: Some("Not available on this system."),
        }
    }
}

/// The running reader. `generation` lets a reader that dies clear only its own
/// slot, never one a later start put there.
struct Running {
    generation: u64,
    stop: Box<dyn FnOnce() + Send>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn stop_running() {
    let running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(running) = running {
        (running.stop)();
    }
}

#[cfg(any(target_os = "linux", windows))]
fn clear_if_current(generation: u64) {
    let mut slot = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.as_ref().map(|running| running.generation) == Some(generation) {
        *slot = None;
    }
}

#[cfg(any(target_os = "linux", windows))]
fn event_sink(app: tauri::AppHandle, generation: u64) -> Sink {
    Arc::new(move |update| match update {
        Update::Track(track) => {
            if let Err(err) = app.emit(NOW_PLAYING_CHANGED_EVENT, track) {
                tracing::warn!(%err, "now playing: could not deliver an update to the webview");
            }
        }
        Update::Failed(message) => {
            clear_if_current(generation);
            tracing::warn!(%message, "now playing: reader stopped");
            let _ = app.emit(NOW_PLAYING_FAILED_EVENT, message);
        }
    })
}

/// Start reading the system's media controls. Idempotent: a second start
/// while one is running leaves it running. Fails when the platform has no
/// reader or the system service cannot be reached.
#[tauri::command]
pub async fn now_playing_start(app: tauri::AppHandle) -> Result<(), String> {
    if RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
    {
        return Ok(());
    }
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    start_platform(app, generation).await
}

#[cfg(target_os = "linux")]
async fn start_platform(app: tauri::AppHandle, generation: u64) -> Result<(), String> {
    let conn = zbus::Connection::session().await.map_err(|err| {
        format!("Could not reach the desktop's media controls (D-Bus session bus): {err}")
    })?;
    let sink = event_sink(app, generation);
    let task_sink = sink.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = mpris::run(conn, Some(std::process::id()), task_sink.clone()).await;
        let message = match result {
            Ok(()) => "The media controls reader stopped.".to_string(),
            Err(err) => format!("Lost the desktop's media controls: {err}"),
        };
        task_sink(Update::Failed(message));
    });
    install(generation, Box::new(move || task.abort()));
    Ok(())
}

#[cfg(windows)]
async fn start_platform(app: tauri::AppHandle, generation: u64) -> Result<(), String> {
    let sink = event_sink(app, generation);
    let stop = gsmtc::spawn(sink)?;
    install(generation, Box::new(stop));
    Ok(())
}

#[cfg(not(any(target_os = "linux", windows)))]
async fn start_platform(_app: tauri::AppHandle, _generation: u64) -> Result<(), String> {
    Err(now_playing_support()
        .reason
        .unwrap_or("Not available on this system.")
        .to_string())
}

#[cfg(any(target_os = "linux", windows))]
fn install(generation: u64, stop: Box<dyn FnOnce() + Send>) {
    let previous = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .replace(Running { generation, stop });
    // Two starts raced past the idempotency check; keep the newer reader.
    if let Some(previous) = previous {
        (previous.stop)();
    }
}

/// Stop reading. The web layer also stops listening, so an update already in
/// flight when this runs goes nowhere.
#[tauri::command]
pub fn now_playing_stop() {
    stop_running();
}
