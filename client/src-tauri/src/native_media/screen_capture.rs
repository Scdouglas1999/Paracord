use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::mpsc::TryRecvError;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
// `Instant` is only used by the non-Linux thumbnail capture path below.
#[cfg(not(target_os = "linux"))]
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use image::ImageEncoder;
use serde::Serialize;
use tauri::Emitter;

use super::{session::NativeMediaSession, video_pipeline, MediaState};
use paracord_transport::control::ControlMessage;
#[cfg(feature = "vpx")]
use paracord_transport::control::TrackKind;
use paracord_transport::stream::PublishedTrack;
#[cfg(feature = "vpx")]
use paracord_transport::stream::{
    PublishedLayer, StreamId, TrackId, VideoCodec as TransportVideoCodec,
};

const EVENT_EVENT: &str = "native_screen_share_event";
const SCREEN_AUDIO_SAMPLE_RATE: u32 = 48_000;
const SCREEN_AUDIO_FRAME_SIZE: usize = 960;
const PICKER_THUMBNAIL_MAX_WIDTH: u32 = 320;
const PICKER_THUMBNAIL_MAX_HEIGHT: u32 = 180;
const THUMBNAIL_JPEG_QUALITY: u8 = 74;

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

struct PendingVideoFrame {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

struct LatestVideoFrame {
    frame: std::sync::Mutex<Option<PendingVideoFrame>>,
    notify: std::sync::Condvar,
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
        let Some((width, height, bgra)) = convert_video_frame(video) else {
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
    app: tauri::AppHandle,
    request: StartScreenShareRequest,
) -> Result<(), String> {
    stop_capture(state).await?;

    if !scap::is_supported() {
        return Err("Native screen capture is not supported on this platform.".into());
    }
    if !scap::has_permission() && !scap::request_permission() {
        return Err("Screen capture permission was denied.".into());
    }

    let session_arc = state.session.clone();
    let runtime_handle = tokio::runtime::Handle::current();

    let (screen_audio_tx, screen_audio_enabled) = {
        let mut guard = session_arc.lock().await;
        let session = guard.as_mut().ok_or("no active session")?;

        let capture_options = build_capture_options(
            request.source_id.as_deref(),
            request.max_frame_rate,
            request.max_width,
            request.max_height,
            request.capture_audio,
        )?;
        let [capture_width, capture_height] =
            scap::capturer::get_output_frame_size(&capture_options);
        video_pipeline::start_screen_share(
            session,
            capture_width,
            capture_height,
            request.max_frame_rate.max(1),
            request.max_bitrate_bps,
            request.content_hint.as_deref(),
            request.preferred_codec.as_deref(),
        )?;
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

    let stop_flag = Arc::new(AtomicBool::new(false));
    let worker_stop = stop_flag.clone();
    let worker_app = app.clone();
    let source_id = request.source_id.clone();
    let max_frame_rate = request.max_frame_rate;
    let max_width = request.max_width;
    let max_height = request.max_height;
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();

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
            request.capture_audio,
            screen_audio_tx,
            screen_audio_enabled,
            startup_tx,
        );

        if let Err(err) = run_result {
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

    match startup_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {
            if let Err(err) = announce_screen_track(state, &app).await {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = worker.join();
                let mut guard = state.session.lock().await;
                if let Some(session) = guard.as_mut() {
                    video_pipeline::stop_screen_share(session);
                    session.screen_audio_enabled.store(false, Ordering::SeqCst);
                    session.published_screen_track = None;
                }
                return Err(err);
            }
            let mut guard = state.screen_capture.lock().map_err(|e| e.to_string())?;
            *guard = Some(ActiveScreenCapture::new(stop_flag, worker));
            Ok(())
        }
        Ok(Err(err)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = worker.join();
            let mut guard = state.session.lock().await;
            if let Some(session) = guard.as_mut() {
                video_pipeline::stop_screen_share(session);
                session.screen_audio_enabled.store(false, Ordering::SeqCst);
                session.published_screen_track = None;
            }
            Err(err)
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = worker.join();
            let mut guard = state.session.lock().await;
            if let Some(session) = guard.as_mut() {
                video_pipeline::stop_screen_share(session);
                session.screen_audio_enabled.store(false, Ordering::SeqCst);
                session.published_screen_track = None;
            }
            Err("Timed out while starting native screen capture.".into())
        }
    }
}

pub async fn stop_capture(state: &MediaState) -> Result<(), String> {
    if let Ok(mut guard) = state.screen_capture.lock() {
        if let Some(mut active) = guard.take() {
            active.stop();
        }
    }

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
        video_pipeline::stop_screen_share(session);
        session.screen_audio_enabled.store(false, Ordering::SeqCst);
    }
    Ok(())
}

async fn announce_screen_track(state: &MediaState, app: &tauri::AppHandle) -> Result<(), String> {
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
    app: tauri::AppHandle,
    stop_flag: Arc<AtomicBool>,
    source_id: Option<String>,
    max_frame_rate: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
    capture_audio: bool,
    screen_audio_tx: tokio::sync::mpsc::Sender<Vec<f32>>,
    screen_audio_enabled: Arc<AtomicBool>,
    startup_tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let options = build_capture_options(
        source_id.as_deref(),
        max_frame_rate,
        max_width,
        max_height,
        capture_audio,
    )?;
    let mut capturer =
        scap::capturer::Capturer::build(options).map_err(|e| format!("capture init: {e}"))?;
    capturer.start_capture();

    let latest_video_frame = Arc::new(LatestVideoFrame {
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
    let encoder = thread::spawn(move || -> Result<(), String> {
        while !encoder_stop.load(Ordering::SeqCst) {
            let next_frame = {
                let mut guard = encoder_frames.frame.lock().map_err(|e| e.to_string())?;
                while guard.is_none() && !encoder_stop.load(Ordering::SeqCst) {
                    let (next_guard, _) = encoder_frames
                        .notify
                        .wait_timeout(guard, Duration::from_millis(50))
                        .map_err(|e| e.to_string())?;
                    guard = next_guard;
                }
                guard.take()
            };

            let Some(frame) = next_frame else {
                continue;
            };

            let encode_result = encoder_runtime.block_on(async {
                let mut guard = encoder_session.lock().await;
                if let Some(session) = guard.as_mut() {
                    video_pipeline::encode_and_send_video_frame(
                        session,
                        frame.width,
                        frame.height,
                        &frame.bgra,
                        true,
                        true,
                        Some(&encoder_app),
                    )
                } else {
                    Err("no active session".to_string())
                }
            });

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
                    if let Some(startup_tx) = encoder_startup_signal
                        .lock()
                        .map_err(|e| e.to_string())?
                        .take()
                    {
                        let _ = startup_tx.send(Err(err.clone()));
                    }
                    return Err(err);
                }
            }
        }

        Ok(())
    });

    let mut audio_accumulator = Vec::<f32>::new();
    let result = (|| -> Result<(), String> {
        while !stop_flag.load(Ordering::SeqCst) {
            let frame = capturer
                .get_next_frame()
                .map_err(|e| format!("capture frame read failed: {e}"))?;
            let mut latest_video: Option<scap::frame::VideoFrame> = None;
            let mut audio_frames: Vec<scap::frame::AudioFrame> = Vec::new();

            match frame {
                scap::frame::Frame::Video(video) => latest_video = Some(video),
                scap::frame::Frame::Audio(audio) => audio_frames.push(audio),
            }

            loop {
                match capturer.try_get_next_frame() {
                    Ok(Some(scap::frame::Frame::Video(video))) => {
                        latest_video = Some(video);
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

            for audio in audio_frames {
                if capture_audio
                    && integrated_audio_capture()
                    && screen_audio_enabled.load(Ordering::SeqCst)
                {
                    let samples = convert_audio_frame_to_stereo_f32(audio);
                    push_screen_audio_samples(&screen_audio_tx, &mut audio_accumulator, &samples);
                }
            }

            if let Some(video) = latest_video {
                let Some((width, height, bgra)) = convert_video_frame(video) else {
                    continue;
                };
                let mut guard = latest_video_frame.frame.lock().map_err(|e| e.to_string())?;
                *guard = Some(PendingVideoFrame {
                    width,
                    height,
                    bgra,
                });
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
        exclude_current_process_audio: false,
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

fn convert_video_frame(video: scap::frame::VideoFrame) -> Option<(u32, u32, Vec<u8>)> {
    match video {
        scap::frame::VideoFrame::BGRA(frame) => {
            Some((frame.width as u32, frame.height as u32, frame.data))
        }
        scap::frame::VideoFrame::BGR0(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            bgr0_to_bgra(frame.data),
        )),
        // Formats produced by the Linux PipeWire engine.
        scap::frame::VideoFrame::BGRx(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            bgr0_to_bgra(frame.data),
        )),
        scap::frame::VideoFrame::RGBx(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            rgbx_to_bgra(frame.data),
        )),
        scap::frame::VideoFrame::XBGR(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            xbgr_to_bgra(frame.data),
        )),
        scap::frame::VideoFrame::RGB(frame) => Some((
            frame.width as u32,
            frame.height as u32,
            rgb_to_bgra(&frame.data),
        )),
        _ => None,
    }
}

fn bgr0_to_bgra(data: Vec<u8>) -> Vec<u8> {
    let mut out = data;
    for alpha in out.iter_mut().skip(3).step_by(4) {
        *alpha = 255;
    }
    out
}

fn rgbx_to_bgra(data: Vec<u8>) -> Vec<u8> {
    let mut out = data;
    for px in out.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    out
}

fn xbgr_to_bgra(data: Vec<u8>) -> Vec<u8> {
    let mut out = data;
    for px in out.chunks_exact_mut(4) {
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
    for px in data.chunks_exact(3) {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    out
}

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

fn push_screen_audio_samples(
    tx: &tokio::sync::mpsc::Sender<Vec<f32>>,
    accumulator: &mut Vec<f32>,
    stereo_samples: &[f32],
) {
    accumulator.extend_from_slice(stereo_samples);
    let chunk_len = SCREEN_AUDIO_FRAME_SIZE * 2;
    while accumulator.len() >= chunk_len {
        let chunk: Vec<f32> = accumulator.drain(..chunk_len).collect();
        let _ = tx.try_send(chunk);
    }
}

fn integrated_audio_capture() -> bool {
    cfg!(target_os = "macos")
}
