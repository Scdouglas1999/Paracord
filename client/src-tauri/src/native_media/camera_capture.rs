use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::session::NativeMediaSession;
use super::{video_pipeline, MediaState};
use paracord_transport::control::ControlMessage;

const EVENT_EVENT: &str = "native_camera_event";
const CAMERA_CONSENT_TTL: Duration = Duration::from_secs(120);
static CAMERA_CONSENT_AT: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

fn camera_consent_is_fresh() -> bool {
    CAMERA_CONSENT_AT
        .lock()
        .ok()
        .and_then(|value| *value)
        .is_some_and(|granted| granted.elapsed() <= CAMERA_CONSENT_TTL)
}

fn revoke_camera_consent() {
    if let Ok(mut consent) = CAMERA_CONSENT_AT.lock() {
        *consent = None;
    }
}

/// Require OS-native consent before exposing device labels or starting native
/// camera capture. Renderer code cannot answer this prompt.
pub async fn ensure_camera_consent(app: &tauri::AppHandle) -> Result<(), String> {
    if camera_consent_is_fresh() {
        return Ok(());
    }
    if crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("another native permission prompt is already open".into());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(
            "Paracord wants to access your camera device list and may start broadcasting the camera you select.\n\nOnly allow this when you are intentionally enabling video.",
        )
        .title("Allow camera access?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow camera".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |approved| {
            let _ = tx.send(approved);
        });
    let approved = matches!(
        tokio::time::timeout(Duration::from_secs(60), rx).await,
        Ok(Ok(true))
    );
    crate::NATIVE_PRIVILEGE_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
    if !approved {
        return Err("camera access was not approved".into());
    }
    if let Ok(mut consent) = CAMERA_CONSENT_AT.lock() {
        *consent = Some(Instant::now());
    }
    Ok(())
}

/// Default capture target. 1280x720@30 (contract CAM1); a 1080p30 option is
/// selected by the caller via [`StartCameraRequest`].
const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 720;
const DEFAULT_FPS: u32 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    /// Opaque device id passed back to [`start_capture`]. On V4L2 this is the
    /// nokhwa camera index rendered as a string; on other backends it is the
    /// backend's native index/string.
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraEvent {
    pub kind: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StartCameraRequest {
    pub device_id: Option<String>,
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
    /// Encoder bitrate cap in bits per second. Presets (contract CAM2): 720p30 →
    /// 2_500_000, 1080p30 → 4_000_000.
    pub bitrate_bps: u32,
}

impl StartCameraRequest {
    /// Build a request from an optional device id and a quality label
    /// (`"1080p"` → 1080p30 @ 4 Mbps, anything else → 720p30 @ 2.5 Mbps).
    pub fn from_quality(device_id: Option<String>, quality: Option<&str>) -> Self {
        let is_1080 =
            matches!(quality, Some(q) if q.eq_ignore_ascii_case("1080p") || q.contains("1080"));
        if is_1080 {
            Self {
                device_id,
                width: 1920,
                height: 1080,
                frame_rate: DEFAULT_FPS,
                bitrate_bps: 4_000_000,
            }
        } else {
            Self {
                device_id,
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                frame_rate: DEFAULT_FPS,
                bitrate_bps: 2_500_000,
            }
        }
    }
}

pub struct ActiveCameraCapture {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveCameraCapture {
    fn new(stop_flag: Arc<AtomicBool>, worker: JoinHandle<()>) -> Self {
        Self {
            stop_flag,
            worker: Some(worker),
        }
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for ActiveCameraCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One captured camera frame decoded to packed RGBA, handed to the encoder
/// thread through the keep-latest slot (mirror of the screen path's
/// `PendingVideoFrame`).
struct PendingCameraFrame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    capture_time: SystemTime,
}

struct LatestCameraFrame {
    frame: std::sync::Mutex<Option<Arc<PendingCameraFrame>>>,
    notify: std::sync::Condvar,
}

/// Enumerate available capture cameras (contract CAM1: `camera_list_devices`).
pub fn list_devices() -> Result<Vec<CameraDevice>, String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        use nokhwa::query;
        use nokhwa::utils::{ApiBackend, CameraIndex};

        let infos =
            query(ApiBackend::Auto).map_err(|e| format!("camera enumeration failed: {e}"))?;
        Ok(infos
            .into_iter()
            .map(|info| {
                let id = match info.index() {
                    CameraIndex::Index(index) => index.to_string(),
                    CameraIndex::String(value) => value.clone(),
                };
                CameraDevice {
                    id,
                    label: info.human_name(),
                }
            })
            .collect())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Err("native camera capture is not supported on this platform".into())
    }
}

pub async fn start_capture(
    state: &MediaState,
    app: tauri::AppHandle,
    request: StartCameraRequest,
) -> Result<(), String> {
    ensure_camera_consent(&app).await?;
    stop_capture_internal(state, false).await?;

    let session_arc = state.session.clone();
    {
        let guard = session_arc.lock().await;
        guard.as_ref().ok_or("no active session")?;
    }
    let runtime_handle = tokio::runtime::Handle::current();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop = stop_flag.clone();
    let worker_app = app.clone();
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();

    let worker = thread::spawn(move || {
        let run_result = run_capture_loop(
            session_arc,
            runtime_handle,
            worker_app.clone(),
            worker_stop.clone(),
            request,
            startup_tx,
        );

        if let Err(err) = run_result {
            let _ = worker_app.emit(
                EVENT_EVENT,
                CameraEvent {
                    kind: "error".to_string(),
                    message: Some(err),
                },
            );
        }

        let _ = worker_app.emit(
            EVENT_EVENT,
            CameraEvent {
                kind: "ended".to_string(),
                message: None,
            },
        );
    });

    match startup_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {
            let mut guard = state.camera_capture.lock().map_err(|e| e.to_string())?;
            *guard = Some(ActiveCameraCapture::new(stop_flag, worker));
            Ok(())
        }
        Ok(Err(err)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = worker.join();
            teardown_camera_publish(state).await;
            Err(err)
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = worker.join();
            teardown_camera_publish(state).await;
            Err("Timed out while starting native camera capture.".into())
        }
    }
}

