pub mod audio_actor;
pub mod audio_pipeline;
pub mod camera_capture;
pub mod capabilities;
pub mod commands;
pub mod events;
pub mod file_transfer;
pub mod native_render;
pub mod screen_capture;
pub mod session;
pub mod stream_registry;
pub mod video_pipeline;

pub use session::NativeMediaSession;

/// Shared media state managed by Tauri.
/// Holds the optional active media session behind a tokio Mutex
/// so async command handlers can access it safely.
pub struct MediaState {
    pub session: std::sync::Arc<tokio::sync::Mutex<Option<NativeMediaSession>>>,
    pub screen_capture: std::sync::Mutex<Option<screen_capture::ActiveScreenCapture>>,
    /// Active native camera capture worker (nokhwa), mirroring `screen_capture`.
    pub camera_capture: std::sync::Mutex<Option<camera_capture::ActiveCameraCapture>>,
}

impl MediaState {
    pub fn new() -> Self {
        Self {
            session: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            screen_capture: std::sync::Mutex::new(None),
            camera_capture: std::sync::Mutex::new(None),
        }
    }
}

/// Tear the whole media stack down before the process exits. Hardware
/// encoder/decoder sessions (NVENC/NVDEC) still alive when libc `exit()` runs
/// make libnvcuvid's atexit handler abort the process (the 2026-07-07 SIGABRT
/// coredumps on quit — the multi-second freeze was systemd-coredump writing
/// the core). Order matters:
/// 1. capture teardown JOINS the capture/encode worker, so no encode is
///    in flight afterwards;
/// 2. dropping the session drops its encoders (NVENC freed) and aborts its
///    tasks (`NativeMediaSession::drop`);
/// 3. decode workers + decoder instances are dropped (NVDEC freed).
///
/// Runs on a helper thread bounded by a timeout at the call site, so a wedged
/// component can never hold the quit hostage.
pub fn shutdown_for_exit(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(state) = app.try_state::<MediaState>() else {
        return;
    };
    if let Ok(mut guard) = state.screen_capture.lock() {
        guard.take(); // Drop stops the worker and joins it.
    }
    if let Ok(mut guard) = state.camera_capture.lock() {
        guard.take();
    }
    // blocking_lock is safe here: this runs on a plain helper thread, never on
    // a tokio runtime worker.
    let mut session_guard = state.session.blocking_lock();
    session_guard.take(); // NativeMediaSession::drop aborts tasks + drops encoders.
    drop(session_guard);
    video_pipeline::shutdown_all_decode_state();
}
