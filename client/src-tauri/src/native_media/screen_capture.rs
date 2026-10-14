use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::mpsc::TryRecvError;
use std::sync::Arc;
#[cfg(not(target_os = "linux"))]
use std::sync::{LazyLock, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

// base64 + image are only used by the non-Linux thumbnail encode path below.
#[cfg(not(target_os = "linux"))]
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
#[cfg(not(target_os = "linux"))]
use base64::Engine;
#[cfg(not(target_os = "linux"))]
use image::codecs::jpeg::JpegEncoder;
#[cfg(not(target_os = "linux"))]
use image::ColorType;
#[cfg(not(target_os = "linux"))]
use image::ImageEncoder;
use serde::Serialize;

#[cfg(not(target_os = "linux"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::{session::NativeMediaSession, video_pipeline, MediaState};
use paracord_transport::control::{ControlMessage, TrackKind};
use paracord_transport::stream::PublishedTrack;
#[cfg(feature = "vpx")]
use paracord_transport::stream::VideoCodec as TransportVideoCodec;
use paracord_transport::stream::{PublishedLayer, StreamId, TrackId};

const EVENT_EVENT: &str = "native_screen_share_event";
const SCREEN_AUDIO_SAMPLE_RATE: u32 = 48_000;
const SCREEN_AUDIO_FRAME_SIZE: usize = 960;
#[cfg(not(target_os = "linux"))]
const PICKER_THUMBNAIL_MAX_WIDTH: u32 = 320;
#[cfg(not(target_os = "linux"))]
const PICKER_THUMBNAIL_MAX_HEIGHT: u32 = 180;
#[cfg(not(target_os = "linux"))]
const THUMBNAIL_JPEG_QUALITY: u8 = 74;
#[cfg(not(target_os = "linux"))]
const SCREEN_CAPTURE_CONSENT_TTL: Duration = Duration::from_secs(120);
/// Backstop for a capture backend that neither starts nor errors. A refused or
/// unavailable display answers immediately and never reaches this.
///
/// It is a backstop, so it is generous. Startup is only signaled once the
/// first frame has been ENCODED, which puts encoder initialization inside this
/// window: three NVENC AV1 simulcast layers took 3.4 s to come up on a machine
/// where everything else was healthy, and at 3 s this canceled a share that
/// was 400 ms from working — and told the user to close a picker they had
/// already closed.
const SCREEN_START_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(not(target_os = "linux"))]
static SCREEN_CAPTURE_CONSENT_AT: LazyLock<Mutex<Option<Instant>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(not(target_os = "linux"))]
fn screen_capture_consent_is_fresh() -> bool {
    SCREEN_CAPTURE_CONSENT_AT
        .lock()
        .ok()
        .and_then(|value| *value)
        .is_some_and(|granted| granted.elapsed() <= SCREEN_CAPTURE_CONSENT_TTL)
}

fn revoke_screen_capture_consent() {
    #[cfg(not(target_os = "linux"))]
    if let Ok(mut consent) = SCREEN_CAPTURE_CONSENT_AT.lock() {
        *consent = None;
    }
}

/// On Windows and macOS, native enumeration and thumbnails bypass the browser's
/// capture picker, so gate them with an OS-native confirmation. Linux capture
/// is mediated by the desktop portal and already presents a trusted picker.
pub async fn ensure_screen_capture_consent(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        if screen_capture_consent_is_fresh() {
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
                "Paracord wants to view screen/window names and previews and may broadcast the source you select.\n\nOnly allow this when you are intentionally starting screen sharing.",
            )
            .title("Allow screen sharing access?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow screen sharing".to_string(),
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
            return Err("screen sharing access was not approved".into());
        }
        if let Ok(mut consent) = SCREEN_CAPTURE_CONSENT_AT.lock() {
            *consent = Some(Instant::now());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareSource {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub app_name: Option<String>,
    pub audio_supported: bool,
    pub is_self: bool,
    pub requires_os_picker: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareEvent {
    pub kind: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareThumbnail {
    pub data_url: String,
}

#[derive(Debug, Clone)]
pub struct StartScreenShareRequest {
    pub source_id: Option<String>,
    pub max_frame_rate: u32,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bitrate_bps: Option<u32>,
    pub content_hint: Option<String>,
    pub preferred_codec: Option<String>,
    pub capture_audio: bool,
}

pub struct ActiveScreenCapture {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

pub(crate) struct PendingVideoFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bgra: FramePixels,
    /// True capture time of this frame (scap `display_time`), carried so the
    /// wire PTS can be derived from the actual capture cadence instead of a
    /// synthesized frame_index/fps. See P5 note in the encoder loop below.
    pub(crate) capture_time: SystemTime,
    /// Windows GPU texture route (spec §7, W3): when the negotiated encoder is a
    /// hardware MFT, the frame is a GPU-resident D3D11 texture instead of the
    /// CPU `bgra` readback, and `bgra` is left empty. `None` on the CPU BGRA
    /// route (the VP9 floor) and for every non-Windows platform. The encode loop
    /// selects `encode_texture` when this is `Some` and the plain `encode`
    /// (CPU I420) path otherwise, so a single retained frame re-encodes cleanly
    /// for keyframe/keepalive ticks on either route.
    #[cfg(target_os = "windows")]
    pub(crate) texture: Option<scap::frame::D3D11TextureFrame>,
}

/// A captured frame's pixels: ordinary memory, or (on Linux with an NVIDIA
/// driver) a pinned host buffer the encoder's GPU upload reads by DMA.
pub(crate) enum FramePixels {
    Heap(Vec<u8>),
    #[cfg(all(unix, not(target_os = "macos")))]
    Pinned(paracord_codec::video::lavc::PinnedFrame),
}

impl std::ops::Deref for FramePixels {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            FramePixels::Heap(bytes) => bytes,
            #[cfg(all(unix, not(target_os = "macos")))]
            FramePixels::Pinned(frame) => frame,
        }
    }
}

/// Where captured frames are put for the encoder, chosen once per capture.
enum CaptureMemory {
    Heap,
    #[cfg(all(unix, not(target_os = "macos")))]
    Pinned(paracord_codec::video::lavc::PinnedHostPool),
}

impl CaptureMemory {
    /// Pinned host memory when the CUDA driver is there (the NVENC upload then
    /// is a DMA, about 3 ms for 5120x1440 even on a loaded machine instead of
    /// 9 to 12 through the driver's own staging copy); ordinary memory
    /// otherwise. Said once in the log either way.
    fn choose(app: &super::CallEventSink) -> Self {
        #[cfg(all(unix, not(target_os = "macos")))]
        match paracord_codec::video::lavc::PinnedHostPool::new() {
            Ok(pool) => {
                video_pipeline::native_diag(
                    Some(app),
                    "screen capture frames go to pinned host memory (direct GPU upload)",
                );
                return CaptureMemory::Pinned(pool);
            }
            Err(err) => {
                video_pipeline::native_diag(
                    Some(app),
                    &format!("screen capture frames go to ordinary memory: {err}"),
                );
            }
        }
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        let _ = app;
        CaptureMemory::Heap
    }

    /// Hand `bytes` (a captured frame) to the encoder in this memory. The copy
    /// into a pinned buffer runs here, on the capture thread, so the encode
    /// thread only uploads.
    fn place(&self, bytes: Vec<u8>) -> Result<FramePixels, String> {
        match self {
            CaptureMemory::Heap => Ok(FramePixels::Heap(bytes)),
            #[cfg(all(unix, not(target_os = "macos")))]
            CaptureMemory::Pinned(pool) => {
                let mut frame = pool.take(bytes.len()).map_err(|e| e.to_string())?;
                parallel_copy(&mut frame, &bytes);
                Ok(FramePixels::Pinned(frame))
            }
        }
    }
}

/// Copy a large frame in four parallel chunks: one 29.5 to 33 MB memcpy takes
/// 8 ms or more on a loaded machine, which alone would hold a 60 fps capture
/// under its rate.
#[cfg(all(unix, not(target_os = "macos")))]
fn parallel_copy(dst: &mut [u8], src: &[u8]) {
    const CHUNKS: usize = 4;
    let chunk = src.len().div_ceil(CHUNKS).max(1);
    std::thread::scope(|scope| {
        for (d, s) in dst.chunks_mut(chunk).zip(src.chunks(chunk)) {
            scope.spawn(move || d.copy_from_slice(s));
        }
    });
}

struct LatestVideoFrame {
    frame: std::sync::Mutex<Option<Arc<PendingVideoFrame>>>,
    notify: std::sync::Condvar,
    /// Captured frames replaced in the keep-latest slot before the encoder took
    /// them (the encoder was busy): the pacing report's "lost to encode time".
    overwritten: std::sync::atomic::AtomicU64,
    /// Captured frames the capture thread skipped for a newer one before they
    /// reached the slot (the capture thread fell behind).
    superseded: std::sync::atomic::AtomicU64,
    /// Time spent placing frames in encoder memory (the pinned copy), in µs.
    place_us: std::sync::atomic::AtomicU64,
    placed: std::sync::atomic::AtomicU64,
}

/// Admits captured frames to the encoder on a monotonic schedule of capture
/// timestamps (microseconds): one slot per frame interval, a frame on time when
/// it is no more than a quarter interval before its slot. The next slot is the
/// current slot plus one interval, so the long-run rate never exceeds the
/// target and a source faster than it is thinned evenly (60 Hz at 30 fps takes
/// every other frame); a frame more than an interval late restarts the schedule
/// from itself.
///
/// A source no faster than the target (a 60 Hz screen at 60 fps) is not
/// thinned at all: its frames are on time up to three quarters of an interval
/// early, so capture jitter (a frame delivered late, the next one on time)
/// never costs a frame. The source's rate is a running average of capture
/// intervals.
#[derive(Debug, Default)]
struct FramePacer {
    interval_us: u64,
    next_due_us: Option<u64>,
    last_capture_us: Option<u64>,
    /// Running average of the source's capture interval, in microseconds.
    source_interval_us: Option<u64>,
}

impl FramePacer {
    fn set_fps(&mut self, fps: u32) {
        let interval_us = 1_000_000 / u64::from(fps.max(1));
        if interval_us != self.interval_us {
            self.interval_us = interval_us;
            self.next_due_us = None;
        }
    }

    /// Whether the frame captured at `captured_us` is due; takes its slot if so.
    fn admit(&mut self, captured_us: u64) -> bool {
        let interval = self.interval_us.max(1);
        if let Some(last) = self.last_capture_us {
            let delta = captured_us.saturating_sub(last).min(interval * 4);
            self.source_interval_us = Some(match self.source_interval_us {
                Some(avg) => (avg * 7 + delta) / 8,
                None => delta,
            });
        }
        self.last_capture_us = Some(captured_us);
        let source_not_faster = self
            .source_interval_us
            .is_some_and(|avg| avg * 10 >= interval * 9);
        let early_tolerance = if source_not_faster {
            interval * 3 / 4
        } else {
            interval / 4
        };
        match self.next_due_us {
            None => {
                self.next_due_us = Some(captured_us + interval);
                true
            }
            Some(due) if captured_us + early_tolerance >= due => {
                self.next_due_us = Some(if captured_us >= due + interval {
                    captured_us + interval
                } else {
                    due + interval
                });
                true
            }
            Some(_) => false,
        }
    }

    /// How long to hold a frame captured at `captured_us` that was not yet due
    /// before encoding it anyway: until its slot, plus half an interval for the
    /// source's next frame (which replaces it, being newer) to arrive.
    fn hold_for(&self, captured_us: u64) -> Duration {
        let due = self.next_due_us.unwrap_or(captured_us);
        Duration::from_micros(due.saturating_sub(captured_us) + self.interval_us / 2)
    }

    /// A held frame was encoded in the current slot.
    fn slot_taken(&mut self) {
        if let Some(due) = self.next_due_us {
            self.next_due_us = Some(due + self.interval_us.max(1));
        }
    }
}

fn capture_time_us(at: SystemTime) -> u64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_micros() as u64)
        .unwrap_or(0)
}