pub async fn stop_capture(state: &MediaState) -> Result<(), String> {
    stop_capture_internal(state, true).await
}

async fn stop_capture_internal(state: &MediaState, revoke_consent: bool) -> Result<(), String> {
    if let Ok(mut guard) = state.camera_capture.lock() {
        if let Some(mut active) = guard.take() {
            active.stop();
        }
    }
    teardown_camera_publish(state).await;
    if revoke_consent {
        revoke_camera_consent();
    }
    Ok(())
}

/// Unpublish the camera track and tear the encoder down. Mirror of
/// `screen_capture::stop_capture`'s track-teardown block: the capture worker and
/// encoder teardown are separate concerns.
async fn teardown_camera_publish(state: &MediaState) {
    let mut guard = state.session.lock().await;
    let Some(session) = guard.as_mut() else {
        return;
    };
    if let Some(track) = session.published_video_track.take() {
        video_pipeline::clear_track_sender_key(session, &track).await;
        {
            let mut registry = session.stream_registry.lock().await;
            registry.unpublish_track(&track.stream_id, &track.track_id);
        }
        let _ = session
            .send_control_message(&ControlMessage::TrackUnpublish {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
            })
            .await;
    }
    video_pipeline::stop_camera_share(session);
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn run_capture_loop(
    session_arc: Arc<tokio::sync::Mutex<Option<NativeMediaSession>>>,
    runtime_handle: tokio::runtime::Handle,
    app: tauri::AppHandle,
    stop_flag: Arc<AtomicBool>,
    request: StartCameraRequest,
    startup_tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use nokhwa::pixel_format::RgbAFormat;
    use nokhwa::utils::{
        CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution,
    };
    use nokhwa::Camera;

    let index = match request.device_id.as_deref() {
        Some(value) if !value.trim().is_empty() => match value.trim().parse::<u32>() {
            Ok(n) => CameraIndex::Index(n),
            Err(_) => CameraIndex::String(value.trim().to_string()),
        },
        _ => CameraIndex::Index(0),
    };

    // Negotiate the closest supported format at/below the requested target; the
    // wanted-decoder constraint (RgbAFormat) restricts the source formats to
    // ones nokhwa can decode to packed RGBA (MJPEG / YUYV / NV12 / raw).
    let requested =
        RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Closest(CameraFormat::new(
            Resolution::new(request.width, request.height),
            FrameFormat::MJPEG,
            request.frame_rate.max(1),
        )));

    let mut camera =
        Camera::new(index, requested).map_err(|e| format!("camera open failed: {e}"))?;
    camera
        .open_stream()
        .map_err(|e| format!("camera stream open failed: {e}"))?;

    let negotiated = camera.camera_format();
    let capture_fps = negotiated.frame_rate().max(1);
    let max_frame_rate = request.frame_rate.max(1).min(capture_fps);
    let max_width = Some(request.width);
    let max_height = Some(request.height);
    let max_bitrate_bps = Some(request.bitrate_bps);
    // Seed the encoder configuration from the negotiated capture dimensions.
    {
        let mut guard = runtime_handle.block_on(session_arc.lock());
        let session = guard.as_mut().ok_or("no active session")?;
        video_pipeline::start_camera_share(
            session,
            negotiated.width(),
            negotiated.height(),
            max_frame_rate,
            max_width,
            max_height,
            max_bitrate_bps,
        )?;
    }

    let latest_video_frame = Arc::new(LatestCameraFrame {
        frame: std::sync::Mutex::new(None),
        notify: std::sync::Condvar::new(),
    });
    let encoder_frames = latest_video_frame.clone();
    let encoder_stop = stop_flag.clone();
    let encoder_session = session_arc.clone();
    let encoder_runtime = runtime_handle.clone();
    let encoder_app = app.clone();
    let encoder_startup = Arc::new(std::sync::Mutex::new(Some(startup_tx)));
    let encoder_startup_signal = encoder_startup.clone();
    let encoder_force_keyframe = runtime_handle
        .block_on(async {
            session_arc
                .lock()
                .await
                .as_ref()
                .map(|session| session.video_force_keyframe.clone())
        })
        .ok_or("no active session")?;

    let encoder = thread::spawn(move || -> Result<(), String> {
        // Video encoding is throughput work: run it below normal priority so a
        // saturated encoder cannot starve audio, the UI, or a co-located server
        // (parity with the screen encoder thread).
        #[cfg(unix)]
        unsafe {
            libc::nice(10);
        }
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            };
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }

        let frame_interval =
            Duration::from_millis((1_000u64 / u64::from(max_frame_rate.max(1))).max(1));
        // A webcam is a continuous source, but a keyframe request (late joiner /
        // loss recovery) may arrive between frames; re-encode the retained frame
        // at ~1fps so a request is serviced promptly even if capture briefly
        // stalls.
        let keepalive_interval = Duration::from_secs(1);

        let mut last_encode_at: Option<Instant> = None;
        let mut retained: Option<Arc<PendingCameraFrame>> = None;

        while !encoder_stop.load(Ordering::SeqCst) {
            let fresh = {
                let mut guard = encoder_frames.frame.lock().map_err(|e| e.to_string())?;
                if guard.is_none() && !encoder_stop.load(Ordering::SeqCst) {
                    let (next_guard, _timeout) = encoder_frames
                        .notify
                        .wait_timeout(guard, frame_interval)
                        .map_err(|e| e.to_string())?;
                    guard = next_guard;
                }
                guard.take()
            };

            if encoder_stop.load(Ordering::SeqCst) {
                break;
            }

            let had_fresh = fresh.is_some();
            if let Some(fresh_frame) = fresh {
                retained = Some(fresh_frame);
            }

            let now = Instant::now();
            let elapsed = last_encode_at.map(|t| now.saturating_duration_since(t));
            let paced_due = elapsed.map(|e| e >= frame_interval).unwrap_or(true);
            let keepalive_due = elapsed.map(|e| e >= keepalive_interval).unwrap_or(true);
            let keyframe_requested = encoder_force_keyframe.load(Ordering::SeqCst);

            let should_encode = retained.is_some()
                && if had_fresh {
                    paced_due
                } else {
                    keyframe_requested || keepalive_due
                };

            if !should_encode {
                continue;
            }

            let Some(frame) = retained.clone() else {
                continue;
            };
            let capture_time = frame.capture_time;
            last_encode_at = Some(now);

            // Phase 1 (brief, session lock): move the encoder and everything the
            // encode needs out of the session.
            let begin_result = encoder_runtime.block_on(async {
                let mut guard = encoder_session.lock().await;
                let Some(session) = guard.as_mut() else {
                    return Err("no active session".to_string());
                };
                video_pipeline::begin_camera_frame(
                    session,
                    frame.width,
                    frame.height,
                    false,
                    Some(&encoder_app),
                    capture_time,
                )
                .await
            });

            let encode_result = match begin_result {
                Ok(mut job) => {
                    // Phase 2 (heavy, session lock RELEASED). Enter the runtime so
                    // the self-view native-decode branch can spawn.
                    let run_result = {
                        let _runtime_guard = encoder_runtime.enter();
                        video_pipeline::run_camera_frame(
                            &mut job,
                            &frame.rgba,
                            frame.width,
                            frame.height,
                            false,
                            Some(&encoder_app),
                        )
                    };
                    match run_result {
                        Ok(outcome) => encoder_runtime.block_on(async {
                            let mut guard = encoder_session.lock().await;
                            let Some(session) = guard.as_mut() else {
                                return Err("no active session".to_string());
                            };
                            video_pipeline::finish_camera_frame(session, outcome)
                        }),
                        Err(err) => Err(err),
                    }
                }
                Err(err) => Err(err),
            };

            match encode_result {
                Ok(()) => {
                    if let Some(startup_tx) = encoder_startup_signal
                        .lock()
                        .map_err(|e| e.to_string())?
                        .take()
                    {
                        let _ = startup_tx.send(Ok(()));
                    }
                }
                Err(err) => {
                    video_pipeline::native_diag(
                        Some(&encoder_app),
                        &format!("camera encoder thread stopping on error: {err}"),
                    );
                    if let Some(startup_tx) = encoder_startup_signal
                        .lock()
                        .map_err(|e| e.to_string())?
                        .take()
                    {
                        let _ = startup_tx.send(Err(err.clone()));
                    }
                    // A dead encoder with a live capture loop is a zombie stream;
                    // stop the whole capture.
                    encoder_stop.store(true, Ordering::SeqCst);
                    return Err(err);
                }
            }
        }

        Ok(())
    });

    // Capture loop: nokhwa `frame()` blocks until the next frame (bounded by the
    // capture cadence), so the stop flag is observed within ~one frame interval.
    let result = (|| -> Result<(), String> {
        let mut decode_buf: Vec<u8> = Vec::new();
        while !stop_flag.load(Ordering::SeqCst) {
            let buffer = match camera.frame() {
                Ok(buffer) => buffer,
                Err(err) => return Err(format!("camera frame read failed: {err}")),
            };
            let resolution = buffer.resolution();
            let width = resolution.width();
            let height = resolution.height();
            let rgba_len = (width as usize) * (height as usize) * 4;
            if decode_buf.len() != rgba_len {
                decode_buf.resize(rgba_len, 0);
            }
            buffer
                .decode_image_to_buffer::<RgbAFormat>(&mut decode_buf)
                .map_err(|e| format!("camera frame decode failed: {e}"))?;

            let mut guard = latest_video_frame.frame.lock().map_err(|e| e.to_string())?;
            *guard = Some(Arc::new(PendingCameraFrame {
                width,
                height,
                rgba: decode_buf.clone(),
                capture_time: SystemTime::now(),
            }));
            drop(guard);
            latest_video_frame.notify.notify_one();
        }
        Ok(())
    })();

    if let Err(err) = &result {
        if let Some(startup_tx) = encoder_startup.lock().map_err(|e| e.to_string())?.take() {
            let _ = startup_tx.send(Err(err.clone()));
        }
    }

    stop_flag.store(true, Ordering::SeqCst);
    latest_video_frame.notify.notify_all();
    let _ = camera.stop_stream();
    let encoder_result = encoder
        .join()
        .map_err(|_| "camera encoder thread panicked".to_string())?;
    result.and(encoder_result)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn run_capture_loop(
    _session_arc: Arc<tokio::sync::Mutex<Option<NativeMediaSession>>>,
    _runtime_handle: tokio::runtime::Handle,
    _app: tauri::AppHandle,
    _stop_flag: Arc<AtomicBool>,
    _request: StartCameraRequest,
    _startup_tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    Err("native camera capture is not supported on this platform".into())
}
