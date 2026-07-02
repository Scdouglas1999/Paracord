pub mod audio_pipeline;
pub mod capabilities;
pub mod commands;
pub mod events;
pub mod file_transfer;
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
}

impl MediaState {
    pub fn new() -> Self {
        Self {
            session: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            screen_capture: std::sync::Mutex::new(None),
        }
    }
}