/// Frames seen and encoded by the screen encoder, reported every few seconds
/// so a share says what rate it really encodes against its target, and where
/// frames went missing: skipped by a capture thread that fell behind, or
/// replaced in the slot while the encoder was busy.
struct PacingStats {
    since: Instant,
    captured: u64,
    encoded: u64,
    slot: Option<Arc<LatestVideoFrame>>,
    /// (overwritten, superseded, place_us, placed) at the window's start.
    counters_at_start: [u64; 4],
}

impl PacingStats {
    const INTERVAL: Duration = Duration::from_secs(5);

    fn new() -> Self {
        Self {
            since: Instant::now(),
            captured: 0,
            encoded: 0,
            slot: None,
            counters_at_start: [0; 4],
        }
    }

    fn counters(&self) -> [u64; 4] {
        self.slot.as_ref().map_or([0; 4], |slot| {
            [
                slot.overwritten.load(Ordering::Relaxed),
                slot.superseded.load(Ordering::Relaxed),
                slot.place_us.load(Ordering::Relaxed),
                slot.placed.load(Ordering::Relaxed),
            ]
        })
    }

    fn watch(&mut self, slot: Arc<LatestVideoFrame>) {
        self.slot = Some(slot);
        self.counters_at_start = self.counters();
    }

    fn report(&mut self, target_fps: u32) -> Option<String> {
        let elapsed = self.since.elapsed();
        if elapsed < Self::INTERVAL {
            return None;
        }
        let secs = elapsed.as_secs_f64();
        let now = self.counters();
        let [busy, superseded, place_us, placed] =
            std::array::from_fn(|i| now[i].saturating_sub(self.counters_at_start[i]));
        let line = format!(
            "screen pacing: target {target_fps} fps, encoded {:.1} fps; the encoder took {:.1} \
             captured frames/s, and {:.1}/s were replaced while it was busy; the capture thread \
             skipped {:.1}/s and placed frames in {:.2} ms each",
            self.encoded as f64 / secs,
            self.captured as f64 / secs,
            busy as f64 / secs,
            superseded as f64 / secs,
            place_us as f64 / 1000.0 / placed.max(1) as f64,
        );
        self.since = Instant::now();
        self.captured = 0;
        self.encoded = 0;
        self.counters_at_start = now;
        Some(line)
    }
}

impl ActiveScreenCapture {
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

impl Drop for ActiveScreenCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn list_sources() -> Vec<ScreenShareSource> {
    #[cfg(target_os = "linux")]
    {
        return vec![ScreenShareSource {
            id: "linux:portal".to_string(),
            kind: "desktop".to_string(),
            title: "Choose a screen or window".to_string(),
            app_name: Some("Desktop Portal".to_string()),
            audio_supported: true,
            is_self: false,
            requires_os_picker: true,
        }];
    }

    #[cfg(not(target_os = "linux"))]
    {
        return scap::get_all_targets()
            .into_iter()
            .filter_map(|target| source_from_target(&target))
            .collect();
    }
}

pub fn capture_source_thumbnail(source_id: &str) -> Result<Option<ScreenShareThumbnail>, String> {
    #[cfg(target_os = "linux")]
    {
        let _ = source_id;
        return Ok(None);
    }

    #[cfg(not(target_os = "linux"))]
    {
        if !scap::is_supported() {
            return Ok(None);
        }
        if !scap::has_permission() && !scap::request_permission() {
            return Err("Screen capture permission was denied.".into());
        }

        let target = target_from_source_id(source_id)?;
        let options = scap::capturer::Options {
            fps: 1,
            show_cursor: false,
            show_highlight: false,
            target: Some(target),
            crop_area: None,
            output_type: scap::frame::FrameType::BGRAFrame,
            output_resolution: scap::capturer::Resolution::Captured,
            excluded_targets: None,
            captures_audio: false,
            exclude_current_process_audio: false,
            // Thumbnail probe: a one-shot CPU BGRA read, never the encode path.
            prefer_gpu_texture: false,
        };

        let mut capturer =
            scap::capturer::Capturer::build(options).map_err(|e| format!("thumbnail init: {e}"))?;
        capturer.start_capture();
        let thumbnail_deadline = Instant::now() + Duration::from_secs(2);
        let mut result = None;
        while Instant::now() < thumbnail_deadline {
            match capturer.get_next_frame() {
                Ok(scap::frame::Frame::Video(video)) => {
                    result = Some(video);
                    break;
                }
                Ok(scap::frame::Frame::Audio(_)) => continue,
                Err(err) => {
                    capturer.stop_capture();
                    return Err(format!("thumbnail frame read failed: {err}"));
                }
            }
        }
        capturer.stop_capture();

        let Some(video) = result else {
            return Ok(None);
        };
        let Some((width, height, bgra, _capture_time)) = convert_video_frame(video) else {
            return Ok(None);
        };
        let (thumb_width, thumb_height, thumb_data) = resize_bgra(
            &bgra,
            width,
            height,
            PICKER_THUMBNAIL_MAX_WIDTH,
            PICKER_THUMBNAIL_MAX_HEIGHT,
        );
        let data_url = encode_bgra_as_jpeg_data_url(
            &thumb_data,
            thumb_width,
            thumb_height,
            THUMBNAIL_JPEG_QUALITY,
        )?;
        Ok(Some(ScreenShareThumbnail { data_url }))
    }
}

pub async fn start_capture(
    state: &MediaState,
    app: super::CallEventSink,
    request: StartScreenShareRequest,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    ensure_screen_capture_consent(&app).await?;
    state.calls.check_action(app.owner_id(), &stop_flag)?;
    stop_capture_internal(state, false).await?;

    if !scap::is_supported() {
        return Err("Native screen capture is not supported on this platform.".into());
    }
    if !scap::has_permission() && !scap::request_permission() {
        return Err("Screen capture permission was denied.".into());
    }

    state.calls.check_action(app.owner_id(), &stop_flag)?;
    let session_arc = state.session.clone();
    let runtime_handle = tokio::runtime::Handle::current();

    let (screen_audio_tx, screen_audio_enabled) = {
        let mut guard = session_arc.lock().await;
        let session = guard.as_mut().ok_or("no active session")?;

        let capture_options = build_capture_options(
            request.source_id.as_deref(),
            60,
            None,
            None,
            request.capture_audio,
        )?;
        let [capture_width, capture_height] =
            scap::capturer::get_output_frame_size(&capture_options);
        // Linux's portal-backed PipeWire capturer may not know the selected
        // stream dimensions until the first frame arrives. Do not initialize or
        // publish a 0x0 encoder configuration; the capture worker will seed the
        // encoder from the first real frame before signaling startup success.
        if capture_width > 0 && capture_height > 0 {
            video_pipeline::start_screen_share(
                session,
                capture_width,
                capture_height,
                request.max_frame_rate.max(1),
                request.max_width,
                request.max_height,
                request.max_bitrate_bps,
                request.content_hint.as_deref(),
                request.preferred_codec.as_deref(),
            )?;
        }
        if request.capture_audio && integrated_audio_capture() {
            session.screen_audio_enabled.store(true, Ordering::SeqCst);
        } else {
            session.screen_audio_enabled.store(false, Ordering::SeqCst);
        }
        (
            session.screen_audio_tx.clone(),
            session.screen_audio_enabled.clone(),
        )
    };

    let worker_stop = stop_flag.clone();
    let worker_app = app.clone();
    let source_id = request.source_id.clone();
    let max_frame_rate = request.max_frame_rate;
    let max_width = request.max_width;
    let max_height = request.max_height;
    let max_bitrate_bps = request.max_bitrate_bps;
    let content_hint = request.content_hint.clone();
    let preferred_codec = request.preferred_codec.clone();
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
    // Same contract as the camera path: a capture loop that dies before it
    // signals must hand the caller the real reason, not leave it to time out and
    // invent one.
    let startup_failure_tx = startup_tx.clone();

    let worker = thread::spawn(move || {
        let run_result = run_capture_loop(
            session_arc,
            runtime_handle,
            worker_app.clone(),
            worker_stop.clone(),
            source_id,
            max_frame_rate,
            max_width,
            max_height,
            max_bitrate_bps,
            content_hint,
            preferred_codec,
            request.capture_audio,
            screen_audio_tx,
            screen_audio_enabled,
            startup_tx,
        );

        if let Err(err) = run_result {
            // Ignored once startup already succeeded (the receiver is gone).
            let _ = startup_failure_tx.send(Err(err.clone()));
            let _ = worker_app.emit(
                EVENT_EVENT,
                ScreenShareEvent {
                    kind: "error".to_string(),
                    message: Some(err),
                },
            );
        }

        let _ = worker_app.emit(
            EVENT_EVENT,
            ScreenShareEvent {
                kind: "ended".to_string(),
                message: None,
            },
        );
    });

    // Waiting on an OS thread, not on the async executor: a display server that
    // takes its time answering must never stall every other media command.
    let startup =
        tokio::task::spawn_blocking(move || startup_rx.recv_timeout(SCREEN_START_TIMEOUT))
            .await
            .map_err(|err| format!("screen capture startup wait failed: {err}"))?;

    match startup {
        Ok(Ok(())) => {
            if let Err(error) = state.calls.check_action(app.owner_id(), &stop_flag) {
                stop_flag.store(true, Ordering::SeqCst);
                join_worker(worker).await;
                return Err(error);
            }
            let track_already_published = {
                let guard = state.session.lock().await;
                guard
                    .as_ref()
                    .is_some_and(|session| session.published_screen_track.is_some())
            };
            if !track_already_published {
                if let Err(err) = announce_screen_track(state, &app).await {
                    stop_flag.store(true, Ordering::SeqCst);
                    join_worker(worker).await;
                    let mut guard = state.session.lock().await;
                    if let Some(session) = guard.as_mut() {
                        video_pipeline::stop_screen_share(session);
                        session.screen_audio_enabled.store(false, Ordering::SeqCst);
                        session.published_screen_track = None;
                    }
                    return Err(err);
                }
            }
            let mut guard = state.screen_capture.lock().map_err(|e| e.to_string())?;
            *guard = Some(ActiveScreenCapture::new(stop_flag, worker));
            Ok(())
        }
        Ok(Err(err)) => {
            stop_flag.store(true, Ordering::SeqCst);
            join_worker(worker).await;
            abandon_screen_publish(state).await;
            Err(err)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            stop_flag.store(true, Ordering::SeqCst);
            join_worker(worker).await;
            abandon_screen_publish(state).await;
            Err("Native screen capture stopped before it reported a result.".into())
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            stop_flag.store(true, Ordering::SeqCst);
            join_worker(worker).await;
            abandon_screen_publish(state).await;
            Err(format!(
                "The screen did not start capturing within {}s. Try sharing again.",
                SCREEN_START_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Join a capture worker without parking an async executor thread.
async fn join_worker(worker: thread::JoinHandle<()>) {
    let _ = tokio::task::spawn_blocking(move || worker.join()).await;
}

/// Roll the session back after a screen capture that never started.
async fn abandon_screen_publish(state: &MediaState) {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        video_pipeline::stop_screen_share(session);
        session.screen_audio_enabled.store(false, Ordering::SeqCst);
        session.published_screen_track = None;
    }
}

pub async fn stop_capture(state: &MediaState) -> Result<(), String> {
    stop_capture_internal(state, true).await
}

async fn stop_capture_internal(state: &MediaState, revoke_consent: bool) -> Result<(), String> {
    // Both of these join capture threads; neither belongs on an async executor
    // worker, where a slow teardown would stall every other media command.
    let active = state
        .screen_capture
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    tokio::task::spawn_blocking(move || {
        crate::audio_capture::stop_system_audio_capture()?;
        crate::audio_capture::set_system_audio_capture_enabled(false);
        if let Some(mut active) = active {
            active.stop();
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("screen capture teardown failed: {err}"))??;

    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        if let Some(track) = session.published_screen_track.take() {
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
        if let Some(track) = session.published_screen_audio_track.take() {
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
        video_pipeline::stop_screen_share(session);
        session.screen_audio_enabled.store(false, Ordering::SeqCst);
    }
    if revoke_consent {
        revoke_screen_capture_consent();
    }
    Ok(())
}

async fn announce_screen_track(
    state: &MediaState,
    app: &super::CallEventSink,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    let track = build_screen_track(session)?;
    video_pipeline::ensure_track_sender_key(session, &track).await?;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.publish_track(track.clone());
    }
    session
        .send_control_message(&ControlMessage::TrackPublish {
            track: track.clone(),
        })
        .await?;
    session.published_screen_track = Some(track.clone());
    let _ = app.emit("media_track_publish", track);
    drop(guard);

    if state
        .session
        .lock()
        .await
        .as_ref()
        .is_some_and(|session| session.screen_audio_enabled.load(Ordering::SeqCst))
    {
        announce_screen_audio_track_public(state, app).await?;
    }
    Ok(())
}

pub(crate) fn build_screen_audio_track(session: &NativeMediaSession) -> PublishedTrack {
    PublishedTrack {
        stream_id: StreamId::new(format!("stream:{}:screen", session.session_id)),
        track_id: TrackId::new("screen-audio"),
        publisher_user_id: session.local_user_id,
        kind: TrackKind::Audio,
        codec: None,
        layers: vec![PublishedLayer {
            layer_id: 0,
            ssrc: session.screen_audio_ssrc,
            width: None,
            height: None,
            max_bitrate_kbps: Some(192),
            active: true,
        }],
    }
}

pub async fn announce_screen_audio_track_public(
    state: &MediaState,
    app: &super::CallEventSink,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    let track = build_screen_audio_track(session);
    video_pipeline::ensure_track_sender_key(session, &track).await?;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.publish_track(track.clone());
    }
    session
        .send_control_message(&ControlMessage::TrackPublish {
            track: track.clone(),
        })
        .await?;
    session.published_screen_audio_track = Some(track.clone());
    let _ = app.emit("media_track_publish", track);
    Ok(())
}

#[cfg(feature = "vpx")]
pub(crate) fn build_screen_track(session: &NativeMediaSession) -> Result<PublishedTrack, String> {
    let config = session
        .screen_encoder_config
        .as_ref()
        .ok_or("screen encoder config missing while publishing track")?;
    let codec = session.screen_encoder_codec.map(codec_to_transport_codec);
    let layers = if let Some(simulcast) = session.screen_simulcast.as_ref() {
        let active_layer_id = simulcast
            .layers
            .last()
            .map(|(layer, _)| *layer as u8)
            .unwrap_or(0);
        simulcast
            .layers
            .iter()
            .map(|(layer, layer_config)| {
                let layer_id = *layer as u8;
                let width = u16::try_from(layer_config.width)
                    .map_err(|_| format!("screen track width too large: {}", layer_config.width))?;
                let height = u16::try_from(layer_config.height).map_err(|_| {
                    format!("screen track height too large: {}", layer_config.height)
                })?;
                let ssrc = simulcast
                    .ssrcs
                    .iter()
                    .find_map(|(mapped_layer_id, ssrc)| {
                        (*mapped_layer_id == layer_id).then_some(*ssrc)
                    })
                    .unwrap_or(session.screen_ssrc);
                Ok(PublishedLayer {
                    layer_id,
                    ssrc,
                    width: Some(width),
                    height: Some(height),
                    max_bitrate_kbps: Some(layer_config.bitrate_kbps),
                    active: layer_id == active_layer_id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        let width = u16::try_from(config.width)
            .map_err(|_| format!("screen track width too large: {}", config.width))?;
        let height = u16::try_from(config.height)
            .map_err(|_| format!("screen track height too large: {}", config.height))?;
        vec![PublishedLayer {
            layer_id: 0,
            ssrc: session.screen_ssrc,
            width: Some(width),
            height: Some(height),
            max_bitrate_kbps: Some(config.bitrate_kbps),
            active: true,
        }]
    };
    Ok(PublishedTrack {
        stream_id: StreamId::new(format!("stream:{}:screen", session.session_id)),
        track_id: TrackId::new("screen"),
        publisher_user_id: session.local_user_id,
        kind: TrackKind::Video,
        codec,
        layers,
    })
}

#[cfg(not(feature = "vpx"))]
pub(crate) fn build_screen_track(_session: &NativeMediaSession) -> Result<PublishedTrack, String> {
    Err("screen video publishing requires the vpx feature".to_string())
}

#[cfg(feature = "vpx")]
fn codec_to_transport_codec(codec: paracord_codec::video::VideoCodec) -> TransportVideoCodec {
    match codec {
        paracord_codec::video::VideoCodec::Vp9 => TransportVideoCodec::Vp9,
        paracord_codec::video::VideoCodec::Av1 => TransportVideoCodec::Av1,
        paracord_codec::video::VideoCodec::H264 => TransportVideoCodec::H264,
    }
}

fn run_capture_loop(
    session_arc: Arc<tokio::sync::Mutex<Option<NativeMediaSession>>>,
    runtime_handle: tokio::runtime::Handle,
    app: super::CallEventSink,
    stop_flag: Arc<AtomicBool>,
    source_id: Option<String>,
    max_frame_rate: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
    max_bitrate_bps: Option<u32>,
    content_hint: Option<String>,
    preferred_codec: Option<String>,
    capture_audio: bool,
    screen_audio_tx: tokio::sync::mpsc::Sender<super::av_sync::ScreenAudioFrame>,
    screen_audio_enabled: Arc<AtomicBool>,
    startup_tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let options = build_capture_options(
        source_id.as_deref(),
        60, // Retain source cadence and size so quality can change without a new picker.
        None,
        None,
        capture_audio,
    )?;
    let mut capturer =
        scap::capturer::Capturer::build(options).map_err(|e| format!("capture init: {e}"))?;
    capturer.start_capture();

    let latest_video_frame = Arc::new(LatestVideoFrame {
        frame: std::sync::Mutex::new(None),
        notify: std::sync::Condvar::new(),
        overwritten: std::sync::atomic::AtomicU64::new(0),
        superseded: std::sync::atomic::AtomicU64::new(0),
        place_us: std::sync::atomic::AtomicU64::new(0),
        placed: std::sync::atomic::AtomicU64::new(0),
    });
    let encoder_frames = latest_video_frame.clone();
    let encoder_stop = stop_flag.clone();
    let encoder_session = session_arc.clone();
    let encoder_runtime = runtime_handle.clone();
    let encoder_app = app.clone();
    let encoder_startup = Arc::new(std::sync::Mutex::new(Some(startup_tx)));
    let encoder_startup_signal = encoder_startup.clone();
    // Clone the force-keyframe flag so the encoder loop can serve keyframe
    // requests (and the static-screen keepalive) by re-encoding the retained
    // frame, without taking the session lock every iteration. The Arc is created
    // once at session construction and only ever `store`d into, so this clone
    // stays valid across encoder reinits.
    let (encoder_force_keyframe, encoder_fps) = runtime_handle
        .block_on(async {
            session_arc.lock().await.as_ref().map(|session| {
                (
                    session.screen_force_keyframe.clone(),
                    session.screen_encode_fps.clone(),
                )
            })
        })
        .ok_or("no active session")?;
    let encoder = thread::spawn(move || -> Result<(), String> {
        // Video encoding is throughput work: run it below normal priority so
        // a saturated encoder cannot starve audio, the UI, or a co-located
        // server into QUIC idle timeouts. libvpx worker threads are spawned
        // from this thread and inherit the priority.
        #[cfg(unix)]
        unsafe {
            libc::nice(10);
        }
        // Windows parity with the Unix nice(10) above. Compile-unverified on the
        // Linux toolchain used here; flagged in the change report.
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            };
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }

        // Frame pacing (stream audit B2). Capture can run above the requested
        // rate (a 60 Hz screen for a 30 fps preset, compositor bursts), so the
        // encoder admits frames on a monotonic schedule of capture timestamps
        // (`FramePacer`): a frame is encoded when its capture time reaches the
        // next due slot (a quarter interval early is on time), and the slot
        // then advances by one interval from the slot, not from the frame. A
        // frame that comes in early is held only until its slot (plus a grace
        // for the source's next frame), never a whole interval: the old
        // sleep-then-drop gate turned a 60 Hz source into 25 fps at 30 and
        // 43 fps at 60.
        //
        // Static-screen keepalive: a damage-driven source stops producing frames
        // when nothing changes. Re-encode the retained frame at ~1fps so the
        // periodic-keyframe cadence keeps advancing and a late joiner's keyframe
        // request is serviced within ~1s even on a frozen screen.
        let keepalive_interval = Duration::from_secs(1);

        let mut pacer = FramePacer::default();
        let mut last_encode_at: Option<Instant> = None;
        // Retain the most recent captured frame (cheap Arc clone) so it can be
        // re-encoded for a keyframe request or the keepalive tick when capture
        // has gone quiet.
        let mut retained: Option<Arc<PendingVideoFrame>> = None;
        // A fresh frame that arrived before its slot: when to encode it if no
        // newer frame replaces it first (so the newest content never waits
        // for the ~1s keepalive when capture goes idle).
        let mut held_until: Option<Instant> = None;
        let mut pacing_stats = PacingStats::new();
        pacing_stats.watch(encoder_frames.clone());

        while !encoder_stop.load(Ordering::SeqCst) {
            let fps = encoder_fps.load(Ordering::Relaxed).max(1);
            pacer.set_fps(fps);
            let frame_interval = Duration::from_micros(1_000_000 / u64::from(fps));
            // Block until a fresh frame arrives, the held frame's slot, or one
            // frame interval (so keyframe/keepalive checks still run on a
            // static screen).
            let wait = held_until
                .map(|until| until.saturating_duration_since(Instant::now()))
                .unwrap_or(frame_interval)
                .min(frame_interval);
            let fresh = {
                let mut guard = encoder_frames.frame.lock().map_err(|e| e.to_string())?;
                if guard.is_none() && !encoder_stop.load(Ordering::SeqCst) && !wait.is_zero() {
                    let (next_guard, _timeout) = encoder_frames
                        .notify
                        .wait_timeout(guard, wait)
                        .map_err(|e| e.to_string())?;
                    guard = next_guard;
                }
                guard.take()
            };

            if encoder_stop.load(Ordering::SeqCst) {
                break;
            }

            let now = Instant::now();
            let keyframe_requested = encoder_force_keyframe.load(Ordering::SeqCst);
            let keepalive_due = last_encode_at
                .map(|t| now.saturating_duration_since(t) >= keepalive_interval)
                .unwrap_or(true);

            // Encode this iteration when:
            //  * a fresh frame reached its slot, OR
            //  * a held frame's slot (plus grace) passed with no newer frame, OR
            //  * capture is quiet but a keyframe was requested (late joiner), OR
            //    the keepalive tick is due (static-screen keepalive, P2).
            let should_encode = if let Some(fresh_frame) = fresh {
                let captured_us = capture_time_us(fresh_frame.capture_time);
                retained = Some(fresh_frame);
                pacing_stats.captured += 1;
                if pacer.admit(captured_us) {
                    held_until = None;
                    true
                } else {
                    held_until = Some(now + pacer.hold_for(captured_us));
                    false
                }
            } else if held_until.is_some_and(|until| now >= until) {
                held_until = None;
                pacer.slot_taken();
                true
            } else {
                retained.is_some() && (keyframe_requested || keepalive_due)
            };

            if !should_encode {
                continue;
            }

            let Some(frame) = retained.clone() else {
                continue;
            };
            // P5/L2: the frame's true capture time drives the wire PTS. It is
            // threaded through `begin_screen_frame` into the frame's
            // `timestamp_us` (monotonic per track) instead of a synthesized
            // frame_index/fps.
            let capture_time = frame.capture_time;
            last_encode_at = Some(now);
            pacing_stats.encoded += 1;
            if let Some(line) = pacing_stats.report(fps) {
                video_pipeline::native_diag(Some(&encoder_app), &line);
            }

            // Phase 1 (brief, under the session lock): seed the encoder config
            // on the first frame, then run `begin_screen_frame`, which moves the
            // encoder and everything the encode needs out of the session.
            let begin_result = encoder_runtime.block_on(async {
                let mut guard = encoder_session.lock().await;
                let Some(session) = guard.as_mut() else {
                    return Err("no active session".to_string());
                };
                #[cfg(feature = "vpx")]
                if session.screen_encoder_config.is_none() {
                    video_pipeline::start_screen_share(
                        session,
                        frame.width,
                        frame.height,
                        max_frame_rate.max(1),
                        max_width,
                        max_height,
                        max_bitrate_bps,
                        content_hint.as_deref(),
                        preferred_codec.as_deref(),
                    )?;
                }
                video_pipeline::begin_screen_frame(
                    session,
                    frame.width,
                    frame.height,
                    true,
                    Some(&encoder_app),
                    capture_time,
                )
                .await
            });

            let encode_result = match begin_result {
                Ok(mut job) => {
                    // Phase 2 (heavy, session lock RELEASED): the crop,
                    // conversion, encode, encrypt, and datagram sends. Enter the
                    // runtime so the self-view native-decode branch can spawn.
                    let run_result = {
                        let _runtime_guard = encoder_runtime.enter();
                        video_pipeline::run_screen_frame(
                            &mut job,
                            &frame.bgra,
                            frame.width,
                            frame.height,
                            true,
                            Some(&encoder_app),
                        )
                    };
                    match run_result {
                        // Phase 3 (brief, re-lock): write the frame's results
                        // back, or drop the encoder if the stream was
                        // stopped/reconfigured while the lock was released.
                        Ok(outcome) => encoder_runtime.block_on(async {
                            let mut guard = encoder_session.lock().await;
                            let Some(session) = guard.as_mut() else {
                                return Err("no active session".to_string());
                            };
                            video_pipeline::finish_screen_frame(session, outcome)
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
                        &format!("screen encoder thread stopping on error: {err}"),
                    );
                    if let Some(startup_tx) = encoder_startup_signal
                        .lock()
                        .map_err(|e| e.to_string())?
                        .take()
                    {
                        let _ = startup_tx.send(Err(err.clone()));
                    }
                    // Stop the whole capture, not just this thread: a dead
                    // encoder with a live capture loop is a zombie stream that
                    // looks active while delivering nothing to anyone.
                    encoder_stop.store(true, Ordering::SeqCst);
                    return Err(err);
                }
            }
        }

        Ok(())
    });

    let capture_memory = CaptureMemory::choose(&app);
    let mut audio_accumulator = ScreenAudioAccumulator::default();
    // Bound the blocking frame wait to one frame interval (capped so an external
    // stop is still observed within ~100ms at low frame rates). Replaces the old
    // 5ms busy-poll (P6): this thread owns the capturer, so it parks on the
    // capture channel instead of spinning.
    let poll_interval = Duration::from_millis(16);
    let result = (|| -> Result<(), String> {
        while !stop_flag.load(Ordering::SeqCst) {
            let mut latest_video: Option<scap::frame::VideoFrame> = None;
            let mut audio_frames: Vec<scap::frame::AudioFrame> = Vec::new();

            loop {
                match capturer.try_get_next_frame() {
                    Ok(Some(scap::frame::Frame::Video(video))) => {
                        if latest_video.replace(video).is_some() {
                            latest_video_frame
                                .superseded
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Ok(Some(scap::frame::Frame::Audio(audio))) => {
                        audio_frames.push(audio);
                    }
                    Ok(None) => break,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        return Err("capture stream disconnected".into());
                    }
                }
            }

            if latest_video.is_none() && audio_frames.is_empty() {
                // Nothing buffered: park until the next frame or the poll
                // interval elapses, then re-check the stop flag.
                match capturer.recv_frame_timeout(poll_interval) {
                    Ok(Some(scap::frame::Frame::Video(video))) => {
                        latest_video = Some(video);
                    }
                    Ok(Some(scap::frame::Frame::Audio(audio))) => {
                        audio_frames.push(audio);
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        return Err("capture stream disconnected".into());
                    }
                }
            }

            for audio in audio_frames {
                if capture_audio
                    && integrated_audio_capture()
                    && screen_audio_enabled.load(Ordering::SeqCst)
                {
                    let first_sample_at = audio.time();
                    let samples = convert_audio_frame_to_stereo_f32(audio);
                    push_screen_audio_samples(
                        &screen_audio_tx,
                        &mut audio_accumulator,
                        &samples,
                        first_sample_at,
                    );
                }
            }

            if let Some(video) = latest_video {
                // Windows GPU texture route (spec §7, W3): a WGC `D3D11Texture`
                // frame is not a CPU BGRA readback. Build the `PendingVideoFrame`
                // directly from the texture — so the encode loop can hand the
                // `ID3D11Texture2D` to the MFT via `encode_texture` — instead of
                // routing it through `convert_video_frame`, which returns `None`
                // for this variant (dropping the frame). The `match` rebinds
                // `video` to the non-texture frame so the CPU path below still
                // runs for BGRA frames on the VP9 floor; the whole block is
                // `cfg(windows)` so Linux/mac never see it.
                #[cfg(target_os = "windows")]
                let video = match video {
                    scap::frame::VideoFrame::D3D11Texture(texture) => {
                        let pending = pending_frame_from_texture(texture);
                        let mut guard =
                            latest_video_frame.frame.lock().map_err(|e| e.to_string())?;
                        *guard = Some(Arc::new(pending));
                        drop(guard);
                        latest_video_frame.notify.notify_one();
                        continue;
                    }
                    other => other,
                };

                let Some((width, height, bgra, capture_time)) = convert_video_frame(video) else {
                    continue;
                };
                let placing = Instant::now();
                let bgra = capture_memory.place(bgra)?;
                latest_video_frame
                    .place_us
                    .fetch_add(placing.elapsed().as_micros() as u64, Ordering::Relaxed);
                latest_video_frame.placed.fetch_add(1, Ordering::Relaxed);
                let mut guard = latest_video_frame.frame.lock().map_err(|e| e.to_string())?;
                if guard.is_some() {
                    latest_video_frame
                        .overwritten
                        .fetch_add(1, Ordering::Relaxed);
                }
                *guard = Some(Arc::new(PendingVideoFrame {
                    width,
                    height,
                    bgra,
                    capture_time,
                    // CPU BGRA route: no GPU texture. The Windows texture route
                    // populates this via `pending_frame_from_texture` instead of
                    // going through `convert_video_frame` (spec §7, W3).
                    #[cfg(target_os = "windows")]
                    texture: None,
                }));
                drop(guard);
                latest_video_frame.notify.notify_one();
            }
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
    capturer.stop_capture();
    let encoder_result = encoder
        .join()
        .map_err(|_| "screen encoder thread panicked".to_string())?;
    result.and(encoder_result)
}

fn build_capture_options(
    source_id: Option<&str>,
    max_frame_rate: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
    capture_audio: bool,
) -> Result<scap::capturer::Options, String> {
    let mut options = scap::capturer::Options {
        fps: max_frame_rate.max(1),
        show_cursor: true,
        show_highlight: false,
        target: None,
        crop_area: None,
        output_type: scap::frame::FrameType::BGRAFrame,
        output_resolution: scap::capturer::Resolution::Captured,
        excluded_targets: None,
        captures_audio: capture_audio && integrated_audio_capture(),
        // Keep Paracord's own playback (voice chat) out of the captured mix —
        // otherwise every participant hears themselves echoed in the stream.
        exclude_current_process_audio: true,
        // Windows zero-copy WGC→MFT capture route (spec §7). The deterministic,
        // fixed route for this build is CPU BGRA readback: the screen encoder is
        // a `SimulcastEncoder`, whose per-layer encoders take system-memory input
        // (I420/NV12) — it has no `encode_texture` path, so a GPU-texture capture
        // frame would have no consumer. Selecting the texture route here without
        // that encode-side support would deliver a `VideoFrame::D3D11Texture` with
        // an empty CPU buffer and panic the CPU encode path. Keeping this `false`
        // makes the CPU BGRA route the single deterministic route (spec §0) and
        // keeps the reviewed `MfVideoEncoder::encode_texture` / WGC texture path
        // dormant-but-compiled until SimulcastEncoder gains texture input.
        prefer_gpu_texture: false,
    };

    #[cfg(not(target_os = "linux"))]
    {
        if let Some(source_id) = source_id {
            options.target = Some(target_from_source_id(source_id)?);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = source_id;
    }

    options.output_resolution = capture_resolution_for_options(&options, max_width, max_height);

    Ok(options)
}

fn capture_resolution_for_options(
    options: &scap::capturer::Options,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> scap::capturer::Resolution {
    let Some(max_width) = max_width else {
        return scap::capturer::Resolution::Captured;
    };
    let Some(max_height) = max_height else {
        return scap::capturer::Resolution::Captured;
    };

    let candidates = [
        scap::capturer::Resolution::_480p,
        scap::capturer::Resolution::_720p,
        scap::capturer::Resolution::_1080p,
        scap::capturer::Resolution::_1440p,
        scap::capturer::Resolution::_2160p,
        scap::capturer::Resolution::_4320p,
    ];

    let mut chosen = scap::capturer::Resolution::_480p;
    for candidate in candidates {
        let mut probe = options.clone();
        probe.output_resolution = candidate;
        let [width, height] = scap::capturer::get_output_frame_size(&probe);
        if width <= max_width && height <= max_height {
            chosen = candidate;
        } else {
            break;
        }
    }

    chosen
}

#[cfg(not(target_os = "linux"))]
fn target_from_source_id(source_id: &str) -> Result<scap::Target, String> {
    for target in scap::get_all_targets() {
        if let Some(source) = source_from_target(&target) {
            if source.id == source_id {
                return Ok(target);
            }
        }
    }
    Err("Selected screen share source is no longer available.".into())
}

#[cfg(not(target_os = "linux"))]
fn source_from_target(target: &scap::Target) -> Option<ScreenShareSource> {
    let (id, kind, title, app_name) = match target {
        scap::Target::Display(display) => (
            format!("display:{}", display.id),
            "display".to_string(),
            display.title.clone(),
            None,
        ),
        scap::Target::Window(window) => {
            let title = window.title.trim().to_string();
            if title.is_empty() {
                return None;
            }
            (
                format!("window:{}", window.id),
                "window".to_string(),
                title.clone(),
                guess_app_name(&title),
            )
        }
    };

    let title_lower = title.to_ascii_lowercase();
    let app_name_lower = app_name.as_deref().map(str::to_ascii_lowercase);
    let is_self = app_name_lower
        .as_deref()
        .map(|name| name.contains("paracord"))
        .unwrap_or(false)
        || (app_name.is_none()
            && (title_lower == "paracord"
                || title_lower.starts_with("paracord ")
                || title_lower.starts_with("paracord -")));
    Some(ScreenShareSource {
        id,
        kind,
        title,
        app_name,
        audio_supported: true,
        is_self,
        requires_os_picker: false,
    })
}

#[cfg(not(target_os = "linux"))]
fn guess_app_name(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if let Some((_, app_name)) = trimmed.rsplit_once(" - ") {
        return Some(app_name.trim().to_string());
    }
    if let Some((_, app_name)) = trimmed.rsplit_once(" — ") {
        return Some(app_name.trim().to_string());
    }
    None
}

fn convert_video_frame(video: scap::frame::VideoFrame) -> Option<(u32, u32, Vec<u8>, SystemTime)> {
    match video {
        scap::frame::VideoFrame::BGRA(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            frame.data,
            frame.display_time,
        )),
        scap::frame::VideoFrame::BGR0(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            frame.data,
            frame.display_time,
        )),
        // Formats produced by the Linux PipeWire engine.
        scap::frame::VideoFrame::BGRx(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            frame.data,
            frame.display_time,
        )),
        scap::frame::VideoFrame::RGBx(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            rgbx_to_bgra(frame.data),
            frame.display_time,
        )),
        scap::frame::VideoFrame::XBGR(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            xbgr_to_bgra(frame.data),
            frame.display_time,
        )),
        scap::frame::VideoFrame::RGB(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            rgb_to_bgra(&frame.data),
            frame.display_time,
        )),
        // Windows GPU texture route (spec §7, W3): D3D11 texture frames are not a
        // CPU BGRA readback and are threaded through `pending_frame_from_texture`,
        // never this converter. An explicit arm documents that reaching here is a
        // routing bug (the texture route was chosen but a frame took the CPU
        // path), distinct from the "unknown pixel format" catch-all below.
        #[cfg(target_os = "windows")]
        scap::frame::VideoFrame::D3D11Texture(_) => None,
        _ => None,
    }
}

/// Build a [`PendingVideoFrame`] from a Windows GPU texture frame (spec §7, W3).
///
/// The `bgra` buffer stays empty — on the texture route the encode loop hands
/// the `ID3D11Texture2D` straight to the MFT via `encode_texture` and never
/// materializes system-memory pixels for this frame. This is the texture-route
/// counterpart to the CPU `PendingVideoFrame` built from `convert_video_frame`.
#[cfg(target_os = "windows")]
pub(crate) fn pending_frame_from_texture(
    texture: scap::frame::D3D11TextureFrame,
) -> PendingVideoFrame {
    PendingVideoFrame {
        width: texture.width as u32,
        height: texture.height as u32,
        bgra: FramePixels::Heap(Vec::new()),
        capture_time: texture.display_time,
        texture: Some(texture),
    }
}

fn rgbx_to_bgra(data: Vec<u8>) -> Vec<u8> {
    let mut out = data;
    for px in out.as_chunks_mut::<4>().0.iter_mut() {
        px.swap(0, 2);
        px[3] = 255;
    }
    out
}

fn xbgr_to_bgra(data: Vec<u8>) -> Vec<u8> {
    let mut out = data;
    for px in out.as_chunks_mut::<4>().0.iter_mut() {
        // x,B,G,R -> B,G,R,A
        px[0] = px[1];
        px[1] = px[2];
        let r = px[3];
        px[2] = r;
        px[3] = 255;
    }
    out
}

fn rgb_to_bgra(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 3 * 4);
    for px in data.as_chunks::<3>().0.iter() {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    out
}

#[cfg(not(target_os = "linux"))]
fn encode_bgra_as_jpeg_data_url(
    bgra: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<String, String> {
    if width == 0 || height == 0 || bgra.is_empty() {
        return Err("cannot encode empty frame".into());
    }

    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for pixel in bgra.chunks_exact(4) {
        rgb.push(pixel[2]);
        rgb.push(pixel[1]);
        rgb.push(pixel[0]);
    }

    let mut encoded = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut encoded, quality);
    encoder
        .write_image(&rgb, width, height, ColorType::Rgb8.into())
        .map_err(|e| format!("jpeg encode failed: {e}"))?;

    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64_STANDARD.encode(encoded)
    ))
}

#[cfg(not(target_os = "linux"))]
fn resize_bgra(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32, Vec<u8>) {
    if src_width == 0 || src_height == 0 || src.is_empty() {
        return (0, 0, Vec::new());
    }

    let scale = f32::min(
        max_width as f32 / src_width as f32,
        max_height as f32 / src_height as f32,
    )
    .min(1.0);
    let dst_width = ((src_width as f32 * scale).round() as u32).max(1);
    let dst_height = ((src_height as f32 * scale).round() as u32).max(1);

    if dst_width == src_width && dst_height == src_height {
        return (src_width, src_height, src.to_vec());
    }

    let mut dst = vec![0u8; (dst_width * dst_height * 4) as usize];
    for y in 0..dst_height {
        let src_y = ((y as u64 * src_height as u64) / dst_height as u64) as u32;
        for x in 0..dst_width {
            let src_x = ((x as u64 * src_width as u64) / dst_width as u64) as u32;
            let src_idx = ((src_y * src_width + src_x) * 4) as usize;
            let dst_idx = ((y * dst_width + x) * 4) as usize;
            dst[dst_idx..dst_idx + 4].copy_from_slice(&src[src_idx..src_idx + 4]);
        }
    }

    (dst_width, dst_height, dst)
}

fn convert_audio_frame_to_stereo_f32(frame: scap::frame::AudioFrame) -> Vec<f32> {
    let channels = frame.channels().max(1) as usize;
    let sample_count = frame.sample_count();
    let mut mono = Vec::with_capacity(sample_count);

    for sample_idx in 0..sample_count {
        let mut sum = 0.0f32;
        for channel_idx in 0..channels {
            sum += decode_audio_sample(&frame, sample_idx, channel_idx);
        }
        mono.push((sum / channels as f32).clamp(-1.0, 1.0));
    }

    let resampled = if frame.rate() == SCREEN_AUDIO_SAMPLE_RATE {
        mono
    } else {
        resample_linear(&mono, frame.rate(), SCREEN_AUDIO_SAMPLE_RATE)
    };

    let mut stereo = Vec::with_capacity(resampled.len() * 2);
    for sample in resampled {
        stereo.push(sample);
        stereo.push(sample);
    }
    stereo
}

fn decode_audio_sample(
    frame: &scap::frame::AudioFrame,
    sample_idx: usize,
    channel_idx: usize,
) -> f32 {
    let sample_size = frame.format().sample_size();
    let offset = if frame.is_planar() {
        sample_idx * sample_size
    } else {
        (sample_idx * frame.channels() as usize + channel_idx) * sample_size
    };
    let data = if frame.is_planar() {
        frame.plane_data(channel_idx)
    } else {
        frame.raw_data()
    };

    match frame.format() {
        scap::frame::AudioFormat::F32 => {
            let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap_or([0; 4]);
            f32::from_ne_bytes(bytes)
        }
        scap::frame::AudioFormat::F64 => {
            let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap_or([0; 8]);
            f64::from_ne_bytes(bytes) as f32
        }
        scap::frame::AudioFormat::I16 => {
            let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap_or([0; 2]);
            i16::from_ne_bytes(bytes) as f32 / i16::MAX as f32
        }
        scap::frame::AudioFormat::I32 => {
            let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap_or([0; 4]);
            i32::from_ne_bytes(bytes) as f32 / i32::MAX as f32
        }
        scap::frame::AudioFormat::U8 => ((data[offset] as f32 / u8::MAX as f32) * 2.0) - 1.0,
        scap::frame::AudioFormat::U16 => {
            let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap_or([0; 2]);
            ((u16::from_ne_bytes(bytes) as f32 / u16::MAX as f32) * 2.0) - 1.0
        }
        _ => 0.0,
    }
}

fn resample_linear(samples: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if samples.is_empty() || input_rate == 0 || input_rate == output_rate {
        return samples.to_vec();
    }

    let ratio = output_rate as f64 / input_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);

    for out_idx in 0..out_len {
        let src_pos = (out_idx as f64) / ratio;
        let src_idx = src_pos.floor() as usize;
        let next_idx = (src_idx + 1).min(samples.len().saturating_sub(1));
        let frac = (src_pos - src_idx as f64) as f32;
        let a = samples[src_idx.min(samples.len().saturating_sub(1))];
        let b = samples[next_idx];
        out.push(a + ((b - a) * frac));
    }

    out
}

/// ScreenCaptureKit's audio, re-chunked into 20 ms frames, with the capture
/// time of the oldest waiting sample (the same presentation clock the screen's
/// frames carry), so each frame goes out stamped from it (stream audit B7).
#[derive(Default)]
struct ScreenAudioAccumulator {
    samples: Vec<f32>,
    first_sample_at: Option<SystemTime>,
}

fn push_screen_audio_samples(
    tx: &tokio::sync::mpsc::Sender<super::av_sync::ScreenAudioFrame>,
    accumulator: &mut ScreenAudioAccumulator,
    stereo_samples: &[f32],
    first_sample_at: SystemTime,
) {
    if accumulator.samples.is_empty() {
        accumulator.first_sample_at = Some(first_sample_at);
    }
    accumulator.samples.extend_from_slice(stereo_samples);
    let chunk_len = SCREEN_AUDIO_FRAME_SIZE * 2;
    let frame_duration = std::time::Duration::from_millis(20);
    while accumulator.samples.len() >= chunk_len {
        let samples: Vec<f32> = accumulator.samples.drain(..chunk_len).collect();
        let captured_at = accumulator.first_sample_at.unwrap_or(first_sample_at);
        accumulator.first_sample_at = Some(captured_at + frame_duration);
        let _ = tx.try_send(super::av_sync::ScreenAudioFrame {
            samples,
            captured_at,
        });
    }
}

fn integrated_audio_capture() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::FramePacer;

    /// Frames a pacer at `fps` admits from a source at `source_hz` over one
    /// second, with a deterministic ±`jitter_us` wobble on each capture time.
    fn admitted(fps: u32, source_hz: f64, jitter_us: i64) -> usize {
        let mut pacer = FramePacer::default();
        pacer.set_fps(fps);
        let period = 1_000_000.0 / source_hz;
        (0..(source_hz as usize))
            .filter(|&n| {
                let wobble = [0, jitter_us, -jitter_us, jitter_us / 2][n % 4];
                let at = (1_000_000.0 + n as f64 * period) as i64 + wobble;
                pacer.admit(at as u64)
            })
            .count()
    }

    #[test]
    fn a_60_hz_source_fills_a_60_fps_target() {
        assert_eq!(admitted(60, 60.0, 0), 60);
        assert_eq!(admitted(60, 60.0, 2_000), 60);
        // A source a hair slower than the target is never thinned.
        assert_eq!(admitted(60, 59.94, 1_000), 59);
    }

    #[test]
    fn capture_jitter_at_the_target_rate_costs_no_frame() {
        // A loaded machine: every third frame is delivered 7 ms late, the next
        // one on time (so it looks 9.7 ms after the late one).
        let mut pacer = FramePacer::default();
        pacer.set_fps(60);
        let admitted = (0..600u64)
            .filter(|&n| pacer.admit(1_000_000 + n * 16_667 + if n % 3 == 1 { 7_000 } else { 0 }))
            .count();
        assert!(admitted >= 599, "{admitted}");
    }

    #[test]
    fn a_60_hz_source_is_halved_evenly_for_30_fps() {
        let mut pacer = FramePacer::default();
        pacer.set_fps(30);
        let admitted: Vec<usize> = (0..60)
            .filter(|&n| pacer.admit(1_000_000 + n as u64 * 16_667))
            .collect();
        assert_eq!(admitted.len(), 30);
        assert!(admitted.windows(2).all(|pair| pair[1] - pair[0] == 2));
        assert_eq!(super::tests::admitted(30, 60.0, 2_000), 30);
    }

    #[test]
    fn a_fast_source_never_exceeds_the_target() {
        // Over ten seconds; a window's last slot may land a quarter interval
        // early, so one frame either way.
        let over_ten_seconds = |fps, hz: f64, jitter| -> usize {
            let mut pacer = FramePacer::default();
            pacer.set_fps(fps);
            let period = 1_000_000.0 / hz;
            (0..(hz as usize * 10))
                .filter(|&n| {
                    let wobble = [0, jitter, -jitter, jitter / 2][n % 4];
                    pacer.admit(((1_000_000.0 + n as f64 * period) as i64 + wobble) as u64)
                })
                .count()
        };
        let at_144 = over_ten_seconds(60, 144.0, 500);
        assert!((599..=601).contains(&at_144), "{at_144}");
        let at_240 = over_ten_seconds(30, 240.0, 0);
        assert!((299..=301).contains(&at_240), "{at_240}");
    }

    #[test]
    fn an_early_frame_is_held_only_until_its_slot() {
        let mut pacer = FramePacer::default();
        pacer.set_fps(30);
        assert!(pacer.admit(1_000_000));
        // The next 60 Hz frame, 16.7 ms on, is early for a 33.3 ms slot.
        assert!(!pacer.admit(1_016_667));
        let hold = pacer.hold_for(1_016_667);
        // Until the slot (16.7 ms) plus half an interval of grace, not a full
        // interval from now.
        assert_eq!(hold.as_micros(), 16_666 + 16_666);
        pacer.slot_taken();
        // The slot after that is still on the 30 fps grid.
        assert!(!pacer.admit(1_050_000));
        assert!(pacer.admit(1_066_667));
    }

    #[test]
    fn a_stall_restarts_the_schedule_instead_of_bursting() {
        let mut pacer = FramePacer::default();
        pacer.set_fps(60);
        assert!(pacer.admit(1_000_000));
        // Half a second without frames, then a 60 Hz run: no catch-up burst.
        let run: Vec<bool> = (0..6)
            .map(|n| pacer.admit(1_500_000 + n * 16_667))
            .collect();
        assert_eq!(run, vec![true; 6]);
    }
}
