use super::session::NativeMediaSession;
use paracord_transport::protocol::MediaHeader;
use paracord_transport::stream::PublishedTrack;
use tauri::AppHandle;

#[cfg(feature = "vpx")]
use bytes::{BufMut, Bytes, BytesMut};
#[cfg(feature = "vpx")]
use paracord_codec::crypto::TAG_SIZE;
#[cfg(feature = "vpx")]
use paracord_codec::video::VideoCodec;
#[cfg(feature = "vpx")]
use paracord_transport::protocol::{MediaStreamFrame, TrackType, VideoFrameMetadata, HEADER_SIZE};
#[cfg(feature = "vpx")]
use paracord_transport::stream::VideoCodec as TransportVideoCodec;
#[cfg(feature = "vpx")]
use paracord_transport::stream::{StreamId, TrackId};
#[cfg(feature = "vpx")]
use std::collections::{BTreeMap, HashMap};
#[cfg(feature = "vpx")]
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex, OnceLock,
};
#[cfg(feature = "vpx")]
use std::time::{Duration, Instant};
#[cfg(feature = "vpx")]
use tokio::sync::{mpsc, Notify};
#[cfg(feature = "vpx")]
use tokio::task::JoinHandle;

/// Bounded depth of the per-track decode worker's input channel. Kept tiny so a
/// stalled decoder sheds load (drop-newest / drop-until-keyframe) instead of
/// piling reassembled multi-KB frames on the heap.
#[cfg(feature = "vpx")]
const DECODE_CHANNEL_DEPTH: usize = 2;
/// Maximum number of out-of-order frames the reorder stage holds before it
/// force-delivers the oldest. Datagram reordering beyond this is treated as loss.
#[cfg(feature = "vpx")]
const REORDER_MAX_HELD: usize = 2;
/// Longest a reordered frame waits for its predecessor before being delivered
/// anyway. Bounds added latency from the reorder stage.
#[cfg(feature = "vpx")]
const REORDER_HOLD: Duration = Duration::from_millis(50);
/// A stored frame older than this at resume time is treated as stale, forcing a
/// keyframe request so a re-shown tile does not paint a frozen old picture.
#[cfg(feature = "vpx")]
const VISIBILITY_STALE_AFTER: Duration = Duration::from_secs(2);

#[cfg(feature = "vpx")]
const FALLBACK_MAX_DATAGRAM_SIZE: usize = 1200;
/// A frame that would fragment into more than this many datagrams is sent on a
/// reliable QUIC uni stream instead. Keyframes always take the stream path; this
/// also catches the occasional huge delta (a scene cut) whose all-or-nothing
/// datagram reassembly would otherwise die at any real packet-loss rate.
#[cfg(feature = "vpx")]
const STREAM_FRAGMENT_THRESHOLD: usize = 48;
/// Datagram bursts larger than this many fragments are paced out with a short
/// gap between fragments so audio datagrams never sit behind a big video burst
/// (L3). Keyframes are off the datagram path entirely, so this now only ever
/// applies to large delta frames.
#[cfg(feature = "vpx")]
const AUDIO_PACING_FRAGMENT_THRESHOLD: usize = 32;
/// Inter-fragment gap used when pacing a large datagram burst (~1ms).
#[cfg(feature = "vpx")]
const AUDIO_PACING_INTERVAL: Duration = Duration::from_micros(1000);
#[cfg(feature = "vpx")]
const VIDEO_REASSEMBLY_TTL: Duration = Duration::from_secs(3);
/// How often the reassembly pool is swept for expired partial frames.
///
/// The sweep is an O(n) `retain`; running it on every fragment made fragment
/// handling quadratic in the pool size, and the pool key is entirely
/// attacker-chosen. A periodic sweep bounds that work while the hard entry cap
/// below bounds the pool itself.
#[cfg(feature = "vpx")]
const VIDEO_REASSEMBLY_SWEEP_INTERVAL: Duration = Duration::from_millis(500);
/// Maximum number of partially-reassembled frames held at once, across all
/// remote tracks.
///
/// Every entry is keyed by `stream_id:track_id:frame_id` — all sender-chosen —
/// so without a cap a peer can mint unbounded entries by never completing a
/// frame. A 60 fps sender with three simulcast layers has at most a handful in
/// flight at any instant; 128 is generous.
#[cfg(feature = "vpx")]
const MAX_INFLIGHT_REASSEMBLY_FRAMES: usize = 128;
/// Largest `fragment_count` a datagram-delivered frame may declare.
///
/// `fragment_count` sizes the slot vector before any payload is validated, so
/// one ~1200-byte datagram declaring 65535 fragments allocated 1.5 MB. This
/// bounds a partial frame by what a *whole* frame is allowed to be
/// ([`MAX_STREAM_FRAME_SIZE`]) at the smallest datagram a sender can be using.
/// Senders move anything past `STREAM_FRAGMENT_THRESHOLD` fragments onto the
/// uni-stream path, so this leaves orders of magnitude of headroom.
#[cfg(feature = "vpx")]
const MAX_REASSEMBLY_FRAGMENTS: usize =
    paracord_transport::protocol::MAX_STREAM_FRAME_SIZE / FALLBACK_MAX_DATAGRAM_SIZE;
/// Maximum concurrently-running per-track decode workers.
///
/// Workers are keyed by the sender-chosen `stream_id:track_id`, and each owns a
/// decoder plus a blocking-pool task, so the map must not grow on unauthenticated
/// input. The identity cross-check already confines keys to announced tracks;
/// this is the belt-and-braces bound.
#[cfg(feature = "vpx")]
const MAX_DECODE_WORKERS: usize = 64;
/// Periodic keyframe cadence in seconds — a safety net only. Every encoder
/// backend now honors on-demand keyframes instantly (the in-process libavcodec
/// engine stamps AV_PICTURE_TYPE_I on the exact requested frame; libvpx forces
/// one the same way), so recovery and late joins ride explicit RequestKeyframe
/// messages. This periodic interval only bounds worst-case recovery for a
/// viewer that missed the request; each keyframe is a burst of hundreds of
/// datagrams that risks fragment loss, so it stays long.
#[cfg(feature = "vpx")]
const SCREEN_KEYFRAME_INTERVAL_SECONDS: u32 = 4;
/// Floor for relay-feedback-driven bitrate reduction; below this, screen
/// content becomes unreadable and further reduction rarely helps.
#[cfg(feature = "vpx")]
const MIN_ADAPTIVE_SCREEN_BITRATE_KBPS: u32 = 512;
#[cfg(feature = "vpx")]
pub const PULLED_VIDEO_FRAME_HEADER_SIZE: usize = 28;
#[cfg(feature = "vpx")]
static VIDEO_SEND_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);
#[cfg(feature = "vpx")]
static VIDEO_STORE_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);

#[cfg(feature = "vpx")]
static VIDEO_HANDLE_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);
/// Per-stream counter bounding native pipeline diagnostics; reset by
/// `start_screen_share`.
#[cfg(feature = "vpx")]
static SCREEN_DIAG_COUNT: AtomicU32 = AtomicU32::new(0);
#[cfg(feature = "vpx")]
const SCREEN_DIAG_FRAMES: u32 = 30;
/// Per-capture counter bounding native camera pipeline diagnostics; reset by
/// `start_camera_share`.
#[cfg(feature = "vpx")]
static CAMERA_DIAG_COUNT: AtomicU32 = AtomicU32::new(0);
#[cfg(feature = "vpx")]
const CAMERA_DIAG_FRAMES: u32 = 30;

/// Append a line to the same on-disk diagnostics log the frontend writes
/// (client-voice.log) so native pipeline events land in the one timeline that
/// gets consulted when streaming breaks. Bounded by callers.
pub(super) fn native_diag(app: Option<&AppHandle>, line: &str) {
    eprintln!("[native-diag] {line}");
    let Some(app) = app else { return };
    if let Ok(path) = crate::commands::diagnostics_log_path(app) {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "[native] {line}");
        }
    }
}

/// One encoded frame retained from the send loop for the local self-view.
/// This is the exact bitstream remote viewers receive — the host's preview is
/// never a downscaled or raw side-channel.
#[cfg(feature = "vpx")]
struct LocalPreviewFrame {
    timestamp_us: u64,
    is_keyframe: bool,
    codec: VideoCodec,
    colorspace: paracord_codec::video::ColorSpace,
    pts: i64,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[cfg(feature = "vpx")]
struct VideoReassemblyState {
    fragment_count: u16,
    is_keyframe: bool,
    chunks: Vec<Option<Vec<u8>>>,
    received: usize,
    last_update: Instant,
}

#[cfg(feature = "vpx")]
struct VideoDispatchState {
    remote_track_latest_frames: HashMap<String, PulledVideoFramePayload>,
    remote_track_sequences: HashMap<String, u64>,
    remote_track_ssrcs: HashMap<String, u32>,
    /// Tracks whose frames should be stored encoded (passthrough) for the
    /// webview's WebCodecs decoder instead of being decoded natively to raw
    /// I420. Encoded frames are orders of magnitude smaller over Tauri IPC and
    /// decode on the GPU.
    remote_track_prefer_encoded: std::collections::HashSet<String>,
    /// Push channel to the webview subscription for each track. Frames are sent
    /// here (as packed binary bodies) the moment they are stored, so the webview
    /// never polls. A cloned handle is taken out under the lock and the actual
    /// send happens after the lock is released — `channel.send` dispatches to the
    /// webview event loop and must never run inside the dispatch-state mutex.
    remote_track_channels: HashMap<String, tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>>,
    /// Subscriber viewport (target render size) per track. Natively decoded raw
    /// I420 frames are downscaled to this before store/push so a 1080p frame does
    /// not cross IPC at full size for a small tile. Absent = no downscale.
    remote_track_viewports: HashMap<String, (u32, u32)>,
    /// Tracks the subscriber has hidden. While hidden, decode+push are skipped;
    /// only keyframes are stored (no push) so a resume can paint immediately.
    remote_track_hidden: std::collections::HashSet<String>,
    /// Wall-clock instant the latest frame for each track was stored, used to
    /// decide staleness on a visibility resume.
    remote_track_stored_at: HashMap<String, Instant>,
    /// Highest keyframe frame_id already accepted from a uni stream, per track.
    /// A stream keyframe whose frame_id is not newer is culled (a newer keyframe
    /// already superseded it), so a viewer too slow to drain the previous
    /// keyframe stream does not waste work decoding a stale one (L1 backpressure).
    remote_track_stream_high_water: HashMap<String, u64>,
    /// Native-surface route bindings (spec §2/§3.6): tracks whose frames are
    /// decoded to GPU-resident [`DecodedFrameHandle`]s and presented on a native
    /// surface, NOT stored/pushed over the frame channel. Presence here selects
    /// the `native-surface` route in [`deliver_decoded_frame`]; the raw-I420
    /// store/push path is deleted, so a track is either here (native surface),
    /// in `remote_track_prefer_encoded` (webcodecs passthrough), or has no
    /// video consumer.
    remote_track_surfaces: HashMap<String, TrackSurfaceBinding>,
    /// Authoritative SSRC → track-key binding, taken from the relay's
    /// `TrackPublish`/`TrackLayers` announcements (every simulcast layer's
    /// SSRC) plus the SSRC named at subscription time.
    ///
    /// This is the ONLY field of an incoming media packet whose ownership the
    /// relay actually authorizes: it resolves the SSRC to a published track
    /// before forwarding, and the decryption key is installed per SSRC. The
    /// `stream_id`/`track_id` inside the (encrypted) metadata are just labels
    /// the sender chose, so they must be cross-checked against this map before
    /// they are allowed to select a reassembly pool, decoder, surface or webview
    /// channel — otherwise a hostile peer you are subscribed to can label its
    /// frames with another participant's identity and render its video on that
    /// participant's tile. AEAD success proves only "encrypted under a key we
    /// installed for this SSRC", never "this is that track's content".
    remote_ssrc_track_bindings: HashMap<u32, String>,
    /// Largest resolution each remote track announced across its layers, used to
    /// cap decode allocations at what the peer actually negotiated rather than
    /// at the decoder's global 8K ceiling.
    remote_track_max_dimensions: HashMap<String, (u32, u32)>,
}

/// A track's binding to its native surface (spec §3.1: the per-track
/// association lives in the dispatch state). Cloned out under the dispatch lock
/// so `present()` runs without holding it.
#[cfg(feature = "vpx")]
#[derive(Clone)]
struct TrackSurfaceBinding {
    surface_id: super::native_render::SurfaceId,
    /// Shared with the [`super::native_render::SurfaceRegistry`]; the decode
    /// worker locks it per frame only to enqueue a handle.
    surface: super::native_render::SharedSurface,
    stream_id: String,
    track_id: String,
    /// App handle for the failure event (spec §3.7), captured at attach time.
    /// `None` only in headless unit tests, which cannot build an `AppHandle`;
    /// the live attach path always carries one.
    app: Option<AppHandle>,
    /// Consecutive `present()` failures; a streak past
    /// [`PRESENT_ERROR_STREAK`] tears the subscription down (spec §3.7).
    present_errors: Arc<AtomicU32>,
    /// Latched by the first successful `present()` to emit
    /// `media_native_render_first_frame` exactly once — the webview receives no
    /// frames on this route, so this event is what clears its poster state.
    first_frame_presented: Arc<AtomicBool>,
}

/// Consecutive `present()` errors that trip the native-render failure law
/// (spec §3.7: "a present() error streak (>30 consecutive)").
#[cfg(feature = "vpx")]
const PRESENT_ERROR_STREAK: u32 = 30;

/// Consecutive KEYFRAMES that fail to decode before the subscription is torn
/// down (spec §3.7). A keyframe is a self-contained resync point, so a decoder
/// that rejects one is wedged (e.g. a hardware decode session primed against a
/// previous encoder instance); each failure drops the decoder instance so the
/// next keyframe decodes on a fresh one. Failures 2+ therefore happened on
/// freshly created instances — the backend itself is broken, not merely stale —
/// and the streak tears the subscription down loudly.
#[cfg(feature = "vpx")]
const KEYFRAME_DECODE_FAILURE_LIMIT: u32 = 3;

#[cfg(feature = "vpx")]
impl Default for VideoDispatchState {
    fn default() -> Self {
        Self {
            remote_track_latest_frames: HashMap::new(),
            remote_track_sequences: HashMap::new(),
            remote_track_ssrcs: HashMap::new(),
            remote_track_prefer_encoded: std::collections::HashSet::new(),
            remote_track_channels: HashMap::new(),
            remote_track_viewports: HashMap::new(),
            remote_track_hidden: std::collections::HashSet::new(),
            remote_track_stored_at: HashMap::new(),
            remote_track_stream_high_water: HashMap::new(),
            remote_track_surfaces: HashMap::new(),
            remote_ssrc_track_bindings: HashMap::new(),
            remote_track_max_dimensions: HashMap::new(),
        }
    }
}

#[cfg(feature = "vpx")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledVideoFramePayload {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub is_keyframe: bool,
    /// Source codec of the stream (`vp9` / `av1` / `h264`).
    pub codec: String,
    /// Wire format of `data`: `i420` when the frame was natively decoded, or
    /// the encoded codec label (`vp9` / `h264` / `av1`) when passed through for
    /// the frontend to decode.
    pub format: String,
    pub width: u32,
    pub height: u32,
    /// YUV matrix / range the frame's luma-chroma encoding uses. Wire tag: 0 =
    /// BT.601, 1 = BT.709 (contract C1). The webview selects the matching YUV
    /// matrix in its WebGL shader / CPU converter from this. See
    /// [`encode_pulled_video_frame_binary`] (header byte 19).
    pub colorspace: u8,
    pub data: Vec<u8>,
}

#[cfg(feature = "vpx")]
fn video_reassembly_pool() -> &'static Mutex<HashMap<String, VideoReassemblyState>> {
    static POOL: OnceLock<Mutex<HashMap<String, VideoReassemblyState>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Last time the reassembly pool was swept for expired partial frames.
#[cfg(feature = "vpx")]
fn last_reassembly_sweep() -> &'static Mutex<Instant> {
    static LAST: OnceLock<Mutex<Instant>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(Instant::now()))
}

/// Map a wire `frame_id` onto a decoder presentation timestamp.
///
/// `frame_id` is an unauthenticated `u64`; a plain `as i64` wraps any value at
/// or above 2^63 to a negative number, which then goes straight into libvpx /
/// libavcodec timestamp state. Saturating keeps the value monotonic and
/// non-negative for every input.
#[cfg(feature = "vpx")]
fn frame_id_to_pts(frame_id: u64) -> i64 {
    i64::try_from(frame_id).unwrap_or(i64::MAX)
}

#[cfg(feature = "vpx")]
fn video_dispatch_state() -> &'static Mutex<VideoDispatchState> {
    static STATE: OnceLock<Mutex<VideoDispatchState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(VideoDispatchState::default()))
}

/// Per-remote-track native decoders, keyed by `make_track_key(stream, track)`.
///
/// The map lock is held ONLY for the lookup/insert of the per-track
/// `Arc<Mutex<Box<dyn VideoDecoder>>>`; the actual (synchronous) decode locks the
/// inner per-track mutex, so decodes on different tracks never serialize against
/// each other. One decode worker owns each track's decoder, so the inner mutex is
/// effectively uncontended; it exists only so [`remove_remote_video_decoder`] can
/// drop the decoder (releasing libvpx state) from another task.
#[cfg(feature = "vpx")]
#[allow(clippy::type_complexity)]
fn video_decoder_pool() -> &'static Mutex<
    HashMap<String, Arc<Mutex<Box<dyn paracord_codec::video::decoder::VideoDecoder>>>>,
> {
    static POOL: OnceLock<
        Mutex<HashMap<String, Arc<Mutex<Box<dyn paracord_codec::video::decoder::VideoDecoder>>>>>,
    > = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Get (or lazily create) the per-track decoder handle. Returns `None` when no
/// native decoder backend exists for `codec` (then the caller falls back to
/// encoded passthrough). The map lock is released before the handle is returned.
#[cfg(feature = "vpx")]
fn decoder_handle_for_track(
    track_key: &str,
    codec: paracord_codec::video::VideoCodec,
) -> Option<Arc<Mutex<Box<dyn paracord_codec::video::decoder::VideoDecoder>>>> {
    use paracord_codec::video::decoder::{create_decoder_with_output, DecodeOutput};
    use paracord_codec::video::DecoderConfig;

    // Read the negotiated resolution BEFORE taking the decoder-pool lock, so the
    // dispatch-state lock is never nested inside it (every other site takes the
    // dispatch lock first and releases it before touching the decoder pool).
    let max_dimensions = track_max_dimensions(track_key);

    let mut pool = video_decoder_pool().lock().ok()?;
    if let Some(handle) = pool.get(track_key) {
        return Some(handle.clone());
    }
    // This handle only ever feeds the native-surface route (deliver_decoded_frame
    // → surface.present), so the decoder must emit handles the platform surface
    // can present, chosen once at construction (spec §3.2). macOS'
    // AVSampleBufferDisplayLayer accepts ONLY CVPixelBuffer, so its decoder must
    // run GPU-resident (spec §3.5); on macOS a codec without a VideoToolbox GPU
    // decoder returns None here and deliver_decoded_frame fails the subscription
    // loudly (spec §3.7) rather than presenting a CPU frame the layer rejects. The
    // Linux GLArea surface also imports the CPU-I420 tier-2 floor (spec §3.4), so
    // CPU output is the deterministic choice there.
    #[cfg(target_os = "macos")]
    let output = DecodeOutput::Gpu;
    #[cfg(not(target_os = "macos"))]
    let output = DecodeOutput::Cpu;
    // Cap the decoder at the resolution this peer actually announced when it
    // published the track. Without it the only ceiling is the decoder's global
    // 8K constant, so a peer publishing a 320x180 layer can still make every
    // frame allocate 8K planes (and, on the VP9 path, buy a 16-thread decoder)
    // from a few hundred bytes of crafted bitstream header.
    let config = DecoderConfig {
        max_dimensions,
        ..DecoderConfig::default()
    };
    let decoder = create_decoder_with_output(codec, config, output).ok()?;
    let handle = Arc::new(Mutex::new(decoder));
    pool.insert(track_key.to_string(), handle.clone());
    Some(handle)
}

/// Remove and drop the native decoder for a remote track and stop its decode
/// worker. Dropping a `Vp9Decoder` calls `vpx_codec_destroy`, releasing libvpx
/// state. Idempotent: safe to call for a track that never had a decoder/worker.
#[cfg(feature = "vpx")]
pub fn remove_remote_video_decoder(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    stop_decode_worker(&key);
    if let Ok(mut pool) = video_decoder_pool().lock() {
        pool.remove(&key);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn remove_remote_video_decoder(_stream_id: &str, _track_id: &str) {}

/// Drop ONLY a track's decoder instance, leaving its decode worker (and any
/// surface binding) alive. Used by the wedged-decoder recovery inside the worker
/// itself: after a keyframe fails to decode, the next dispatched keyframe lazily
/// creates a fresh instance via [`decoder_handle_for_track`]. An in-flight
/// decode holding the instance's `Arc` finishes on the old instance and then
/// drops it.
#[cfg(feature = "vpx")]
fn drop_track_decoder_instance(track_key: &str) {
    if let Ok(mut pool) = video_decoder_pool().lock() {
        pool.remove(track_key);
    }
}

/// Process-exit teardown: abort every decode worker and drop every native
/// decoder instance. Hardware decode sessions (NVDEC) MUST be released before
/// libc `exit()` runs — libnvcuvid's atexit handler aborts the process when
/// sessions are still alive on other threads (the 2026-07-07 SIGABRT
/// coredumps on quit). Called from the Tauri `RunEvent::Exit` hook.
#[cfg(feature = "vpx")]
pub fn shutdown_all_decode_state() {
    if let Ok(mut workers) = decode_workers().lock() {
        for (_, worker) in workers.drain() {
            worker.shutdown.notify_waiters();
            worker.handle.abort();
        }
    }
    if let Ok(mut pool) = video_decoder_pool().lock() {
        pool.clear();
    }
}

#[cfg(not(feature = "vpx"))]
pub fn shutdown_all_decode_state() {}

// ── Per-track decode workers ─────────────────────────────────────────────────

/// A reassembled encoded frame handed to a per-track decode worker.
#[cfg(feature = "vpx")]
struct ReassembledVideoFrame {
    frame_id: u64,
    timestamp_us: u64,
    encoded: paracord_codec::video::EncodedFrame,
    simulcast_layer: u8,
}

/// Where a decode worker sends its keyframe request when the decoder cannot make
/// progress (or the input channel overflowed for a native-decode track).
#[cfg(feature = "vpx")]
#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
enum KeyframeSink {
    /// Remote track: ask the publisher via the relay, and mirror the request to
    /// the webview so it can act too.
    Upstream {
        conn: quinn::Connection,
        app: AppHandle,
        stream_id: StreamId,
        track_id: TrackId,
    },
    /// Our own locally-encoded track (self-view): force the local encoder to emit
    /// an intra frame directly — no relay round trip.
    LocalEncoder { force_keyframe: Arc<AtomicBool> },
}

#[cfg(feature = "vpx")]
impl KeyframeSink {
    fn request(&self, layer_id: u8) {
        match self {
            KeyframeSink::Upstream {
                conn,
                app,
                stream_id,
                track_id,
            } => {
                super::events::emit_media_request_keyframe(
                    app,
                    &stream_id.0,
                    &track_id.0,
                    Some(layer_id),
                );
                let request = paracord_transport::control::ControlMessage::RequestKeyframe {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    layer_id: Some(layer_id),
                };
                let conn = conn.clone();
                tokio::spawn(async move {
                    if let Err(err) = send_control_message(&conn, &request).await {
                        tracing::debug!("failed to send keyframe request upstream: {err}");
                    }
                });
            }
            KeyframeSink::LocalEncoder { force_keyframe } => {
                force_keyframe.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// Handle to a per-track decode worker task.
#[cfg(feature = "vpx")]
struct DecodeWorker {
    tx: mpsc::Sender<ReassembledVideoFrame>,
    shutdown: Arc<Notify>,
    handle: JoinHandle<()>,
    /// Set true when a native-decode track must drop deltas until the next
    /// keyframe (after an input-channel overflow or an undecodable frame).
    drop_until_keyframe: Arc<AtomicBool>,
}

#[cfg(feature = "vpx")]
fn decode_workers() -> &'static Mutex<HashMap<String, DecodeWorker>> {
    static WORKERS: OnceLock<Mutex<HashMap<String, DecodeWorker>>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Abort and forget the decode worker for `track_key`. Idempotent.
#[cfg(feature = "vpx")]
fn stop_decode_worker(track_key: &str) {
    let worker = decode_workers()
        .lock()
        .ok()
        .and_then(|mut workers| workers.remove(track_key));
    if let Some(worker) = worker {
        worker.shutdown.notify_waiters();
        worker.handle.abort();
    }
}

/// Dispatch a reassembled frame to `track_key`'s decode worker, creating the
/// worker on first use with the given keyframe sink. Applies the overflow
/// policy: drop-newest for encoded-passthrough tracks (the webview decoder has
/// its own queue), drop-until-keyframe + keyframe request for native-decode
/// tracks.
#[cfg(feature = "vpx")]
fn dispatch_frame_to_worker(track_key: &str, frame: ReassembledVideoFrame, sink: KeyframeSink) {
    let layer_id = frame.simulcast_layer;
    let mut workers = match decode_workers().lock() {
        Ok(workers) => workers,
        Err(_) => return,
    };
    if !workers.contains_key(track_key) && workers.len() >= MAX_DECODE_WORKERS {
        tracing::warn!(
            track_key,
            workers = workers.len(),
            "decode worker cap reached; refusing to spawn another"
        );
        return;
    }
    let worker = workers
        .entry(track_key.to_string())
        .or_insert_with(|| spawn_decode_worker(track_key.to_string(), sink.clone()));
    let result = worker.tx.try_send(frame);
    // Clone the Arc so the `&mut worker` borrow of the map ends here and the
    // Closed arm can `workers.remove(..)` without a borrow conflict.
    let drop_until_keyframe = worker.drop_until_keyframe.clone();
    match result {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            if track_prefers_encoded(track_key) {
                // Drop-newest: the webview decoder tolerates the gap.
            } else {
                drop_until_keyframe.store(true, Ordering::SeqCst);
                sink.request(layer_id);
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            // Worker exited; drop the stale handle so the next frame respawns it.
            workers.remove(track_key);
        }
    }
}

#[cfg(feature = "vpx")]
fn spawn_decode_worker(track_key: String, sink: KeyframeSink) -> DecodeWorker {
    let (tx, mut rx) = mpsc::channel::<ReassembledVideoFrame>(DECODE_CHANNEL_DEPTH);
    let shutdown = Arc::new(Notify::new());
    let drop_until_keyframe = Arc::new(AtomicBool::new(false));

    let worker_shutdown = shutdown.clone();
    let worker_duk = drop_until_keyframe.clone();
    let handle = tokio::spawn(async move {
        // Reorder stage: hold at most REORDER_MAX_HELD frames / REORDER_HOLD by
        // frame_id, deliver in order, drop anything older than last-delivered.
        let mut reorder: BTreeMap<u64, (Instant, ReassembledVideoFrame)> = BTreeMap::new();
        let mut last_delivered: Option<u64> = None;
        // Consecutive keyframes that failed to decode (wedged-decoder recovery;
        // see KEYFRAME_DECODE_FAILURE_LIMIT). Reset by any successful decode.
        let mut keyframe_failures: u32 = 0;
        loop {
            let next_deadline = reorder
                .values()
                .next()
                .map(|(arrived, _)| *arrived + REORDER_HOLD);
            tokio::select! {
                _ = worker_shutdown.notified() => break,
                msg = rx.recv() => {
                    let Some(frame) = msg else { break };
                    if frame.encoded.is_keyframe {
                        // A keyframe is a self-contained resync point. Accept it
                        // even when a slower (reliable) stream path let later
                        // deltas overtake it and advance last_delivered past it:
                        // drop anything older and rebase onto the keyframe so it
                        // and every following frame still decode. This is what
                        // turns a loss-delayed keyframe from a permanent stall
                        // (the keyframe-request death spiral) into a recovery.
                        reorder.retain(|&fid, _| fid > frame.frame_id);
                        last_delivered = frame.frame_id.checked_sub(1);
                    } else if last_delivered.is_some_and(|last| frame.frame_id <= last) {
                        continue; // older than something already delivered: loss.
                    }
                    reorder.insert(frame.frame_id, (Instant::now(), frame));
                    drain_reorder(&track_key, &sink, &worker_duk, &mut keyframe_failures, &mut reorder, &mut last_delivered, false).await;
                }
                _ = sleep_until_opt(next_deadline) => {
                    drain_reorder(&track_key, &sink, &worker_duk, &mut keyframe_failures, &mut reorder, &mut last_delivered, true).await;
                }
            }
        }
    });

    DecodeWorker {
        tx,
        shutdown,
        handle,
        drop_until_keyframe,
    }
}

/// Sleep until `deadline`, or forever when `None` (no buffered frame).
#[cfg(feature = "vpx")]
async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => {
            let now = Instant::now();
            if deadline > now {
                tokio::time::sleep(deadline - now).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// Deliver as many buffered frames as are ready: the contiguous next frame, or —
/// when `force` (a hold deadline elapsed) or the buffer is over capacity — the
/// oldest buffered frame regardless of gaps.
#[cfg(feature = "vpx")]
async fn drain_reorder(
    track_key: &str,
    sink: &KeyframeSink,
    drop_until_keyframe: &Arc<AtomicBool>,
    keyframe_failures: &mut u32,
    reorder: &mut BTreeMap<u64, (Instant, ReassembledVideoFrame)>,
    last_delivered: &mut Option<u64>,
    force: bool,
) {
    let mut force_oldest = force;
    while let Some((&frame_id, _)) = reorder.iter().next() {
        let contiguous = last_delivered.is_none_or(|last| frame_id == last.wrapping_add(1));
        let over_capacity = reorder.len() > REORDER_MAX_HELD;
        if !(contiguous || over_capacity || force_oldest) {
            break;
        }
        force_oldest = false;
        let (_, frame) = reorder.remove(&frame_id).expect("frame present");
        *last_delivered = Some(frame_id);
        deliver_decoded_frame(
            track_key,
            sink,
            drop_until_keyframe,
            keyframe_failures,
            frame,
        )
        .await;
    }
}

/// Decode (or pass through) one delivered frame, honoring visibility (N4),
/// drop-until-keyframe, and the per-subscription route (spec §2):
/// - **native-surface**: a surface is bound → decode to a GPU-resident
///   [`DecodedFrameHandle`] and `present()` it on the surface. Nothing crosses
///   IPC. (spec §3.6/§3.7)
/// - **webcodecs-passthrough**: `prefer_encoded` → store the encoded frame and
///   push it over the frame channel for the webview's WebCodecs decoder.
///
/// The old raw-I420 store/push path (native decode → downscale-to-viewport →
/// `format:"i420"` over the channel) is **deleted**: the frame channel now
/// carries only encoded passthrough frames.
#[cfg(feature = "vpx")]
async fn deliver_decoded_frame(
    track_key: &str,
    sink: &KeyframeSink,
    drop_until_keyframe: &Arc<AtomicBool>,
    keyframe_failures: &mut u32,
    frame: ReassembledVideoFrame,
) {
    let hidden = track_is_hidden(track_key);

    // ── native-surface route ────────────────────────────────────────────────
    if let Some(binding) = track_surface_binding(track_key) {
        // Hidden ⇒ decode paused (spec §2). The surface keeps showing its last
        // frame; a resume requests a fresh keyframe (see set_stream_video_visibility).
        if hidden {
            return;
        }
        // Drop deltas until a keyframe re-establishes the decoder.
        if drop_until_keyframe.load(Ordering::SeqCst) {
            if frame.encoded.is_keyframe {
                drop_until_keyframe.store(false, Ordering::SeqCst);
            } else {
                return;
            }
        }
        let Some(decoder) = decoder_handle_for_track(track_key, frame.encoded.codec) else {
            // A native-surface subscription with no decoder backend for its codec
            // cannot render — fail loudly (spec §3.7); never fall back to raw IPC.
            fail_native_surface(
                &binding,
                track_key,
                &format!(
                    "no native decoder backend for codec {}",
                    codec_label(frame.encoded.codec)
                ),
            );
            return;
        };
        let layer = frame.simulcast_layer;
        let was_keyframe = frame.encoded.is_keyframe;
        let encoded = frame.encoded;
        // The synchronous decode runs on the blocking pool; awaiting it here
        // preserves this worker's strict FIFO ordering. The decoder yields
        // GPU-resident (or tier-2 CPU-I420) handles via `decode_to_handles`.
        let outcome = tokio::task::spawn_blocking(move || {
            let mut guard = decoder.lock().unwrap_or_else(|e| e.into_inner());
            decode_frame_to_handles(guard.as_mut(), &encoded)
        })
        .await
        .unwrap_or(HandleDecodeResult::NeedKeyframe);

        match outcome {
            HandleDecodeResult::Frames(handles) => {
                *keyframe_failures = 0;
                for handle in handles {
                    let present = {
                        let mut surface = binding.surface.lock().unwrap_or_else(|e| e.into_inner());
                        surface.present(handle)
                    };
                    match present {
                        Ok(()) => {
                            binding.present_errors.store(0, Ordering::Relaxed);
                            // First visible frame on this surface: tell the
                            // webview (it sees no frames on this route) so the
                            // poster clears and the tile reads as live.
                            if !binding.first_frame_presented.swap(true, Ordering::Relaxed) {
                                native_diag(
                                    binding.app.as_ref(),
                                    &format!(
                                        "native-render: first frame presented track={track_key}"
                                    ),
                                );
                                if let Some(app) = binding.app.as_ref() {
                                    super::events::emit_media_native_render_first_frame(
                                        app,
                                        &binding.stream_id,
                                        &binding.track_id,
                                    );
                                }
                            }
                        }
                        Err(err) => {
                            let streak = binding.present_errors.fetch_add(1, Ordering::Relaxed) + 1;
                            if streak > PRESENT_ERROR_STREAK {
                                fail_native_surface(
                                    &binding,
                                    track_key,
                                    &format!("present failed {streak}× in a row: {err}"),
                                );
                                return;
                            }
                        }
                    }
                }
            }
            HandleDecodeResult::NeedKeyframe => {
                if was_keyframe {
                    // A keyframe is a self-contained resync point: a decoder that
                    // cannot decode one is wedged (e.g. a hardware decode session
                    // primed against a previous encoder instance), and merely
                    // re-requesting keyframes would fail at frame rate forever.
                    // Drop the instance so the next keyframe decodes on a fresh
                    // one; if fresh instances keep failing, the backend itself is
                    // broken — tear the subscription down loudly (spec §3.7).
                    *keyframe_failures += 1;
                    drop_track_decoder_instance(track_key);
                    native_diag(
                        binding.app.as_ref(),
                        &format!(
                            "native-decode: keyframe failed to decode ({keyframe_failures}x); \
                             decoder instance dropped track={track_key}"
                        ),
                    );
                    if *keyframe_failures >= KEYFRAME_DECODE_FAILURE_LIMIT {
                        fail_native_surface(
                            &binding,
                            track_key,
                            &format!(
                                "keyframe failed to decode {keyframe_failures}x on fresh \
                                 decoder instances"
                            ),
                        );
                        return;
                    }
                }
                drop_until_keyframe.store(true, Ordering::SeqCst);
                sink.request(layer);
            }
            HandleDecodeResult::Drop => {}
        }
        return;
    }

    // ── webcodecs-passthrough route ─────────────────────────────────────────
    // While hidden, only keyframes are stored (never pushed) so a resume can
    // paint; deltas are dropped without work.
    if hidden && !frame.encoded.is_keyframe {
        return;
    }
    if track_prefers_encoded(track_key) {
        let source_codec = codec_label(frame.encoded.codec);
        let colorspace = encoded_frame_colorspace(&frame.encoded);
        store_pulled_video_frame(
            track_key,
            frame.timestamp_us,
            frame.encoded.is_keyframe,
            source_codec,
            source_codec,
            frame.encoded.width,
            frame.encoded.height,
            colorspace,
            frame.encoded.data,
            !hidden,
        );
        return;
    }

    // Neither a surface nor passthrough: the raw-I420 path is deleted (spec §2),
    // so there is no consumer for this frame yet (a native-surface subscription
    // whose `native_render_attach` has not landed, or a trailing frame after
    // detach). Drop it — never store raw I420 over IPC.
    if VIDEO_STORE_DEBUG_COUNT.load(Ordering::Relaxed) < 24 {
        tracing::debug!(
            track = track_key,
            "dropping native-decode frame: no surface bound and not passthrough"
        );
    }
}

/// Result of decoding one frame to GPU-resident handles: the decoded handles, a
/// request for a keyframe, or an unusable frame to silently drop.
#[cfg(feature = "vpx")]
enum HandleDecodeResult {
    Frames(Vec<paracord_codec::video::DecodedFrameHandle>),
    NeedKeyframe,
    Drop,
}

/// Run one synchronous decode into [`DecodedFrameHandle`]s (spec §3.2). No
/// viewport downscale: the native surface scales the frame into its tile on the
/// GPU, so the raw CPU downscale-to-viewport step is deleted on this path.
#[cfg(feature = "vpx")]
fn decode_frame_to_handles(
    decoder: &mut dyn paracord_codec::video::decoder::VideoDecoder,
    encoded: &paracord_codec::video::EncodedFrame,
) -> HandleDecodeResult {
    use paracord_codec::video::VideoError;

    match decoder.decode_to_handles(encoded) {
        Ok(handles) if !decoder.needs_keyframe() => HandleDecodeResult::Frames(handles),
        Ok(_) => HandleDecodeResult::NeedKeyframe,
        Err(VideoError::KeyframeRequired | VideoError::DecodeFailed(_)) => {
            HandleDecodeResult::NeedKeyframe
        }
        Err(_) => HandleDecodeResult::Drop,
    }
}

/// Colorspace tag for an encoded frame (contract C1): the encoder signals what
/// it actually produced, so this reads the frame's field directly rather than
/// assuming the project default.
#[cfg(feature = "vpx")]
fn encoded_frame_colorspace(encoded: &paracord_codec::video::EncodedFrame) -> u8 {
    encoded.colorspace.header_tag()
}

#[cfg(feature = "vpx")]
fn track_is_hidden(track_key: &str) -> bool {
    video_dispatch_state()
        .lock()
        .ok()
        .is_some_and(|state| state.remote_track_hidden.contains(track_key))
}

/// Subscriber viewport (tile render size) for a track. Retained for the relay
/// layer-selection hint (spec §4.2); the native-surface route no longer
/// CPU-downscales to it (the GPU scales into the tile), so this reader is a
/// diagnostic/hint accessor only.
#[cfg(feature = "vpx")]
#[allow(dead_code)]
fn track_viewport(track_key: &str) -> Option<(u32, u32)> {
    video_dispatch_state()
        .lock()
        .ok()
        .and_then(|state| state.remote_track_viewports.get(track_key).copied())
}

/// The native-surface binding for a track, if the `native-surface` route was
/// selected via [`attach_native_surface`]. Cloned out under the lock so the
/// decode worker can `present()` without holding the dispatch mutex.
#[cfg(feature = "vpx")]
fn track_surface_binding(track_key: &str) -> Option<TrackSurfaceBinding> {
    video_dispatch_state()
        .lock()
        .ok()
        .and_then(|state| state.remote_track_surfaces.get(track_key).cloned())
}

/// Bind a native surface to a track and select the `native-surface` route
/// (spec §3.6). Called by `native_render_attach`. Clears any passthrough flag
/// and drops any native decoder created before the route was known so the fresh
/// worker decodes to handles.
#[cfg(feature = "vpx")]
pub fn attach_native_surface(
    stream_id: &str,
    track_id: &str,
    surface_id: super::native_render::SurfaceId,
    surface: super::native_render::SharedSurface,
    app: AppHandle,
) {
    let key = make_track_key(stream_id, track_id);
    let binding = TrackSurfaceBinding {
        surface_id,
        surface,
        stream_id: stream_id.to_string(),
        track_id: track_id.to_string(),
        app: Some(app),
        present_errors: Arc::new(AtomicU32::new(0)),
        first_frame_presented: Arc::new(AtomicBool::new(false)),
    };
    if let Ok(mut state) = video_dispatch_state().lock() {
        // The native-surface route decodes natively; it must not also be marked
        // as webview passthrough.
        state.remote_track_prefer_encoded.remove(&key);
        state.remote_track_surfaces.insert(key, binding);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn attach_native_surface(
    _stream_id: &str,
    _track_id: &str,
    _surface_id: super::native_render::SurfaceId,
    _surface: super::native_render::SharedSurface,
    _app: AppHandle,
) {
}

/// Remove a track's native-surface binding by track identity (idempotent).
/// Dropping the binding releases the dispatch layer's `Arc`; the surface's
/// backend `Drop` runs once the registry has also released its `Arc`. Available
/// for track-keyed teardown flows (and exercised by tests); the command path
/// detaches by [`SurfaceId`] instead.
#[cfg(feature = "vpx")]
#[allow(dead_code)]
pub fn detach_native_surface(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        state.remote_track_surfaces.remove(&key);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn detach_native_surface(_stream_id: &str, _track_id: &str) {}

/// Remove a track's native-surface binding by [`SurfaceId`] (the
/// `native_render_detach` command path). Idempotent.
#[cfg(feature = "vpx")]
pub fn detach_native_surface_by_id(surface_id: super::native_render::SurfaceId) {
    if let Ok(mut state) = video_dispatch_state().lock() {
        state
            .remote_track_surfaces
            .retain(|_, binding| binding.surface_id != surface_id);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn detach_native_surface_by_id(_surface_id: super::native_render::SurfaceId) {}

/// Tear down a native-surface subscription after an unrecoverable render error
/// (spec §3.7): emit `media_native_render_failed`, remove the surface from the
/// registry and the dispatch binding — never fall back to raw IPC, never
/// silently blank. The decode worker keeps running but, with no surface bound,
/// subsequent frames hit the "no consumer" drop; the TS side completes teardown
/// (detach + unsubscribe) on the event.
#[cfg(feature = "vpx")]
fn fail_native_surface(binding: &TrackSurfaceBinding, track_key: &str, reason: &str) {
    if let Some(app) = binding.app.as_ref() {
        super::events::emit_media_native_render_failed(
            app,
            &binding.stream_id,
            &binding.track_id,
            reason,
        );
    }
    native_diag(
        binding.app.as_ref(),
        &format!("native_render failed: track={track_key} reason={reason}"),
    );
    super::native_render::registry().remove(binding.surface_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        state
            .remote_track_surfaces
            .retain(|_, b| b.surface_id != binding.surface_id);
    }
}

/// Set the subscriber viewport (tile render size) for a track's native-decode
/// downscale. Called from `media_register_track_subscription`.
#[cfg(feature = "vpx")]
pub fn set_stream_video_viewport(stream_id: &str, track_id: &str, width: u32, height: u32) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        if width == 0 || height == 0 {
            state.remote_track_viewports.remove(&key);
        } else {
            state.remote_track_viewports.insert(key, (width, height));
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub fn set_stream_video_viewport(_stream_id: &str, _track_id: &str, _width: u32, _height: u32) {}

/// Toggle a track's visibility (N4 / contract C2). While hidden, the decode
/// worker skips decode+push and stores keyframes only. On resume, push the
/// latest stored frame immediately and report whether the caller must request a
/// keyframe (the stored frame is a delta, missing, or stale).
#[cfg(feature = "vpx")]
pub fn set_stream_video_visibility(stream_id: &str, track_id: &str, visible: bool) -> bool {
    let key = make_track_key(stream_id, track_id);
    // Native-surface route: hidden pauses decode via `remote_track_hidden`; the
    // surface's own visibility is driven by the TS geometry reporter
    // (`native_render_update_geometry` with the occlusion `visible` flag, spec
    // §3.6). On resume there is no stored frame to replay, so request a fresh
    // keyframe to refresh the surface promptly.
    if track_surface_binding(&key).is_some() {
        if let Ok(mut state) = video_dispatch_state().lock() {
            if visible {
                state.remote_track_hidden.remove(&key);
            } else {
                state.remote_track_hidden.insert(key.clone());
            }
        }
        return visible;
    }
    let replay = {
        let mut state = match video_dispatch_state().lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        if visible {
            state.remote_track_hidden.remove(&key);
            let stale = state
                .remote_track_stored_at
                .get(&key)
                .is_none_or(|stored| stored.elapsed() > VISIBILITY_STALE_AFTER);
            let frame = state.remote_track_latest_frames.get(&key).cloned();
            let channel = state.remote_track_channels.get(&key).cloned();
            let need_keyframe = match &frame {
                Some(frame) => stale || !frame.is_keyframe,
                None => true,
            };
            Some((frame, channel, need_keyframe))
        } else {
            state.remote_track_hidden.insert(key.clone());
            None
        }
    };
    match replay {
        Some((frame, channel, need_keyframe)) => {
            if let (Some(frame), Some(channel)) = (frame, channel) {
                push_frame_over_channel(&key, &channel, frame);
            }
            need_keyframe
        }
        None => false,
    }
}

#[cfg(not(feature = "vpx"))]
pub fn set_stream_video_visibility(_stream_id: &str, _track_id: &str, _visible: bool) -> bool {
    false
}

/// Clear ALL process-wide remote-video state: abort every decode worker, drop
/// every native decoder, empty the reassembly buffers, and forget every stored
/// frame / channel / viewport / visibility entry. Called on session teardown
/// (N2) so nothing replays into the next session under the deterministic keys.
#[cfg(feature = "vpx")]
pub fn clear_all_stream_video_state() {
    let workers: Vec<DecodeWorker> = decode_workers()
        .lock()
        .ok()
        .map(|mut workers| workers.drain().map(|(_, worker)| worker).collect())
        .unwrap_or_default();
    for worker in workers {
        worker.shutdown.notify_waiters();
        worker.handle.abort();
    }
    if let Ok(mut pool) = video_decoder_pool().lock() {
        pool.clear();
    }
    if let Ok(mut pool) = video_reassembly_pool().lock() {
        pool.clear();
    }
    if let Ok(mut state) = video_dispatch_state().lock() {
        *state = VideoDispatchState::default();
    }
    // Drop every native surface too (spec §3.1 teardown): resetting the dispatch
    // state above released the per-track `Arc`s; clearing the registry releases
    // the other half so each backend's `Drop` runs the toolkit teardown.
    super::native_render::registry().clear();
}

#[cfg(not(feature = "vpx"))]
pub fn clear_all_stream_video_state() {
    super::native_render::registry().clear();
}

/// Reset the self-view decode chain for a local track whose encoder is being
/// (re)started or stopped. A live decode worker/decoder was primed against the
/// OLD bitstream — reference frames, hardware decode session, pts base — and a
/// new encoder instance's frames would wedge it (every `cuvidDecodePicture`
/// failing, including on forced keyframes: the 2026-07-07 storm). Dropping the
/// worker and decoder here is deterministic: the next dispatched frame respawns
/// both, and the fresh decoder starts by requesting a keyframe.
#[cfg(feature = "vpx")]
fn reset_local_self_view_decode(session: &NativeMediaSession, is_screen: bool) {
    let stream_id = local_video_stream_id(session, is_screen);
    let track_id = local_video_track_id(is_screen);
    remove_remote_video_decoder(&stream_id.0, &track_id.0);
}

#[cfg(feature = "vpx")]
pub fn register_stream_video_subscription(
    stream_id: &str,
    track_id: &str,
    ssrc: u32,
    prefer_encoded: bool,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    let key = make_track_key(stream_id, track_id);
    // Register the push channel and read back the latest stored frame (if any)
    // so a re-subscribe or a freshly-attached canvas paints immediately instead
    // of waiting for the sender's next frame. The replay push happens outside the
    // dispatch-state mutex, like every other channel send.
    let replay = {
        let mut state = video_dispatch_state()
            .lock()
            .map_err(|_| "video dispatch state lock poisoned".to_string())?;
        state.remote_track_ssrcs.insert(key.clone(), ssrc);
        if prefer_encoded {
            state.remote_track_prefer_encoded.insert(key.clone());
        } else {
            state.remote_track_prefer_encoded.remove(&key);
        }
        state
            .remote_track_channels
            .insert(key.clone(), channel.clone());
        state.remote_track_latest_frames.get(&key).cloned()
    };
    if prefer_encoded {
        // Any native decoder previously created for this track is dead weight
        // once the webview decodes the stream itself.
        remove_remote_video_decoder(stream_id, track_id);
    }
    if let Some(frame) = replay {
        push_frame_over_channel(&key, &channel, frame);
    }
    Ok(())
}

#[cfg(feature = "vpx")]
fn track_prefers_encoded(track_key: &str) -> bool {
    video_dispatch_state()
        .lock()
        .ok()
        .is_some_and(|state| state.remote_track_prefer_encoded.contains(track_key))
}

#[cfg(feature = "vpx")]
pub fn unregister_stream_video_subscription(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        state.remote_track_latest_frames.remove(&key);
        state.remote_track_sequences.remove(&key);
        state.remote_track_ssrcs.remove(&key);
        state.remote_track_prefer_encoded.remove(&key);
        // Dropping our clone lets the channel close once the webview side is
        // gone too; no more frames are pushed for this track.
        state.remote_track_channels.remove(&key);
        // If this track was on the native-surface route, drop its binding too so
        // the surface is not left orphaned when the subscription goes away.
        if let Some(binding) = state.remote_track_surfaces.remove(&key) {
            super::native_render::registry().remove(binding.surface_id);
        }
    }
    remove_remote_video_decoder(stream_id, track_id);
}

/// Read accessor for the latest stored frame of a remote track. Frames are now
/// pushed to the webview over its channel as they arrive, so this is no longer
/// on the delivery hot path — it is retained as a test/diagnostic accessor.
#[cfg(feature = "vpx")]
#[allow(dead_code)]
pub fn pull_latest_remote_stream_video_frame(
    stream_id: &str,
    track_id: &str,
    after_sequence: Option<u64>,
) -> Option<PulledVideoFramePayload> {
    let key = make_track_key(stream_id, track_id);
    let state = video_dispatch_state().lock().ok()?;
    let frame = state.remote_track_latest_frames.get(&key)?.clone();
    if after_sequence.is_some_and(|last| frame.sequence <= last) {
        return None;
    }
    Some(frame)
}

#[cfg(feature = "vpx")]
fn format_label_to_tag(format: &str) -> u8 {
    match format {
        "i420" => 0,
        "vp9" => 1,
        "h264" => 2,
        "av1" => 3,
        "raw" => 4,
        "bgra" => 5,
        "rgba" => 6,
        _ => 4,
    }
}

#[cfg(feature = "vpx")]
fn codec_label_to_tag(codec: &str) -> u8 {
    match codec {
        "vp9" => 1,
        "h264" => 2,
        "av1" => 3,
        "raw" => 4,
        _ => 0,
    }
}

/// Pack a pulled frame for Tauri IPC as raw bytes (no base64).
///
/// Layout (all little-endian):
///   sequence u64 | timestamp_us u64 | is_keyframe u8 | format_tag u8 |
///   codec_tag u8 | colorspace u8 | width u32 | height u32 | payload
///
/// Byte 19 (the former reserved byte) carries the colorspace tag per contract
/// C1: 0 = BT.601, 1 = BT.709. The webview parses it and picks the matching YUV
/// matrix in its WebGL shader and CPU fallback converter.
#[cfg(feature = "vpx")]
pub fn encode_pulled_video_frame_binary(frame: PulledVideoFramePayload) -> Vec<u8> {
    let mut buf = Vec::with_capacity(PULLED_VIDEO_FRAME_HEADER_SIZE + frame.data.len());
    buf.extend_from_slice(&frame.sequence.to_le_bytes());
    buf.extend_from_slice(&frame.timestamp_us.to_le_bytes());
    buf.push(u8::from(frame.is_keyframe));
    buf.push(format_label_to_tag(&frame.format));
    buf.push(codec_label_to_tag(&frame.codec));
    buf.push(frame.colorspace);
    buf.extend_from_slice(&frame.width.to_le_bytes());
    buf.extend_from_slice(&frame.height.to_le_bytes());
    buf.extend_from_slice(&frame.data);
    buf
}

/// One-shot snapshot of a track's dispatch state, taken under a single lock
/// (N12a): `(has_subscriber, prefers_encoded, sink_primed, hidden)`.
///
/// `sink_primed` answers "may the self-view send this track a delta frame?".
/// On the passthrough route that means a frame is already stored (the webview
/// decoder started from a keyframe). On the native-surface route the frame
/// store is never populated — the decode worker owns keyframe recovery
/// (drop-until-keyframe + the `LocalEncoder` sink forcing our own encoder) —
/// so a bound surface is always primed. Gating the surface route on the store
/// forced a keyframe every other frame, permanently (the black-screen /
/// keyframe ping-pong bug of 2026-07-07).
#[cfg(feature = "vpx")]
fn video_dispatch_snapshot(track_key: &str) -> (bool, bool, bool, bool) {
    match video_dispatch_state().lock() {
        Ok(state) => (
            // A native-surface binding counts as a subscriber too (spec §2/§3.6):
            // the self-view render loop must see it to feed the surface.
            state.remote_track_ssrcs.contains_key(track_key)
                || state.remote_track_surfaces.contains_key(track_key),
            state.remote_track_prefer_encoded.contains(track_key),
            state.remote_track_latest_frames.contains_key(track_key)
                || state.remote_track_surfaces.contains_key(track_key),
            state.remote_track_hidden.contains(track_key),
        ),
        Err(_) => (false, false, false, false),
    }
}

/// Encode `payload` to the packed binary wire format and push it to the webview
/// over its subscription channel. Callers must hold NO locks: `channel.send`
/// dispatches to the webview event loop.
#[cfg(feature = "vpx")]
fn push_frame_over_channel(
    track_key: &str,
    channel: &tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    payload: PulledVideoFramePayload,
) {
    let bytes = encode_pulled_video_frame_binary(payload);
    if let Err(err) = channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes)) {
        tracing::debug!(
            track = track_key,
            error = %err,
            "failed to push video frame over subscription channel"
        );
    }
}

#[cfg(feature = "vpx")]
fn make_track_key(stream_id: &str, track_id: &str) -> String {
    format!("{stream_id}:{track_id}")
}

#[cfg(feature = "vpx")]
pub(super) fn codec_label(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::Vp9 => "vp9",
        VideoCodec::Av1 => "av1",
        VideoCodec::H264 => "h264",
    }
}

#[cfg(feature = "vpx")]
fn transport_codec_to_native(codec: TransportVideoCodec) -> VideoCodec {
    match codec {
        TransportVideoCodec::Vp9 => VideoCodec::Vp9,
        TransportVideoCodec::Av1 => VideoCodec::Av1,
        TransportVideoCodec::H264 => VideoCodec::H264,
    }
}

/// Pick the highest-preference codec that every remote participant can decode.
///
/// This must use `try_lock` rather than `blocking_lock`: it is reachable from
/// the camera/screen encoder threads' `block_on` phases running on tokio worker
/// threads, where `blocking_lock` panics. If the participant table
/// is momentarily contended (a join/leave is being applied on the control task),
/// we cannot verify remote support for this frame, so we keep the caller-supplied
/// `fallback` (the current codec) and re-evaluate on the next frame.
/// Whether a remote participant can decode `codec`. A participant advertising
/// EMPTY capabilities is treated as VP9-decode-only (N9): an empty advertisement
/// means "unknown", and unknown must never be read as "decodes everything" — VP9
/// is the one mandatory-to-decode codec, so it is the only safe assumption.
#[cfg(feature = "vpx")]
fn participant_can_decode(
    participant: &super::session::RemoteSessionParticipant,
    codec: TransportVideoCodec,
) -> bool {
    if participant.video_capabilities.is_empty() {
        codec == TransportVideoCodec::Vp9
    } else {
        participant
            .video_capabilities
            .iter()
            .any(|capability| capability.decode && capability.codec == codec)
    }
}

#[cfg(feature = "vpx")]
fn choose_best_publish_codec(
    session: &NativeMediaSession,
    fallback: VideoCodec,
    app: Option<&AppHandle>,
) -> VideoCodec {
    let local_encoders = session
        .stream_capabilities
        .video
        .iter()
        .filter(|capability| capability.encode)
        .cloned()
        .collect::<Vec<_>>();
    if local_encoders.is_empty() {
        return fallback;
    }

    // The host watches their own stream (the self-view consumes the exact
    // bitstream viewers receive), so the local client's decode support
    // constrains the codec choice exactly like a remote viewer's. Without
    // this, a client with (say) VAAPI H264 encode but no H264 decode streams
    // a picture everyone can see except its own user.
    let local_decodes = |codec: VideoCodec| {
        session.stream_capabilities.video.iter().any(|capability| {
            capability.decode && transport_codec_to_native(capability.codec) == codec
        })
    };

    let Ok(participants_guard) = session.session_participants.try_lock() else {
        return fallback;
    };
    let participants = participants_guard
        .iter()
        .map(|(user_id, participant)| (*user_id, participant.clone()))
        .collect::<Vec<_>>();
    drop(participants_guard);

    // Hardware-first pass keys ONLY on encode_hardware (contract C3): decode
    // acceleration is irrelevant to what we publish.
    let preference = [VideoCodec::Av1, VideoCodec::H264, VideoCodec::Vp9];
    for require_hardware in [true, false] {
        for codec in preference {
            if !local_decodes(codec) {
                continue;
            }
            if !local_encoders.iter().any(|capability| {
                transport_codec_to_native(capability.codec) == codec
                    && (!require_hardware || capability.encode_hardware)
            }) {
                continue;
            }
            let transport_codec = codec_to_transport(codec);
            let all_support = participants
                .iter()
                .all(|(_, participant)| participant_can_decode(participant, transport_codec));
            if all_support {
                return codec;
            }
        }
    }

    // No codec is decodable by every participant. Pick the best locally
    // encodable+decodable codec and fail loudly about the participants it
    // excludes, rather than silently streaming a picture some of them cannot see.
    let chosen = preference.into_iter().find(|codec| {
        local_decodes(*codec)
            && local_encoders
                .iter()
                .any(|capability| transport_codec_to_native(capability.codec) == *codec)
    });
    let Some(chosen) = chosen else {
        return fallback;
    };
    let transport_chosen = codec_to_transport(chosen);
    let excluded: Vec<i64> = participants
        .iter()
        .filter(|(_, participant)| !participant_can_decode(participant, transport_chosen))
        .map(|(user_id, _)| *user_id)
        .collect();
    if !excluded.is_empty() {
        warn_codec_negotiation(app, chosen, &excluded);
    }
    chosen
}

/// Emit `media_codec_negotiation_warning` (+ native_diag) when the negotiated
/// publish codec excludes some participants (N9). Deduped by (codec, excluded
/// set) so a per-frame re-evaluation does not spam the same warning.
#[cfg(feature = "vpx")]
fn warn_codec_negotiation(app: Option<&AppHandle>, codec: VideoCodec, excluded: &[i64]) {
    #[allow(clippy::type_complexity)]
    static LAST_WARNING: OnceLock<Mutex<Option<(VideoCodec, Vec<i64>)>>> = OnceLock::new();
    let mut sorted = excluded.to_vec();
    sorted.sort_unstable();
    {
        let cell = LAST_WARNING.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref() == Some(&(codec, sorted.clone())) {
            return; // already warned about this exact situation
        }
        *guard = Some((codec, sorted.clone()));
    }
    let excluded_ids: Vec<String> = sorted.iter().map(|id| id.to_string()).collect();
    native_diag(
        app,
        &format!(
            "codec negotiation fallback: chose {codec:?}; participants unable to decode it: {excluded_ids:?}"
        ),
    );
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "media_codec_negotiation_warning",
            serde_json::json!({
                "codec": codec_label(codec),
                "excludedUserIds": excluded_ids,
            }),
        );
    }
}

/// Whether `PARACORD_SCREEN_SIMULCAST` explicitly opts OUT of simulcast.
///
/// Spec §4.1 flipped this to opt-OUT: `off`/`0`/`false`/`no` force single-layer;
/// anything else (including unset) defers to the default-on hardware policy.
#[cfg(feature = "vpx")]
fn simulcast_opted_out() -> bool {
    std::env::var("PARACORD_SCREEN_SIMULCAST")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
}

/// Whether `codec` encodes on hardware for the simulcast policy (spec §4.1).
///
/// VP9 encodes on libvpx (software) on every platform, so it is the single-layer
/// floor — a CPU triple-encode is a regression. H.264/AV1 always route to a
/// hardware backend (lavc VAAPI/NVENC on Linux, Media Foundation on Windows,
/// VideoToolbox on macOS) or fail loudly at encoder init; there is no software
/// H.264/AV1 path in this build, so "not VP9" is the honest hardware predicate.
#[cfg(feature = "vpx")]
fn codec_encode_is_hardware(codec: VideoCodec) -> bool {
    !matches!(codec, VideoCodec::Vp9)
}

/// Simulcast policy (spec §4.1, contract S4): ON by default iff every layer's
/// encoder is hardware. All layers share the codec, so this reduces to the
/// codec's hardware status, with `PARACORD_SCREEN_SIMULCAST` as an opt-OUT.
#[cfg(feature = "vpx")]
fn simulcast_enabled_for_codec(codec: VideoCodec) -> bool {
    !simulcast_opted_out() && codec_encode_is_hardware(codec)
}

/// Store the latest frame for a remote track into the pull store, assigning a
/// monotonically increasing per-track sequence. When `push` is false the frame
/// is stored but not sent over the subscription channel (used while a track is
/// hidden — see N4 — so a resume can paint the last keyframe without streaming
/// frames to a canvas nobody is watching).
#[cfg(feature = "vpx")]
#[allow(clippy::too_many_arguments)]
fn store_pulled_video_frame(
    track_key: &str,
    timestamp_us: u64,
    is_keyframe: bool,
    codec: &str,
    format: &str,
    width: u32,
    height: u32,
    colorspace: u8,
    data: Vec<u8>,
    push: bool,
) {
    let debug_index = VIDEO_STORE_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed);
    if debug_index < 24 {
        eprintln!(
            "[native-video-debug] store frame track={} count={} codec={} format={} {}x{} keyframe={} bytes={}",
            track_key,
            debug_index + 1,
            codec,
            format,
            width,
            height,
            is_keyframe,
            data.len(),
        );
    }
    // Store the latest frame under the dispatch lock, then clone out the
    // subscription channel (if any). The push MUST happen after the lock is
    // released — see `remote_track_channels`.
    let outbound = {
        let mut state = match video_dispatch_state().lock() {
            Ok(state) => state,
            Err(_) => return,
        };

        let next_sequence = state
            .remote_track_sequences
            .get(track_key)
            .copied()
            .unwrap_or(0)
            .wrapping_add(1);
        state
            .remote_track_sequences
            .insert(track_key.to_string(), next_sequence);
        let payload = PulledVideoFramePayload {
            sequence: next_sequence,
            timestamp_us,
            is_keyframe,
            codec: codec.to_string(),
            format: format.to_string(),
            width,
            height,
            colorspace,
            data,
        };
        state
            .remote_track_latest_frames
            .insert(track_key.to_string(), payload.clone());
        state
            .remote_track_stored_at
            .insert(track_key.to_string(), Instant::now());
        if push {
            state
                .remote_track_channels
                .get(track_key)
                .cloned()
                .map(|channel| (channel, payload))
        } else {
            None
        }
    };

    if let Some((channel, payload)) = outbound {
        push_frame_over_channel(track_key, &channel, payload);
    }
}

/// Record the relay-announced SSRC→track binding for a remote track and the
/// largest resolution it advertised.
///
/// Called whenever the control channel delivers a `TrackPublish`/`TrackLayers`
/// for a track. Every simulcast layer's SSRC is bound, so layer switching does
/// not trip [`video_frame_identity_is_authorized`].
#[cfg(feature = "vpx")]
pub fn bind_remote_video_track(
    stream_id: &str,
    track_id: &str,
    layers: &[paracord_transport::stream::PublishedLayer],
) {
    let key = make_track_key(stream_id, track_id);
    let Ok(mut state) = video_dispatch_state().lock() else {
        return;
    };
    // Drop any previous binding for this track first, so an SSRC that is no
    // longer part of the track's ladder stops resolving to it.
    state
        .remote_ssrc_track_bindings
        .retain(|_, bound| bound != &key);
    for layer in layers {
        state
            .remote_ssrc_track_bindings
            .insert(layer.ssrc, key.clone());
    }
    let max_dims = layers
        .iter()
        .filter_map(|layer| Some((u32::from(layer.width?), u32::from(layer.height?))))
        .fold(None, |acc: Option<(u32, u32)>, (w, h)| match acc {
            Some((aw, ah)) => Some((aw.max(w), ah.max(h))),
            None => Some((w, h)),
        });
    match max_dims {
        Some(dims) => {
            state.remote_track_max_dimensions.insert(key, dims);
        }
        None => {
            state.remote_track_max_dimensions.remove(&key);
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub fn bind_remote_video_track(
    _stream_id: &str,
    _track_id: &str,
    _layers: &[paracord_transport::stream::PublishedLayer],
) {
}

/// Forget a remote track's SSRC binding and negotiated resolution (on
/// `TrackUnpublish` or teardown).
#[cfg(feature = "vpx")]
pub fn unbind_remote_video_track(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        state
            .remote_ssrc_track_bindings
            .retain(|_, bound| bound != &key);
        state.remote_track_max_dimensions.remove(&key);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn unbind_remote_video_track(_stream_id: &str, _track_id: &str) {}

/// Whether a frame arriving on `ssrc` may claim to belong to `claimed_track_key`.
///
/// The relay authorizes only the SSRC (`resolve_published_track_for_ssrc`); the
/// `stream_id`/`track_id` in the frame metadata are sender-chosen labels. This
/// rejects a frame whenever the two disagree:
///
/// * the SSRC is bound to a *different* track — the hostile-relabel case; or
/// * the claimed track has known SSRCs and this is not one of them — the same
///   attack seen from the other side.
///
/// When neither side is bound the frame is allowed: that is the local self-view
/// loopback and the brief window before the first `TrackPublish` lands, neither
/// of which the check can adjudicate. Both attack directions above require the
/// victim track to be known, which it is precisely when the attack matters (the
/// viewer is subscribed to it).
#[cfg(feature = "vpx")]
fn video_frame_identity_is_authorized(ssrc: u32, claimed_track_key: &str) -> bool {
    let Ok(state) = video_dispatch_state().lock() else {
        return false;
    };
    if let Some(bound) = state.remote_ssrc_track_bindings.get(&ssrc) {
        return bound == claimed_track_key;
    }
    if let Some(&subscribed_ssrc) = state.remote_track_ssrcs.get(claimed_track_key) {
        if subscribed_ssrc == ssrc {
            return true;
        }
    }
    // This SSRC has no binding. Reject only if the claimed track does have
    // one — then this SSRC is provably not part of that track's ladder.
    !state
        .remote_ssrc_track_bindings
        .values()
        .any(|bound| bound == claimed_track_key)
}

/// Negotiated (`TrackPublish`) resolution cap for a remote track, if announced.
#[cfg(feature = "vpx")]
fn track_max_dimensions(track_key: &str) -> Option<(u32, u32)> {
    let state = video_dispatch_state().lock().ok()?;
    state.remote_track_max_dimensions.get(track_key).copied()
}

/// Start the camera video encoder with an explicit capture configuration.
///
/// Mirror of [`start_screen_share`] for the camera track: it seeds the
/// per-stream `video_*` encoder configuration/codec/generation state that the
/// begin/run/finish camera-frame phases snapshot so the heavy encode runs with
/// the session lock released. Bitrate presets (contract CAM2): 720p30 →
/// 2500 kbps, 1080p30 → 4000 kbps, chosen by the caller and passed as
/// `max_bitrate_bps`.
pub fn start_camera_share(
    session: &mut NativeMediaSession,
    source_width: u32,
    source_height: u32,
    fps: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
    max_bitrate_bps: Option<u32>,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let codec = choose_best_publish_codec(session, default_camera_codec(), None);
        tracing::info!(
            selected_codec = ?codec,
            local_capabilities = ?session.stream_capabilities.video,
            "starting native camera encoder"
        );

        let (width, height) = fit_encode_dimensions(
            source_width,
            source_height,
            max_width.unwrap_or(source_width),
            max_height.unwrap_or(source_height),
        );
        let width = width & !1;
        let height = height & !1;
        if width == 0 || height == 0 {
            return Err(format!(
                "camera encoder config: capture too small: {width}x{height}"
            ));
        }

        let config = EncoderConfig {
            width,
            height,
            fps: fps.max(1),
            bitrate_kbps: (max_bitrate_bps.unwrap_or(2_500_000) / 1000).max(1),
            pixel_format: PixelFormat::I420,
            keyframe_interval: fps.max(1) * SCREEN_KEYFRAME_INTERVAL_SECONDS,
            content_hint: VideoContentHint::Motion,
        };
        config
            .validate()
            .map_err(|e| format!("camera encoder config: {e}"))?;

        CAMERA_DIAG_COUNT.store(0, Ordering::Relaxed);
        native_diag(
            None,
            &format!(
                "start_camera_share: codec={codec:?} {}x{} fps={} bitrate_kbps={}",
                config.width, config.height, config.fps, config.bitrate_kbps
            ),
        );
        session.video_encoder = None;
        session.video_simulcast = None;
        session.video_encoder_config = Some(config);
        session.video_encoder_codec = Some(codec);
        session.video_layer_ssrcs = build_track_layer_ssrcs(session.local_user_id, "video");
        session.video_seq = 0;
        session.video_timestamp = 0;
        session.video_pts = 0;
        session.video_force_keyframe.store(true, Ordering::SeqCst);
        session.video_applied_bitrate_kbps = 0;
        session.video_encoder_generation = session.video_encoder_generation.wrapping_add(1);
        session.video_capture_base_time = None;
        session.video_last_timestamp_us = 0;
        reset_local_self_view_decode(session, false);
        Ok(())
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (
            session,
            source_width,
            source_height,
            fps,
            max_width,
            max_height,
            max_bitrate_bps,
        );
        Err("camera encoding requires the 'vpx' feature".into())
    }
}

/// Stop the camera video encoder. Mirror of [`stop_screen_share`]. Does NOT
/// unpublish the track — the caller (camera_capture::stop_capture) handles the
/// registry unpublish + `TrackUnpublish` control message, exactly as the screen
/// path splits capture teardown from encoder teardown.
pub fn stop_camera_share(session: &mut NativeMediaSession) {
    #[cfg(feature = "vpx")]
    {
        session.video_encoder = None;
        session.video_simulcast = None;
        session.video_encoder_config = None;
        session.video_encoder_codec = None;
        session.video_layer_ssrcs.clear();
        session.video_seq = 0;
        session.video_timestamp = 0;
        session.video_pts = 0;
        session.video_force_keyframe.store(true, Ordering::SeqCst);
        session.video_applied_bitrate_kbps = 0;
        session.video_encoder_generation = session.video_encoder_generation.wrapping_add(1);
        session.video_capture_base_time = None;
        session.video_last_timestamp_us = 0;
        reset_local_self_view_decode(session, false);
    }

    #[cfg(not(feature = "vpx"))]
    let _ = session;
}

#[cfg(feature = "vpx")]
fn default_camera_codec() -> paracord_codec::video::VideoCodec {
    default_screen_codec()
}

/// Build the per-layer encoder configs for a capture surface (spec §4.1).
///
/// Uses the canonical per-surface ladder in paracord-codec (screen vs camera
/// rungs) so the pipeline and encoder agree; each rung is later constructed
/// `new_with_input(capture → layer)` so scaling/conversion is per-layer GPU work.
/// When the codec is not an all-hardware simulcast codec (the libvpx VP9 floor)
/// or simulcast is opted out, only the single top (source) rung is kept.
#[cfg(feature = "vpx")]
fn build_simulcast_configs(
    kind: paracord_codec::video::SimulcastKind,
    codec: VideoCodec,
    target_width: u32,
    target_height: u32,
    target_fps: u32,
    target_bitrate_kbps: u32,
    content_hint: paracord_codec::video::VideoContentHint,
    pixel_format: paracord_codec::video::PixelFormat,
) -> Vec<(
    paracord_codec::video::SimulcastLayer,
    paracord_codec::video::EncoderConfig,
)> {
    let mut ladder = paracord_codec::video::simulcast_ladder(
        kind,
        target_width,
        target_height,
        target_fps,
        target_bitrate_kbps,
        pixel_format,
        content_hint,
        SCREEN_KEYFRAME_INTERVAL_SECONDS,
    );
    if simulcast_enabled_for_codec(codec) {
        ladder
    } else {
        let top = ladder
            .pop()
            .expect("simulcast_ladder always yields at least one rung");
        vec![top]
    }
}

#[cfg(feature = "vpx")]
fn create_camera_simulcast_encoder(
    session: &mut NativeMediaSession,
    input_width: u32,
    input_height: u32,
    layers: &[(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )],
) -> Result<super::session::NativeSimulcastState, String> {
    use paracord_codec::video::encoder::{create_encoder, SimulcastEncoder};
    use paracord_codec::video::VideoCodec;

    fn build_with_codec(
        codec: VideoCodec,
        input_format: paracord_codec::video::PixelFormat,
        input_width: u32,
        input_height: u32,
        layers: &[(
            paracord_codec::video::SimulcastLayer,
            paracord_codec::video::EncoderConfig,
        )],
    ) -> Result<SimulcastEncoder, paracord_codec::video::VideoError> {
        SimulcastEncoder::new_with_configs(input_width, input_height, input_format, layers, |cfg| {
            // The in-process libavcodec hardware encoders take capture-sized
            // packed input and scale/convert on the GPU (parity with the screen
            // path). VP9 falls through to the libvpx factory with I420.
            #[cfg(all(unix, not(target_os = "macos")))]
            if matches!(codec, VideoCodec::H264 | VideoCodec::Av1) {
                return Ok(Box::new(
                    paracord_codec::video::lavc::LavcEncoder::new_with_input(
                        codec,
                        cfg,
                        input_width,
                        input_height,
                    )?,
                ));
            }
            create_encoder(codec, cfg)
        })
    }

    let preferred = session
        .video_encoder_codec
        .unwrap_or_else(default_camera_codec);
    let preferred_input_format = layers
        .last()
        .map(|(_, config)| config.pixel_format)
        .unwrap_or(paracord_codec::video::PixelFormat::I420);
    // No silent codec substitution (parity with the screen path): a failed init
    // means the capability probe and reality disagree — surface it.
    let (codec, encoder, effective_layers) = match build_with_codec(
        preferred,
        preferred_input_format,
        input_width,
        input_height,
        layers,
    ) {
        Ok(encoder) => (preferred, encoder, layers.to_vec()),
        Err(err) => return Err(format!("camera simulcast init for {preferred:?}: {err}")),
    };
    session.video_encoder_codec = Some(codec);
    Ok(super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: effective_layers,
        codec,
        ssrcs: session.video_layer_ssrcs.clone(),
    })
}

/// Start screen share encoder with an explicit capture configuration.
pub fn start_screen_share(
    session: &mut NativeMediaSession,
    source_width: u32,
    source_height: u32,
    fps: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
    max_bitrate_bps: Option<u32>,
    content_hint: Option<&str>,
    preferred_codec: Option<&str>,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let codec = match preferred_codec {
            Some(label) => super::capabilities::video_codec_from_label(label)
                .map(transport_codec_to_native)
                .ok_or_else(|| format!("unsupported preferred video codec: {label}"))?,
            None => choose_best_publish_codec(session, default_screen_codec(), None),
        };
        tracing::info!(
            preferred_codec,
            selected_codec = ?codec,
            local_capabilities = ?session.stream_capabilities.video,
            "starting native screen share encoder"
        );

        let (width, height) = fit_encode_dimensions(
            source_width,
            source_height,
            max_width.unwrap_or(source_width),
            max_height.unwrap_or(source_height),
        );
        let width = width & !1;
        let height = height & !1;
        if width == 0 || height == 0 {
            return Err(format!(
                "screen encoder config: capture too small: {width}x{height}"
            ));
        }

        let config = EncoderConfig {
            width,
            height,
            fps: fps.max(1),
            bitrate_kbps: (max_bitrate_bps.unwrap_or(12_000_000) / 1000).max(1),
            pixel_format: PixelFormat::I420,
            // Keyframes are the dominant burst cost (each fans out into
            // hundreds of datagrams). Late joiners and loss recovery are
            // handled by RequestKeyframe, so a long periodic interval is safe.
            keyframe_interval: fps.max(1) * SCREEN_KEYFRAME_INTERVAL_SECONDS,
            content_hint: match content_hint {
                Some("detail") => VideoContentHint::Detail,
                Some("film") => VideoContentHint::Film,
                Some("motion") => VideoContentHint::Motion,
                _ => VideoContentHint::Default,
            },
        };
        config
            .validate()
            .map_err(|e| format!("screen encoder config: {e}"))?;

        SCREEN_DIAG_COUNT.store(0, Ordering::Relaxed);
        native_diag(
            None,
            &format!(
                "start_screen_share: codec={codec:?} {}x{} fps={} bitrate_kbps={}",
                config.width, config.height, config.fps, config.bitrate_kbps
            ),
        );
        session.screen_encoder = None;
        session.screen_simulcast = None;
        session.screen_encoder_config = Some(config);
        session.screen_encoder_codec = Some(codec);
        session.screen_layer_ssrcs = build_track_layer_ssrcs(session.local_user_id, "screen");
        session.screen_seq = 0;
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
        session.screen_capture_base_time = None;
        session.screen_last_timestamp_us = 0;
        reset_local_self_view_decode(session, true);
        Ok(())
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (
            session,
            source_width,
            source_height,
            fps,
            max_width,
            max_height,
            max_bitrate_bps,
            content_hint,
            preferred_codec,
        );
        Err("screen share encoding requires the 'vpx' feature".into())
    }
}

/// Stop screen share encoder.
pub fn stop_screen_share(session: &mut NativeMediaSession) {
    #[cfg(feature = "vpx")]
    {
        session.screen_encoder = None;
        session.screen_simulcast = None;
        session.screen_encoder_config = None;
        session.screen_encoder_codec = None;
        session.screen_layer_ssrcs.clear();
        session.screen_seq = 0;
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
        session.screen_capture_base_time = None;
        session.screen_last_timestamp_us = 0;
        reset_local_self_view_decode(session, true);
    }

    #[cfg(not(feature = "vpx"))]
    let _ = session;
}

#[cfg(feature = "vpx")]
fn default_screen_codec() -> paracord_codec::video::VideoCodec {
    // macOS now has a hardware H.264 encoder (VideoToolbox), joining Windows
    // (Media Foundation) and Linux (lavc) — H.264 is the default everywhere with
    // a hardware backend; VP9 (libvpx) remains the floor on other platforms.
    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        all(unix, not(target_os = "macos"))
    ))]
    {
        paracord_codec::video::VideoCodec::H264
    }

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        all(unix, not(target_os = "macos"))
    )))]
    {
        paracord_codec::video::VideoCodec::Vp9
    }
}

#[cfg(feature = "vpx")]
fn build_track_layer_ssrcs(user_id: i64, kind: &str) -> Vec<(u8, u32)> {
    use paracord_codec::video::SimulcastLayer;

    [
        (SimulcastLayer::Low, 0u8),
        (SimulcastLayer::Medium, 1u8),
        (SimulcastLayer::High, 2u8),
    ]
    .into_iter()
    .map(|(layer, layer_id)| {
        let ssrc = if layer == SimulcastLayer::High {
            NativeMediaSession::derive_track_ssrc(user_id, kind)
        } else {
            NativeMediaSession::derive_track_layer_ssrc(user_id, kind, layer_id)
        };
        (layer_id, ssrc)
    })
    .collect()
}

#[cfg(feature = "vpx")]
fn create_screen_simulcast_encoder(
    session: &mut NativeMediaSession,
    input_width: u32,
    input_height: u32,
    layers: &[(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )],
) -> Result<super::session::NativeSimulcastState, String> {
    use paracord_codec::video::encoder::{create_encoder, SimulcastEncoder};
    use paracord_codec::video::VideoCodec;

    fn build_with_codec(
        codec: VideoCodec,
        input_format: paracord_codec::video::PixelFormat,
        input_width: u32,
        input_height: u32,
        layers: &[(
            paracord_codec::video::SimulcastLayer,
            paracord_codec::video::EncoderConfig,
        )],
    ) -> Result<SimulcastEncoder, paracord_codec::video::VideoError> {
        SimulcastEncoder::new_with_configs(input_width, input_height, input_format, layers, |cfg| {
            // The in-process libavcodec hardware encoders (H.264/AV1) take
            // capture-sized input and scale/convert on the GPU, so construct
            // them with the real input dims. VP9 falls through to the libvpx
            // factory.
            #[cfg(all(unix, not(target_os = "macos")))]
            if matches!(codec, VideoCodec::H264 | VideoCodec::Av1) {
                return Ok(Box::new(
                    paracord_codec::video::lavc::LavcEncoder::new_with_input(
                        codec,
                        cfg,
                        input_width,
                        input_height,
                    )?,
                ));
            }
            create_encoder(codec, cfg)
        })
    }

    let preferred = session
        .screen_encoder_codec
        .unwrap_or_else(default_screen_codec);
    let preferred_input_format = layers
        .last()
        .map(|(_, config)| config.pixel_format)
        .unwrap_or(paracord_codec::video::PixelFormat::I420);
    // No silent codec substitution: the codec was negotiated from advertised
    // capabilities, so a failed init here means the capability probe and
    // reality disagree — surface that instead of streaming something else.
    let (codec, encoder, effective_layers) = match build_with_codec(
        preferred,
        preferred_input_format,
        input_width,
        input_height,
        layers,
    ) {
        Ok(encoder) => (preferred, encoder, layers.to_vec()),
        Err(err) => return Err(format!("screen simulcast init for {preferred:?}: {err}")),
    };
    session.screen_encoder_codec = Some(codec);
    Ok(super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: effective_layers,
        codec,
        ssrcs: session.screen_layer_ssrcs.clone(),
    })
}

/// Crop a packed RGBA/BGRA frame to even dimensions.
///
/// Video encoders require even width/height (chroma subsampling). Returns the
/// cropped-even dims and, only when a crop was actually needed, the cropped
/// pixel buffer. When the input is already even, no copy is made.
#[cfg(feature = "vpx")]
fn crop_to_even(
    packed: &[u8],
    width: u32,
    height: u32,
) -> Result<(u32, u32, Option<Vec<u8>>), String> {
    if width % 2 == 0 && height % 2 == 0 {
        return Ok((width, height, None));
    }
    let normalized_width = width - (width % 2);
    let normalized_height = height - (height % 2);
    if normalized_width == 0 || normalized_height == 0 {
        return Err(format!(
            "video frame has unsupported dimensions: {width}x{height}"
        ));
    }

    let row_bytes = (normalized_width * 4) as usize;
    let src_stride = (width * 4) as usize;
    let mut cropped = Vec::with_capacity((normalized_width * normalized_height * 4) as usize);
    for row in 0..normalized_height as usize {
        let start = row * src_stride;
        let end = start + row_bytes;
        cropped.extend_from_slice(&packed[start..end]);
    }
    Ok((normalized_width, normalized_height, Some(cropped)))
}

/// Work handed from [`begin_camera_frame`] (session lock held, brief) to
/// [`run_camera_frame`] (session lock released, heavy). The camera mirror of
/// [`ScreenFrameJob`]: the encoder and everything the per-frame encode needs are
/// moved out of the session so the pixel/encode/encrypt/send work touches no
/// session state.
#[cfg(feature = "vpx")]
pub struct CameraFrameJob {
    simulcast: Option<super::session::NativeSimulcastState>,
    generation: u64,
    layer_ssrcs: Vec<(u8, u32)>,
    fallback_ssrc: u32,
    stream_id: StreamId,
    track_id: TrackId,
    seq: u16,
    timestamp: u32,
    pts: i64,
    capture_timestamp_us: u64,
    preset_kbps: u32,
    feedback_kbps: u32,
    applied_kbps: u32,
    key_epoch: u8,
    connection: quinn::Connection,
    max_fragment_payload: usize,
    frame_encryptor: Arc<Mutex<paracord_codec::crypto::FrameEncryptor>>,
    video_force_keyframe: Arc<AtomicBool>,
    i420_convert_buf: Vec<u8>,
}

/// Results carried from [`run_camera_frame`] back to [`finish_camera_frame`].
#[cfg(feature = "vpx")]
pub struct CameraFrameOutcome {
    simulcast: super::session::NativeSimulcastState,
    generation: u64,
    seq: u16,
    timestamp_step: u32,
    applied_kbps: u32,
    i420_convert_buf: Vec<u8>,
}

/// Phase 1 of the camera encode: brief work that must hold the session lock.
/// Camera mirror of [`begin_screen_frame`] — chooses the codec, (re)creates the
/// encoder if needed, publishes the camera track before the first send, reads
/// the sender-key epoch, and snapshots everything the unlocked encode needs.
#[cfg(feature = "vpx")]
pub async fn begin_camera_frame(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
    capture_time: std::time::SystemTime,
) -> Result<CameraFrameJob, String> {
    use paracord_codec::video::EncoderConfig;

    let frame_width = width & !1;
    let frame_height = height & !1;
    if frame_width == 0 || frame_height == 0 {
        return Err(format!(
            "video frame has unsupported dimensions: {width}x{height}"
        ));
    }

    let camera_config = session
        .video_encoder_config
        .clone()
        .ok_or("camera encoder not active")?;
    let requested_codec = choose_best_publish_codec(
        session,
        session
            .video_encoder_codec
            .unwrap_or_else(default_camera_codec),
        app,
    );
    session.video_encoder_codec = Some(requested_codec);
    let (fitted_width, fitted_height) = fit_encode_dimensions(
        frame_width,
        frame_height,
        camera_config.width,
        camera_config.height,
    );
    let (encode_width, encode_height) =
        align_dimensions_for_codec(requested_codec, fitted_width, fitted_height);
    let desired_config = EncoderConfig {
        width: encode_width,
        height: encode_height,
        pixel_format: screen_encoder_input_format(requested_codec, input_is_bgra),
        ..camera_config.clone()
    };
    desired_config
        .validate()
        .map_err(|e| format!("camera encoder config: {e}"))?;
    let desired_layers = build_simulcast_configs(
        paracord_codec::video::SimulcastKind::Camera,
        requested_codec,
        desired_config.width,
        desired_config.height,
        desired_config.fps,
        desired_config.bitrate_kbps,
        // Camera favors motion smoothness at lower resolutions (spec §4.1).
        paracord_codec::video::VideoContentHint::Motion,
        desired_config.pixel_format,
    );
    let needs_reinit = session
        .video_simulcast
        .as_ref()
        .map(|encoder| {
            encoder.input_width != frame_width
                || encoder.input_height != frame_height
                || encoder.codec
                    != session
                        .video_encoder_codec
                        .unwrap_or_else(default_camera_codec)
                || encoder.layers != desired_layers
        })
        .unwrap_or(true);

    if needs_reinit {
        let encoder =
            create_camera_simulcast_encoder(session, frame_width, frame_height, &desired_layers)?;
        tracing::info!(
            codec = ?encoder.codec,
            backend = encoder.backend_name,
            hardware = encoder.hardware_accelerated,
            input_width = encoder.input_width,
            input_height = encoder.input_height,
            "configured native camera simulcast encoder"
        );
        session.video_simulcast = Some(encoder);
        session.video_encoder = None;
        session.video_seq = 0;
        session.video_timestamp = 0;
        session.video_force_keyframe.store(true, Ordering::SeqCst);
        session.video_applied_bitrate_kbps = 0;
        session.video_encoder_generation = session.video_encoder_generation.wrapping_add(1);
    }

    // Publish the track before the first send. Publish only needs the encoder's
    // layer configs, which exist now that any reinit has run.
    if session.published_video_track.is_none() {
        publish_camera_track_for_current_config(session, app).await?;
    }
    sync_published_video_track_metadata(session, false);

    let stream_id = local_video_stream_id(session, false);
    let track_id = local_video_track_id(false);
    let track_key_epoch = {
        let sender_keys = session.track_sender_keys.lock().await;
        sender_keys
            .get(&(stream_id.clone(), track_id.clone()))
            .map(|state| state.epoch)
    };
    let key_epoch = track_key_epoch.ok_or_else(|| {
        format!(
            "video sender key missing for {}:{}",
            stream_id.0, track_id.0
        )
    })?;

    // The camera path has no relay bandwidth-feedback field, so it always runs
    // at the preset bitrate (feedback = 0 → no retarget in `run_camera_frame`).
    let preset_kbps = camera_config.bitrate_kbps;
    let feedback_kbps = 0u32;
    let applied_kbps = if session.video_applied_bitrate_kbps == 0 {
        preset_kbps
    } else {
        session.video_applied_bitrate_kbps
    };

    let pts = session.video_pts;
    session.video_pts = session.video_pts.wrapping_add(1);

    // L2: wire PTS from the frame's true capture time relative to the first
    // frame, kept monotonic per track.
    let base = *session.video_capture_base_time.get_or_insert(capture_time);
    let raw_us = capture_time
        .duration_since(base)
        .map(|delta| delta.as_micros() as u64)
        .unwrap_or(session.video_last_timestamp_us);
    let capture_timestamp_us = raw_us.max(session.video_last_timestamp_us);
    session.video_last_timestamp_us = capture_timestamp_us;

    let max_datagram_size = session
        .connection
        .max_datagram_size()
        .unwrap_or(FALLBACK_MAX_DATAGRAM_SIZE);
    let max_fragment_payload = max_datagram_size
        .saturating_sub(HEADER_SIZE + TAG_SIZE + 128)
        .max(256);

    let simulcast = session
        .video_simulcast
        .take()
        .ok_or("camera encoder not active")?;
    let generation = session.video_encoder_generation;
    let i420_convert_buf = std::mem::take(&mut session.i420_convert_buf);

    Ok(CameraFrameJob {
        simulcast: Some(simulcast),
        generation,
        layer_ssrcs: session.video_layer_ssrcs.clone(),
        fallback_ssrc: session.video_ssrc,
        stream_id,
        track_id,
        seq: session.video_seq,
        timestamp: session.video_timestamp,
        pts,
        capture_timestamp_us,
        preset_kbps,
        feedback_kbps,
        applied_kbps,
        key_epoch,
        connection: session.connection.inner().clone(),
        max_fragment_payload,
        frame_encryptor: session.frame_encryptor.clone(),
        video_force_keyframe: session.video_force_keyframe.clone(),
        i420_convert_buf,
    })
}

/// Phase 2 of the camera encode: the heavy per-frame work, with NO session
/// access. Faithful mirror of [`run_screen_frame`]: crop copy, pixel conversion,
/// encode, fragment/encrypt/send loop (LOCAL seq counter), the self-view block
/// (exact encoded bitstream stored in the pull store — no raw side-channel), and
/// bounded diagnostics.
///
/// Must be called from within a tokio runtime context: the self-view
/// native-decode branch uses `tokio::spawn`.
#[cfg(feature = "vpx")]
pub fn run_camera_frame(
    job: &mut CameraFrameJob,
    packed: &[u8],
    raw_width: u32,
    raw_height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
) -> Result<CameraFrameOutcome, String> {
    use paracord_codec::video::{bgra_to_i420, rgba_to_i420, EncodedFrame, PixelFormat};

    let mut simulcast = job
        .simulcast
        .take()
        .ok_or("camera encoder missing from frame job")?;
    // Self-view consumes the TOP layer's exact bitstream (spec §4.1): pick by
    // layer id, never emission order, so a lower simulcast rung emitted later in
    // the drain never overwrites the top-layer preview.
    let top_layer_id: u8 = simulcast
        .layers
        .iter()
        .map(|(layer, _)| *layer as u8)
        .max()
        .unwrap_or(0);

    let (frame_width, frame_height, cropped_storage) = crop_to_even(packed, raw_width, raw_height)?;
    let packed = cropped_storage.as_deref().unwrap_or(packed);

    let source_pixel_format = if input_is_bgra {
        PixelFormat::Bgra
    } else {
        PixelFormat::Rgba
    };
    let expected_packed_size = source_pixel_format.frame_size(frame_width, frame_height);
    if packed.len() != expected_packed_size {
        return Err(format!(
            "video frame size mismatch: expected {expected_packed_size} bytes, got {}",
            packed.len()
        ));
    }

    let encoder_input_format = simulcast.encoder.input_format();
    let mut i420_buf = std::mem::take(&mut job.i420_convert_buf);
    let encode_input: &[u8] = match encoder_input_format {
        PixelFormat::I420 => {
            let i420_size = PixelFormat::I420.frame_size(frame_width, frame_height);
            if i420_buf.len() != i420_size {
                i420_buf.resize(i420_size, 0);
            }
            // BT.709 conversion per contract C1 (the shared bgra/rgba_to_i420
            // helpers target BT.709 limited-range).
            if input_is_bgra {
                bgra_to_i420(packed, frame_width, frame_height, &mut i420_buf);
            } else {
                rgba_to_i420(packed, frame_width, frame_height, &mut i420_buf);
            }
            i420_buf.as_slice()
        }
        PixelFormat::Rgba | PixelFormat::Bgra => {
            if encoder_input_format != source_pixel_format {
                return Err(format!(
                    "camera encoder expected {encoder_input_format:?} input but capture produced {source_pixel_format:?}"
                ));
            }
            packed
        }
    };

    let pts = job.pts;
    let force_keyframe = job.video_force_keyframe.swap(false, Ordering::SeqCst);

    let preset_kbps = job.preset_kbps;
    let feedback_kbps = job.feedback_kbps;
    let applied_kbps = job.applied_kbps;
    let target_kbps = if feedback_kbps > 0 {
        preset_kbps
            .min((feedback_kbps.saturating_mul(85) / 100).max(MIN_ADAPTIVE_SCREEN_BITRATE_KBPS))
    } else {
        preset_kbps
    };

    let fps = simulcast
        .layers
        .last()
        .map(|(_, config)| config.fps.max(1))
        .unwrap_or(30);
    let mut new_applied_kbps = applied_kbps;
    if target_kbps > 0
        && target_kbps != applied_kbps
        && target_kbps.abs_diff(applied_kbps).saturating_mul(8) >= applied_kbps
    {
        match simulcast.encoder.set_top_layer_bitrate(target_kbps) {
            Ok(true) => {
                new_applied_kbps = target_kbps;
            }
            Ok(false) => {}
            Err(err) => {
                tracing::debug!("camera encoder bitrate retarget failed: {err}");
            }
        }
    }

    let mut encoded_frames = simulcast
        .encoder
        .encode(pts, encode_input, force_keyframe)
        .map_err(|e| format!("video encode: {e}"))?;

    let timestamp_step = (90_000u32 / fps).max(1);
    let frame_timestamp = job.timestamp;
    let encoded_count = encoded_frames.len();
    let mut local_seq = job.seq;
    let self_view_track_key = make_track_key(&job.stream_id.0, &job.track_id.0);
    let (sv_has_subscriber, sv_prefers_encoded, sv_has_stored, sv_hidden) =
        video_dispatch_snapshot(&self_view_track_key);
    let mut local_preview_frame: Option<LocalPreviewFrame> = None;
    for frame in encoded_frames.drain(..) {
        let frame_timestamp_us = job.capture_timestamp_us;
        let frame_codec = frame.codec;
        let frame_width = frame.width;
        let frame_height = frame.height;
        let frame_data = frame.data;
        let frame_pts = frame.pts;
        let frame_is_keyframe = frame.is_keyframe;
        let layer_id = frame.layer.map(|layer| layer as u8).unwrap_or(0);
        let ssrc = job
            .layer_ssrcs
            .iter()
            .find_map(|(mapped_layer_id, ssrc)| (*mapped_layer_id == layer_id).then_some(*ssrc))
            .unwrap_or(job.fallback_ssrc);
        if should_send_on_stream(
            frame_is_keyframe,
            frame_data.len(),
            job.max_fragment_payload,
        ) {
            send_encoded_video_frame_stream(
                &job.connection,
                &job.frame_encryptor,
                job.key_epoch,
                ssrc,
                &mut local_seq,
                frame_timestamp,
                layer_id,
                frame_codec,
                frame_is_keyframe,
                &job.stream_id,
                &job.track_id,
                frame_pts.max(0) as u64,
                frame_timestamp_us,
                &frame_data,
            )?;
        } else {
            send_encoded_video_frame(
                &job.connection,
                &job.frame_encryptor,
                job.key_epoch,
                ssrc,
                &mut local_seq,
                frame_timestamp,
                job.max_fragment_payload,
                layer_id,
                frame_codec,
                frame_is_keyframe,
                &job.stream_id,
                &job.track_id,
                frame_pts.max(0) as u64,
                frame_timestamp_us,
                &frame_data,
            )?;
        }
        // Clone the encoded bytes for the self-view only for the TOP layer (the
        // exact bitstream a top-layer viewer receives) and only when a subscriber
        // is watching (N12c) — selection is by layer id, not drain order.
        if sv_has_subscriber && layer_id == top_layer_id {
            local_preview_frame = Some(LocalPreviewFrame {
                timestamp_us: frame_timestamp_us,
                is_keyframe: frame_is_keyframe,
                codec: frame_codec,
                colorspace: frame.colorspace,
                pts: frame_pts,
                width: frame_width,
                height: frame_height,
                data: frame_data.clone(),
            });
        }
        let debug_index = VIDEO_SEND_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed);
        if debug_index < 24 {
            eprintln!(
                "[native-video-debug] sent camera datagram stream={} track={} ssrc={} layer={} epoch={} keyframe={} bytes={}",
                job.stream_id.0,
                job.track_id.0,
                ssrc,
                layer_id,
                job.key_epoch,
                frame_is_keyframe,
                frame_data.len(),
            );
        }
    }
    // Self-view: the host watches the exact bitstream remote viewers receive —
    // no raw or downscaled preview side-channel (contract CAM3). Publish already
    // happened in `begin_camera_frame`, so camera frames are always sendable.
    let can_send_camera_frames = true;
    let camera_diag_index = CAMERA_DIAG_COUNT.fetch_add(1, Ordering::Relaxed);
    let mut self_view_action = "no-preview-frame";
    let preview_summary = local_preview_frame
        .as_ref()
        .map(|preview| (preview.is_keyframe, preview.data.len()));
    {
        let track_key = &self_view_track_key;
        if !sv_has_subscriber {
            self_view_action = "no-subscriber";
        } else if let Some(preview) = local_preview_frame {
            if !preview.is_keyframe && !sv_has_stored {
                self_view_action = "await-keyframe";
                job.video_force_keyframe.store(true, Ordering::SeqCst);
            } else if sv_prefers_encoded {
                self_view_action = "stored-encoded";
                let label = codec_label(preview.codec);
                store_pulled_video_frame(
                    track_key,
                    preview.timestamp_us,
                    preview.is_keyframe,
                    label,
                    label,
                    preview.width,
                    preview.height,
                    preview.colorspace.header_tag(),
                    preview.data,
                    !sv_hidden,
                );
            } else {
                self_view_action = "native-decode";
                let encoded = EncodedFrame {
                    data: preview.data,
                    codec: preview.codec,
                    pts: preview.pts,
                    is_keyframe: preview.is_keyframe,
                    layer: None,
                    width: preview.width,
                    height: preview.height,
                    colorspace: preview.colorspace,
                };
                let frame = ReassembledVideoFrame {
                    frame_id: preview.pts.max(0) as u64,
                    timestamp_us: preview.timestamp_us,
                    encoded,
                    simulcast_layer: 0,
                };
                let sink = KeyframeSink::LocalEncoder {
                    force_keyframe: job.video_force_keyframe.clone(),
                };
                dispatch_frame_to_worker(track_key, frame, sink);
            }
        }
    }
    if camera_diag_index < CAMERA_DIAG_FRAMES {
        let codec = format!("{:?}", simulcast.codec);
        let backend = simulcast.backend_name;
        native_diag(
            app,
            &format!(
                "camera frame {camera_diag_index}: encoded={encoded_count} preview(kf,bytes)={preview_summary:?} \
                 published={can_send_camera_frames} self_view={self_view_action} codec={codec} \
                 backend={backend} track={}:{}",
                job.stream_id.0, job.track_id.0
            ),
        );
    }

    Ok(CameraFrameOutcome {
        simulcast,
        generation: job.generation,
        seq: local_seq,
        timestamp_step,
        applied_kbps: new_applied_kbps,
        i420_convert_buf: i420_buf,
    })
}

/// Phase 3 of the camera encode: brief writeback under the session lock. Camera
/// mirror of [`finish_screen_frame`] — orphans the carried encoder if the
/// generation moved while the lock was released.
#[cfg(feature = "vpx")]
pub fn finish_camera_frame(
    session: &mut NativeMediaSession,
    outcome: CameraFrameOutcome,
) -> Result<(), String> {
    if session.video_encoder_generation != outcome.generation {
        drop(outcome);
        return Ok(());
    }
    session.video_simulcast = Some(outcome.simulcast);
    session.video_seq = outcome.seq;
    session.video_timestamp = session.video_timestamp.wrapping_add(outcome.timestamp_step);
    session.video_applied_bitrate_kbps = outcome.applied_kbps;
    session.i420_convert_buf = outcome.i420_convert_buf;
    Ok(())
}

#[cfg(not(feature = "vpx"))]
pub struct CameraFrameJob;

#[cfg(not(feature = "vpx"))]
pub struct CameraFrameOutcome;

#[cfg(not(feature = "vpx"))]
pub async fn begin_camera_frame(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
    capture_time: std::time::SystemTime,
) -> Result<CameraFrameJob, String> {
    let _ = (session, width, height, input_is_bgra, app, capture_time);
    Err("camera encoding requires the 'vpx' feature".into())
}

#[cfg(not(feature = "vpx"))]
pub fn run_camera_frame(
    job: &mut CameraFrameJob,
    packed: &[u8],
    raw_width: u32,
    raw_height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
) -> Result<CameraFrameOutcome, String> {
    let _ = (job, packed, raw_width, raw_height, input_is_bgra, app);
    Err("camera encoding requires the 'vpx' feature".into())
}

#[cfg(not(feature = "vpx"))]
pub fn finish_camera_frame(
    session: &mut NativeMediaSession,
    outcome: CameraFrameOutcome,
) -> Result<(), String> {
    let _ = (session, outcome);
    Err("camera encoding requires the 'vpx' feature".into())
}

/// Work handed from [`begin_screen_frame`] (which runs briefly under the session
/// lock) to [`run_screen_frame`] (which runs the heavy encode with the lock
/// released). The encoder itself is moved out of the session into the job so the
/// per-frame pixel/encode/encrypt/send work touches no session state.
#[cfg(feature = "vpx")]
pub struct ScreenFrameJob {
    /// Encoder moved out of `session.screen_simulcast`; taken back out in
    /// `run_screen_frame` and returned via the outcome.
    simulcast: Option<super::session::NativeSimulcastState>,
    /// Generation snapshot; compared in `finish_screen_frame` to detect a
    /// stop/reconfigure that happened while the lock was released.
    generation: u64,
    layer_ssrcs: Vec<(u8, u32)>,
    fallback_ssrc: u32,
    stream_id: StreamId,
    track_id: TrackId,
    seq: u16,
    timestamp: u32,
    pts: i64,
    /// Wire PTS in microseconds derived from the frame's true capture time (L2),
    /// monotonic per track. Shared by every simulcast layer of this frame.
    capture_timestamp_us: u64,
    preset_kbps: u32,
    feedback_kbps: u32,
    applied_kbps: u32,
    key_epoch: u8,
    connection: quinn::Connection,
    max_fragment_payload: usize,
    frame_encryptor: Arc<Mutex<paracord_codec::crypto::FrameEncryptor>>,
    screen_force_keyframe: Arc<AtomicBool>,
    i420_convert_buf: Vec<u8>,
}

/// Results carried from [`run_screen_frame`] back to [`finish_screen_frame`].
#[cfg(feature = "vpx")]
pub struct ScreenFrameOutcome {
    simulcast: super::session::NativeSimulcastState,
    generation: u64,
    seq: u16,
    timestamp_step: u32,
    applied_kbps: u32,
    i420_convert_buf: Vec<u8>,
}

/// Phase 1 of the screen encode: brief work that must hold the session lock.
///
/// Chooses the codec, (re)creates the encoder if needed, publishes the track
/// before the first send, reads the sender-key epoch, and snapshots everything
/// the unlocked encode needs — moving the encoder and the conversion buffer out
/// of the session and into the returned job.
#[cfg(feature = "vpx")]
pub async fn begin_screen_frame(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
    capture_time: std::time::SystemTime,
) -> Result<ScreenFrameJob, String> {
    use paracord_codec::video::EncoderConfig;

    // Cropped-even dims computed from the raw capture dims; the actual crop copy
    // happens in `run_screen_frame`. Here we only need the dims the encoder is
    // (re)configured against.
    let frame_width = width & !1;
    let frame_height = height & !1;
    if frame_width == 0 || frame_height == 0 {
        return Err(format!(
            "video frame has unsupported dimensions: {width}x{height}"
        ));
    }

    let screen_config = session
        .screen_encoder_config
        .clone()
        .ok_or("screen encoder not active")?;
    let requested_codec = choose_best_publish_codec(
        session,
        session
            .screen_encoder_codec
            .unwrap_or_else(default_screen_codec),
        app,
    );
    session.screen_encoder_codec = Some(requested_codec);
    let (fitted_width, fitted_height) = fit_encode_dimensions(
        frame_width,
        frame_height,
        screen_config.width,
        screen_config.height,
    );
    let (encode_width, encode_height) =
        align_dimensions_for_codec(requested_codec, fitted_width, fitted_height);
    let desired_config = EncoderConfig {
        width: encode_width,
        height: encode_height,
        pixel_format: screen_encoder_input_format(requested_codec, input_is_bgra),
        ..screen_config.clone()
    };
    desired_config
        .validate()
        .map_err(|e| format!("screen encoder config: {e}"))?;
    let desired_layers = build_simulcast_configs(
        paracord_codec::video::SimulcastKind::Screen,
        requested_codec,
        desired_config.width,
        desired_config.height,
        desired_config.fps,
        desired_config.bitrate_kbps,
        desired_config.content_hint,
        desired_config.pixel_format,
    );
    let needs_reinit = session
        .screen_simulcast
        .as_ref()
        .map(|encoder| {
            encoder.input_width != frame_width
                || encoder.input_height != frame_height
                || encoder.codec
                    != session
                        .screen_encoder_codec
                        .unwrap_or_else(default_screen_codec)
                || encoder.layers != desired_layers
        })
        .unwrap_or(true);

    if needs_reinit {
        let encoder =
            create_screen_simulcast_encoder(session, frame_width, frame_height, &desired_layers)?;
        tracing::info!(
            codec = ?encoder.codec,
            backend = encoder.backend_name,
            hardware = encoder.hardware_accelerated,
            input_width = encoder.input_width,
            input_height = encoder.input_height,
            "configured native screen simulcast encoder"
        );
        session.screen_simulcast = Some(encoder);
        session.screen_encoder = None;
        session.screen_seq = 0;
        session.screen_timestamp = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
    }

    // Publish the track before the first send (moved from post-encode). Publish
    // only needs the encoder's layer configs, which exist now that any reinit
    // has run.
    if session.published_screen_track.is_none() {
        publish_screen_track_for_current_config(session, app).await?;
    }
    sync_published_video_track_metadata(session, true);

    // Sender-key epoch (its own async mutex). Missing key is a hard error,
    // exactly as before.
    let stream_id = local_video_stream_id(session, true);
    let track_id = local_video_track_id(true);
    let track_key_epoch = {
        let sender_keys = session.track_sender_keys.lock().await;
        sender_keys
            .get(&(stream_id.clone(), track_id.clone()))
            .map(|state| state.epoch)
    };
    let key_epoch = track_key_epoch.ok_or_else(|| {
        format!(
            "video sender key missing for {}:{}",
            stream_id.0, track_id.0
        )
    })?;

    // Adaptive-bitrate inputs: snapshot the relay feedback and the currently
    // applied rate; the retarget decision + hysteresis run in the encode phase.
    let preset_kbps = screen_config.bitrate_kbps;
    let feedback_kbps = session.screen_bitrate_feedback_kbps.load(Ordering::Relaxed);
    let applied_kbps = if session.screen_applied_bitrate_kbps == 0 {
        preset_kbps
    } else {
        session.screen_applied_bitrate_kbps
    };

    let pts = session.screen_pts;
    session.screen_pts = session.screen_pts.wrapping_add(1);

    // L2: derive the wire PTS from the frame's true capture time relative to the
    // first frame of this share, instead of a synthesized frame_index/fps. Kept
    // monotonic per track so a capture backend with a non-monotonic clock cannot
    // rewind playback timing.
    let base = *session.screen_capture_base_time.get_or_insert(capture_time);
    let raw_us = capture_time
        .duration_since(base)
        .map(|delta| delta.as_micros() as u64)
        .unwrap_or(session.screen_last_timestamp_us);
    let capture_timestamp_us = raw_us.max(session.screen_last_timestamp_us);
    session.screen_last_timestamp_us = capture_timestamp_us;

    let max_datagram_size = session
        .connection
        .max_datagram_size()
        .unwrap_or(FALLBACK_MAX_DATAGRAM_SIZE);
    let max_fragment_payload = max_datagram_size
        .saturating_sub(HEADER_SIZE + TAG_SIZE + 128)
        .max(256);

    let simulcast = session
        .screen_simulcast
        .take()
        .ok_or("screen encoder not active")?;
    let generation = session.screen_encoder_generation;
    let i420_convert_buf = std::mem::take(&mut session.i420_convert_buf);

    Ok(ScreenFrameJob {
        simulcast: Some(simulcast),
        generation,
        layer_ssrcs: session.screen_layer_ssrcs.clone(),
        fallback_ssrc: session.screen_ssrc,
        stream_id,
        track_id,
        seq: session.screen_seq,
        timestamp: session.screen_timestamp,
        pts,
        capture_timestamp_us,
        preset_kbps,
        feedback_kbps,
        applied_kbps,
        key_epoch,
        connection: session.connection.inner().clone(),
        max_fragment_payload,
        frame_encryptor: session.frame_encryptor.clone(),
        screen_force_keyframe: session.screen_force_keyframe.clone(),
        i420_convert_buf,
    })
}

/// Phase 2 of the screen encode: the heavy per-frame work, with NO session
/// access. Runs the crop copy, pixel conversion, adaptive-bitrate retarget,
/// encode, fragment/encrypt/send loop (with a LOCAL seq counter), the self-view
/// block, and the bounded frame diagnostics.
///
/// Must be called from within a tokio runtime context: the self-view
/// native-decode branch uses `tokio::spawn`.
#[cfg(feature = "vpx")]
pub fn run_screen_frame(
    job: &mut ScreenFrameJob,
    packed: &[u8],
    raw_width: u32,
    raw_height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
) -> Result<ScreenFrameOutcome, String> {
    use paracord_codec::video::{bgra_to_i420, rgba_to_i420, EncodedFrame, PixelFormat};

    let mut simulcast = job
        .simulcast
        .take()
        .ok_or("screen encoder missing from frame job")?;
    // Self-view consumes the TOP layer's exact bitstream (spec §4.1): pick by
    // layer id, never emission order, so a lower simulcast rung emitted later in
    // the drain never overwrites the top-layer preview.
    let top_layer_id: u8 = simulcast
        .layers
        .iter()
        .map(|(layer, _)| *layer as u8)
        .max()
        .unwrap_or(0);

    // Crop copy only if odd dims; the encoder was configured against these
    // cropped-even dims in `begin_screen_frame`.
    let (frame_width, frame_height, cropped_storage) = crop_to_even(packed, raw_width, raw_height)?;
    let packed = cropped_storage.as_deref().unwrap_or(packed);

    let source_pixel_format = if input_is_bgra {
        PixelFormat::Bgra
    } else {
        PixelFormat::Rgba
    };
    let expected_packed_size = source_pixel_format.frame_size(frame_width, frame_height);
    if packed.len() != expected_packed_size {
        return Err(format!(
            "video frame size mismatch: expected {expected_packed_size} bytes, got {}",
            packed.len()
        ));
    }

    let encoder_input_format = simulcast.encoder.input_format();
    let mut i420_buf = std::mem::take(&mut job.i420_convert_buf);
    let encode_input: &[u8] = match encoder_input_format {
        PixelFormat::I420 => {
            let i420_size = PixelFormat::I420.frame_size(frame_width, frame_height);
            if i420_buf.len() != i420_size {
                i420_buf.resize(i420_size, 0);
            }
            if input_is_bgra {
                bgra_to_i420(packed, frame_width, frame_height, &mut i420_buf);
            } else {
                rgba_to_i420(packed, frame_width, frame_height, &mut i420_buf);
            }
            // The encoder is constructed with input dimensions equal to the
            // capture size and scales to each layer's configured dimensions
            // internally (SimulcastEncoder for I420, ffmpeg filters for packed
            // input). Do NOT pre-scale here — handing it anything other than
            // capture-sized input is a frame size mismatch.
            i420_buf.as_slice()
        }
        PixelFormat::Rgba | PixelFormat::Bgra => {
            if encoder_input_format != source_pixel_format {
                return Err(format!(
                    "screen encoder expected {encoder_input_format:?} input but capture produced {source_pixel_format:?}"
                ));
            }
            packed
        }
    };

    let pts = job.pts;
    let force_keyframe = job.screen_force_keyframe.swap(false, Ordering::SeqCst);

    // Adaptive bitrate: track the relay's bandwidth estimate downward under
    // congestion and recover toward the preset cap when the path clears. The
    // 1/8 (12.5%) hysteresis keeps estimator noise from thrashing rate control.
    let preset_kbps = job.preset_kbps;
    let feedback_kbps = job.feedback_kbps;
    let applied_kbps = job.applied_kbps;
    let target_kbps = if feedback_kbps > 0 {
        preset_kbps
            .min((feedback_kbps.saturating_mul(85) / 100).max(MIN_ADAPTIVE_SCREEN_BITRATE_KBPS))
    } else {
        preset_kbps
    };

    let fps = simulcast
        .layers
        .last()
        .map(|(_, config)| config.fps.max(1))
        .unwrap_or(30);
    let mut new_applied_kbps = applied_kbps;
    if target_kbps > 0
        && target_kbps != applied_kbps
        && target_kbps.abs_diff(applied_kbps).saturating_mul(8) >= applied_kbps
    {
        match simulcast.encoder.set_top_layer_bitrate(target_kbps) {
            Ok(true) => {
                new_applied_kbps = target_kbps;
                tracing::info!(
                    from_kbps = applied_kbps,
                    to_kbps = target_kbps,
                    "retargeted screen encoder bitrate from relay bandwidth feedback"
                );
            }
            // Backend cannot retarget live (e.g. ffmpeg-vaapi); keep the current
            // rate rather than restarting the encoder mid-stream.
            Ok(false) => {}
            Err(err) => {
                tracing::debug!("screen encoder bitrate retarget failed: {err}");
            }
        }
    }

    // Empty output is NOT treated as an error: async backends (ffmpeg
    // VAAPI/NVENC) legitimately emit nothing while their pipeline warms up,
    // including after every keyframe-forced restart. Genuine backend death
    // surfaces as an encode error.
    let mut encoded_frames = simulcast
        .encoder
        .encode(pts, encode_input, force_keyframe)
        .map_err(|e| format!("video encode: {e}"))?;

    let timestamp_step = (90_000u32 / fps).max(1);
    let frame_timestamp = job.timestamp;
    let encoded_count = encoded_frames.len();
    // Local seq counter: only the encoder thread (or the sequential wrapper)
    // ever sends screen datagrams, so this is race-free and written back to the
    // session in `finish_screen_frame`.
    let mut local_seq = job.seq;
    // Single dispatch-state snapshot for this frame (N12a): whether a self-view
    // subscriber exists, whether it decodes in the webview, whether a frame is
    // already stored, and whether the tile is hidden. Used to gate the preview
    // clone below and to route the self-view without re-locking per predicate.
    let self_view_track_key = make_track_key(&job.stream_id.0, &job.track_id.0);
    let (sv_has_subscriber, sv_prefers_encoded, sv_has_stored, sv_hidden) =
        video_dispatch_snapshot(&self_view_track_key);
    let mut local_preview_frame: Option<LocalPreviewFrame> = None;
    for frame in encoded_frames.drain(..) {
        // L2: every simulcast layer of one captured frame shares that frame's
        // real capture PTS (they are the same instant), so the wire timestamp
        // tracks the true capture cadence rather than a frame-index approximation.
        let frame_timestamp_us = job.capture_timestamp_us;
        let frame_codec = frame.codec;
        let frame_width = frame.width;
        let frame_height = frame.height;
        let frame_data = frame.data;
        let frame_pts = frame.pts;
        let frame_is_keyframe = frame.is_keyframe;
        let layer_id = frame.layer.map(|layer| layer as u8).unwrap_or(0);
        let ssrc = job
            .layer_ssrcs
            .iter()
            .find_map(|(mapped_layer_id, ssrc)| (*mapped_layer_id == layer_id).then_some(*ssrc))
            .unwrap_or(job.fallback_ssrc);
        if should_send_on_stream(
            frame_is_keyframe,
            frame_data.len(),
            job.max_fragment_payload,
        ) {
            send_encoded_video_frame_stream(
                &job.connection,
                &job.frame_encryptor,
                job.key_epoch,
                ssrc,
                &mut local_seq,
                frame_timestamp,
                layer_id,
                frame_codec,
                frame_is_keyframe,
                &job.stream_id,
                &job.track_id,
                frame_pts.max(0) as u64,
                frame_timestamp_us,
                &frame_data,
            )?;
        } else {
            send_encoded_video_frame(
                &job.connection,
                &job.frame_encryptor,
                job.key_epoch,
                ssrc,
                &mut local_seq,
                frame_timestamp,
                job.max_fragment_payload,
                layer_id,
                frame_codec,
                frame_is_keyframe,
                &job.stream_id,
                &job.track_id,
                frame_pts.max(0) as u64,
                frame_timestamp_us,
                &frame_data,
            )?;
        }
        // Only clone the encoded bytes for the self-view when a subscriber is
        // actually watching (N12c): with no subscriber the clone is pure waste on
        // the encode hot path.
        // Clone the encoded bytes for the self-view only for the TOP layer (the
        // exact bitstream a top-layer viewer receives) and only when a subscriber
        // is watching (N12c) — selection is by layer id, not drain order.
        if sv_has_subscriber && layer_id == top_layer_id {
            local_preview_frame = Some(LocalPreviewFrame {
                timestamp_us: frame_timestamp_us,
                is_keyframe: frame_is_keyframe,
                codec: frame_codec,
                colorspace: frame.colorspace,
                pts: frame_pts,
                width: frame_width,
                height: frame_height,
                data: frame_data.clone(),
            });
        }
        let debug_index = VIDEO_SEND_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed);
        if debug_index < 24 {
            eprintln!(
                "[native-video-debug] sent video datagram stream={} track={} ssrc={} layer={} epoch={} keyframe={} bytes={}",
                job.stream_id.0,
                job.track_id.0,
                ssrc,
                layer_id,
                job.key_epoch,
                frame_is_keyframe,
                frame_data.len(),
            );
        }
    }
    // Self-view: the host watches the exact bitstream remote viewers receive —
    // same codec, resolution, framerate, and bitrate. There is deliberately no
    // raw or downscaled preview side-channel. Publish already happened in
    // `begin_screen_frame`, so screen frames are always sendable here.
    let can_send_screen_frames = true;
    let screen_diag_index = SCREEN_DIAG_COUNT.fetch_add(1, Ordering::Relaxed);
    let mut self_view_action = "no-preview-frame";
    let preview_summary = local_preview_frame
        .as_ref()
        .map(|preview| (preview.is_keyframe, preview.data.len()));
    {
        let track_key = &self_view_track_key;
        if !sv_has_subscriber {
            self_view_action = "no-subscriber";
        } else if let Some(preview) = local_preview_frame {
            if !preview.is_keyframe && !sv_has_stored {
                self_view_action = "await-keyframe";
                // A decoder (webview or native) joining mid-stream can only start
                // on an intra frame; force one instead of storing an undecodable
                // delta.
                job.screen_force_keyframe.store(true, Ordering::SeqCst);
            } else if sv_prefers_encoded {
                // Webview decodes the stream itself: hand it the encoded frame
                // verbatim. Frames are tens of KB and the decoder needs every
                // delta for prediction, so nothing is throttled.
                self_view_action = "stored-encoded";
                let label = codec_label(preview.codec);
                store_pulled_video_frame(
                    track_key,
                    preview.timestamp_us,
                    preview.is_keyframe,
                    label,
                    label,
                    preview.width,
                    preview.height,
                    preview.colorspace.header_tag(),
                    preview.data,
                    !sv_hidden,
                );
            } else {
                // Webview can't decode this codec: run the encoded frame through
                // the same per-track decode worker remote subscribers use, off
                // the encode thread and strictly ordered. A decoder that cannot
                // make progress forces our own encoder to emit a keyframe
                // directly (LocalEncoder sink) — no relay round-trip.
                self_view_action = "native-decode";
                let encoded = EncodedFrame {
                    data: preview.data,
                    codec: preview.codec,
                    pts: preview.pts,
                    is_keyframe: preview.is_keyframe,
                    layer: None,
                    width: preview.width,
                    height: preview.height,
                    colorspace: preview.colorspace,
                };
                let frame = ReassembledVideoFrame {
                    frame_id: preview.pts.max(0) as u64,
                    timestamp_us: preview.timestamp_us,
                    encoded,
                    simulcast_layer: 0,
                };
                let sink = KeyframeSink::LocalEncoder {
                    force_keyframe: job.screen_force_keyframe.clone(),
                };
                dispatch_frame_to_worker(track_key, frame, sink);
            }
        }
    }
    if screen_diag_index < SCREEN_DIAG_FRAMES {
        let codec = format!("{:?}", simulcast.codec);
        let backend = simulcast.backend_name;
        native_diag(
            app,
            &format!(
                "screen frame {screen_diag_index}: encoded={encoded_count} preview(kf,bytes)={preview_summary:?} \
                 published={can_send_screen_frames} self_view={self_view_action} codec={codec} \
                 backend={backend} track={}:{}",
                job.stream_id.0, job.track_id.0
            ),
        );
    }

    Ok(ScreenFrameOutcome {
        simulcast,
        generation: job.generation,
        seq: local_seq,
        timestamp_step,
        applied_kbps: new_applied_kbps,
        i420_convert_buf: i420_buf,
    })
}

/// Phase 3 of the screen encode: brief writeback under the session lock.
///
/// If the encoder generation moved while the lock was released (a
/// stop/reconfigure happened mid-frame), the carried encoder is orphaned: drop
/// it and leave the new session state untouched. Otherwise restore the encoder
/// and commit the frame's seq/timestamp/bitrate/buffer.
#[cfg(feature = "vpx")]
pub fn finish_screen_frame(
    session: &mut NativeMediaSession,
    outcome: ScreenFrameOutcome,
) -> Result<(), String> {
    if session.screen_encoder_generation != outcome.generation {
        // The stream was stopped or reconfigured while this frame encoded; drop
        // the now-orphaned encoder and do not resurrect any state.
        drop(outcome);
        return Ok(());
    }
    session.screen_simulcast = Some(outcome.simulcast);
    session.screen_seq = outcome.seq;
    session.screen_timestamp = session
        .screen_timestamp
        .wrapping_add(outcome.timestamp_step);
    session.screen_applied_bitrate_kbps = outcome.applied_kbps;
    session.i420_convert_buf = outcome.i420_convert_buf;
    Ok(())
}

#[cfg(not(feature = "vpx"))]
pub struct ScreenFrameJob;

#[cfg(not(feature = "vpx"))]
pub struct ScreenFrameOutcome;

#[cfg(not(feature = "vpx"))]
pub async fn begin_screen_frame(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
    capture_time: std::time::SystemTime,
) -> Result<ScreenFrameJob, String> {
    let _ = (session, width, height, input_is_bgra, app, capture_time);
    Err("screen share encoding requires the 'vpx' feature".into())
}

#[cfg(not(feature = "vpx"))]
pub fn run_screen_frame(
    job: &mut ScreenFrameJob,
    packed: &[u8],
    raw_width: u32,
    raw_height: u32,
    input_is_bgra: bool,
    app: Option<&AppHandle>,
) -> Result<ScreenFrameOutcome, String> {
    let _ = (job, packed, raw_width, raw_height, input_is_bgra, app);
    Err("screen share encoding requires the 'vpx' feature".into())
}

#[cfg(not(feature = "vpx"))]
pub fn finish_screen_frame(
    session: &mut NativeMediaSession,
    outcome: ScreenFrameOutcome,
) -> Result<(), String> {
    let _ = (session, outcome);
    Err("screen share encoding requires the 'vpx' feature".into())
}

#[cfg(feature = "vpx")]
fn fit_encode_dimensions(
    src_width: u32,
    src_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    if src_width == 0 || src_height == 0 || max_width == 0 || max_height == 0 {
        return (src_width, src_height);
    }

    if src_width <= max_width && src_height <= max_height {
        return (src_width, src_height);
    }

    let width_limited =
        (max_width as u64 * src_height as u64) <= (max_height as u64 * src_width as u64);
    let (mut fitted_width, mut fitted_height) = if width_limited {
        let fitted_height = ((src_height as u64 * max_width as u64) / src_width as u64) as u32;
        (max_width, fitted_height)
    } else {
        let fitted_width = ((src_width as u64 * max_height as u64) / src_height as u64) as u32;
        (fitted_width, max_height)
    };

    fitted_width = fitted_width.clamp(2, max_width);
    fitted_height = fitted_height.clamp(2, max_height);

    if fitted_width % 2 != 0 {
        fitted_width = fitted_width.saturating_sub(1);
    }
    if fitted_height % 2 != 0 {
        fitted_height = fitted_height.saturating_sub(1);
    }

    (fitted_width.max(2), fitted_height.max(2))
}

#[cfg(feature = "vpx")]
fn align_dimensions_for_codec(codec: VideoCodec, width: u32, height: u32) -> (u32, u32) {
    let alignment = match codec {
        VideoCodec::H264 => 2,
        VideoCodec::Av1 | VideoCodec::Vp9 => 2,
    };

    let mut aligned_width = width.max(alignment);
    let mut aligned_height = height.max(alignment);

    let width_remainder = aligned_width % alignment;
    if width_remainder != 0 {
        aligned_width = aligned_width.saturating_sub(width_remainder);
    }

    let height_remainder = aligned_height % alignment;
    if height_remainder != 0 {
        aligned_height = aligned_height.saturating_sub(height_remainder);
    }

    (aligned_width.max(alignment), aligned_height.max(alignment))
}

#[cfg(feature = "vpx")]
fn screen_encoder_input_format(
    codec: VideoCodec,
    input_is_bgra: bool,
) -> paracord_codec::video::PixelFormat {
    use paracord_codec::video::PixelFormat;

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // ffmpeg hardware backends (lavc H.264/AV1) consume packed frames directly
        // and do the color conversion + scaling on the GPU — no CPU pixel work at
        // all. This holds for the all-hardware simulcast case too (spec §4.1): the
        // SimulcastEncoder routes the packed capture buffer to every layer encoder
        // (each built new_with_input(capture → layer)) with no CPU convert or
        // downscale, so packed input is chosen whenever the codec is lavc hardware.
        if codec == VideoCodec::H264 || codec == VideoCodec::Av1 {
            return if input_is_bgra {
                PixelFormat::Bgra
            } else {
                PixelFormat::Rgba
            };
        }
    }

    let _ = (codec, input_is_bgra);
    PixelFormat::I420
}

/// Handle an incoming video datagram: reassemble fragments, natively decode
/// (VP9) into I420 or pass encoded frames through, store the result for the
/// pull mechanism, and request a keyframe from the sender when the decoder
/// cannot make progress.
pub fn handle_video_datagram(
    header: &MediaHeader,
    decrypted_payload: &[u8],
    app: &tauri::AppHandle,
    conn: &quinn::Connection,
) {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::EncodedFrame;
        let debug_index = VIDEO_HANDLE_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed);
        if debug_index < 24 {
            eprintln!(
                "[native-video-debug] handle video datagram ssrc={} seq={} layer={} epoch={} payload={}",
                header.ssrc,
                header.sequence,
                header.simulcast_layer,
                header.key_epoch,
                decrypted_payload.len(),
            );
        }

        let Some((metadata, encoded_bytes)) = reassemble_video_payload(header, decrypted_payload)
        else {
            return;
        };

        let timestamp_us = metadata.timestamp_us;
        let codec = transport_codec_to_codec(metadata.codec);
        let encoded = EncodedFrame {
            data: encoded_bytes,
            codec,
            pts: frame_id_to_pts(metadata.frame_id),
            is_keyframe: metadata.is_keyframe,
            layer: None,
            width: 0,
            height: 0,
            // The QUIC video datagram does not carry a colorspace tag; the whole
            // pipeline targets BT.709, so received frames are read as BT.709.
            // Native decode overrides this with the decoder's reported colorspace
            // when it stores the raw I420 result.
            colorspace: paracord_codec::video::ColorSpace::default(),
        };
        // The metadata's stream/track identity is what selects the reassembly
        // pool, decode worker, decoder instance, surface binding and webview
        // channel — but it is sender-chosen and unauthenticated. Only `ssrc` is
        // authorized by the relay, so the two must agree before this frame is
        // allowed to act as that track.
        let track_key = make_track_key(&metadata.stream_id.0, &metadata.track_id.0);
        if !video_frame_identity_is_authorized(header.ssrc, &track_key) {
            tracing::debug!(
                ssrc = header.ssrc,
                claimed = %track_key,
                "dropping video datagram whose claimed track identity does not match its ssrc"
            );
            return;
        }
        {
            // Hand the frame to this track's dedicated decode worker: it reorders
            // by frame_id, decodes strictly FIFO on the blocking pool, downscales
            // to the viewport, and stores/pushes the result. Overflow and
            // undecodable frames drive the keyframe request through the sink.
            let frame = ReassembledVideoFrame {
                frame_id: metadata.frame_id,
                timestamp_us,
                encoded,
                simulcast_layer: header.simulcast_layer,
            };
            let sink = KeyframeSink::Upstream {
                conn: conn.clone(),
                app: app.clone(),
                stream_id: metadata.stream_id.clone(),
                track_id: metadata.track_id.clone(),
            };
            dispatch_frame_to_worker(&track_key, frame, sink);
        }
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (header, decrypted_payload, app, conn);
    }
}

/// Handle a whole keyframe (or large frame) delivered on a QUIC unidirectional
/// stream: parse the length-delimited message, decrypt the single AEAD unit with
/// the wire header as AAD, and feed it into the SAME per-track reorder/decode
/// pipeline the datagram deltas use (keyed by frame_id) so stream/datagram
/// interleaving stays ordered.
///
/// `body` is one complete stream message (read to the stream's FIN).
pub fn handle_video_stream_frame(
    body: &[u8],
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameDecryptor>>,
    app: &tauri::AppHandle,
    conn: &quinn::Connection,
) {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::EncodedFrame;

        if body.len() < HEADER_SIZE {
            return;
        }
        let frame = match MediaStreamFrame::decode(body) {
            Ok(frame) => frame,
            Err(err) => {
                tracing::debug!("invalid keyframe stream frame: {err}");
                return;
            }
        };
        let header = &frame.header;
        let metadata = &frame.metadata;

        // Decrypt the whole-frame ciphertext. The AAD is the exact 16 wire header
        // bytes, so it is byte-identical to what the sender bound at encrypt time.
        let header_bytes: [u8; HEADER_SIZE] =
            body[..HEADER_SIZE].try_into().expect("header is 16 bytes");
        let decrypted = {
            let mut decryptor = match frame_decryptor.lock() {
                Ok(decryptor) => decryptor,
                Err(_) => return,
            };
            let result = decryptor.decrypt(
                &header_bytes,
                header.ssrc,
                header.key_epoch,
                header.sequence,
                &frame.payload,
            );
            super::events::note_decrypt_result(app, header.ssrc, result.is_ok());
            match result {
                Ok(data) => data,
                Err(_) => return,
            }
        };

        let track_key = make_track_key(&metadata.stream_id.0, &metadata.track_id.0);

        // Same identity cross-check as the datagram path: successful AEAD proves
        // only that the frame was encrypted under a key installed for this SSRC,
        // not that its self-declared stream/track identity is genuine.
        if !video_frame_identity_is_authorized(header.ssrc, &track_key) {
            tracing::debug!(
                ssrc = header.ssrc,
                claimed = %track_key,
                "dropping keyframe stream whose claimed track identity does not match its ssrc"
            );
            return;
        }

        // L1 backpressure / stale-stream culling: a keyframe superseded by a
        // newer one (which a faster or already-drained stream delivered first) is
        // dropped rather than decoded. Only keyframes gate here; a large delta on
        // the stream path is left to the reorder stage's frame_id ordering.
        if metadata.is_keyframe && !stream_frame_is_newest(&track_key, metadata.frame_id) {
            return;
        }

        let encoded = EncodedFrame {
            data: decrypted,
            codec: transport_codec_to_codec(metadata.codec),
            pts: frame_id_to_pts(metadata.frame_id),
            is_keyframe: metadata.is_keyframe,
            layer: None,
            width: 0,
            height: 0,
            // The wire frame carries no colorspace tag; the pipeline targets
            // BT.709, and native decode overrides this with the decoder's
            // reported colorspace when it stores raw I420.
            colorspace: paracord_codec::video::ColorSpace::default(),
        };
        let reassembled = ReassembledVideoFrame {
            frame_id: metadata.frame_id,
            timestamp_us: metadata.timestamp_us,
            encoded,
            simulcast_layer: header.simulcast_layer,
        };
        let sink = KeyframeSink::Upstream {
            conn: conn.clone(),
            app: app.clone(),
            stream_id: metadata.stream_id.clone(),
            track_id: metadata.track_id.clone(),
        };
        dispatch_frame_to_worker(&track_key, reassembled, sink);
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (body, frame_decryptor, app, conn);
    }
}

/// Advance the per-track keyframe high-water mark, returning `false` when
/// `frame_id` is not newer than a keyframe already accepted from a uni stream
/// (so this stale keyframe should be culled).
#[cfg(feature = "vpx")]
fn stream_frame_is_newest(track_key: &str, frame_id: u64) -> bool {
    let mut state = match video_dispatch_state().lock() {
        Ok(state) => state,
        Err(_) => return true,
    };
    match state.remote_track_stream_high_water.get(track_key) {
        Some(&high_water) if frame_id <= high_water => false,
        _ => {
            state
                .remote_track_stream_high_water
                .insert(track_key.to_string(), frame_id);
            true
        }
    }
}

#[cfg(feature = "vpx")]
fn send_encoded_video_frame(
    connection: &quinn::Connection,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    key_epoch: u8,
    ssrc: u32,
    seq: &mut u16,
    frame_timestamp: u32,
    max_fragment_payload: usize,
    simulcast_layer: u8,
    codec: VideoCodec,
    is_keyframe: bool,
    stream_id: &StreamId,
    track_id: &TrackId,
    frame_id: u64,
    frame_timestamp_us: u64,
    frame_data: &[u8],
) -> Result<(), String> {
    if frame_data.is_empty() {
        return Ok(());
    }

    let fragment_count = frame_data.len().div_ceil(max_fragment_payload);
    let fragment_count_u16 =
        u16::try_from(fragment_count).map_err(|_| "video frame requires too many fragments")?;

    // L3: a burst above the pacing threshold is trickled out with a short gap
    // between fragments (off the encode thread) so audio datagrams never sit
    // behind it. Smaller frames send inline, byte-for-byte as before.
    let paced = fragment_count > AUDIO_PACING_FRAGMENT_THRESHOLD;
    let mut pending_datagrams: Vec<Bytes> = if paced {
        Vec::with_capacity(fragment_count)
    } else {
        Vec::new()
    };

    // Lock the frame encryptor once for the whole frame (N12b) rather than once
    // per fragment. All fragment encryption happens inside this single guard; no
    // `.await` occurs in the loop, so holding the std mutex across it is sound.
    let mut encryptor = frame_encryptor
        .lock()
        .map_err(|_| "video frame encryptor lock poisoned".to_string())?;

    for (fragment_index, fragment) in frame_data.chunks(max_fragment_payload).enumerate() {
        let fragment_index_u16 =
            u16::try_from(fragment_index).map_err(|_| "video fragment index overflow")?;

        let metadata = VideoFrameMetadata {
            stream_id: stream_id.clone(),
            track_id: track_id.clone(),
            frame_id,
            layer_id: simulcast_layer,
            codec: codec_to_transport(codec),
            timestamp_us: frame_timestamp_us,
            is_keyframe,
            fragment_index: fragment_index_u16,
            fragment_count: fragment_count_u16,
        };
        let mut plaintext = Vec::with_capacity(128 + fragment.len());
        let mut metadata_buf = BytesMut::new();
        metadata
            .encode(&mut metadata_buf)
            .map_err(|e| format!("video metadata encode: {e}"))?;
        plaintext.extend_from_slice(&metadata_buf);
        plaintext.extend_from_slice(fragment);

        let mut header = MediaHeader::new(TrackType::Video, ssrc);
        header.sequence = *seq;
        header.timestamp = frame_timestamp;
        header.key_epoch = key_epoch;
        header.simulcast_layer = simulcast_layer;
        header.codec = codec.header_id();

        let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
        header.encode(&mut header_buf);
        let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
            .try_into()
            .expect("header is 16 bytes");

        let encrypted = encryptor
            .encrypt(&header_bytes, ssrc, key_epoch, *seq, &plaintext)
            .map_err(|e| format!("video encrypt: {e:?}"))?;

        header.payload_length = encrypted.len() as u16;

        let mut buf = BytesMut::with_capacity(HEADER_SIZE + encrypted.len());
        header.encode(&mut buf);
        buf.put_slice(&encrypted);

        let datagram = buf.freeze();
        if paced {
            pending_datagrams.push(datagram);
        } else {
            connection
                .send_datagram(datagram)
                .map_err(|e| format!("video datagram send: {e}"))?;
        }

        *seq = seq.wrapping_add(1);
    }
    drop(encryptor);

    if paced {
        let connection = connection.clone();
        tokio::spawn(async move {
            for datagram in pending_datagrams {
                if connection.send_datagram(datagram).is_err() {
                    break;
                }
                tokio::time::sleep(AUDIO_PACING_INTERVAL).await;
            }
        });
    }

    Ok(())
}

/// Whether an encoded frame should take the reliable uni-stream path instead of
/// fire-and-forget datagrams: always for keyframes (the burst that most often
/// dies under loss and triggers the keyframe-request death spiral), and for any
/// delta large enough that all-or-nothing datagram reassembly would rarely
/// survive real packet loss.
#[cfg(feature = "vpx")]
fn should_send_on_stream(is_keyframe: bool, frame_len: usize, max_fragment_payload: usize) -> bool {
    is_keyframe || frame_len.div_ceil(max_fragment_payload.max(1)) > STREAM_FRAGMENT_THRESHOLD
}

/// Build the wire bytes for one whole-frame uni-stream message: encrypt the
/// entire frame as a single AEAD unit (16-byte MediaHeader as AAD, nonce from
/// `(ssrc, epoch, seq)`) and serialize `header + metadata + ciphertext`.
///
/// The header is built once and never mutated so the bytes bound as AAD are
/// byte-identical to the header the receiver reads off the wire (the whole-frame
/// payload is delimited by the stream FIN, so `payload_length` stays 0).
#[cfg(feature = "vpx")]
#[allow(clippy::too_many_arguments)]
fn encode_stream_frame_message(
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    key_epoch: u8,
    ssrc: u32,
    seq: u16,
    frame_timestamp: u32,
    simulcast_layer: u8,
    codec: VideoCodec,
    is_keyframe: bool,
    stream_id: &StreamId,
    track_id: &TrackId,
    frame_id: u64,
    frame_timestamp_us: u64,
    frame_data: &[u8],
) -> Result<Bytes, String> {
    let mut header = MediaHeader::new(TrackType::Video, ssrc);
    header.sequence = seq;
    header.timestamp = frame_timestamp;
    header.key_epoch = key_epoch;
    header.simulcast_layer = simulcast_layer;
    header.codec = codec.header_id();

    let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
    header.encode(&mut header_buf);
    let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
        .try_into()
        .expect("header is 16 bytes");

    let ciphertext = {
        let mut encryptor = frame_encryptor
            .lock()
            .map_err(|_| "video frame encryptor lock poisoned".to_string())?;
        encryptor
            .encrypt(&header_bytes, ssrc, key_epoch, seq, frame_data)
            .map_err(|e| format!("video stream encrypt: {e:?}"))?
    };

    let metadata = VideoFrameMetadata {
        stream_id: stream_id.clone(),
        track_id: track_id.clone(),
        frame_id,
        layer_id: simulcast_layer,
        codec: codec_to_transport(codec),
        timestamp_us: frame_timestamp_us,
        is_keyframe,
        fragment_index: 0,
        fragment_count: 1,
    };
    MediaStreamFrame {
        header,
        metadata,
        payload: Bytes::from(ciphertext),
    }
    .encode()
    .map_err(|e| format!("video stream frame encode: {e}"))
}

/// Send one whole encoded frame on a fresh QUIC unidirectional stream (the
/// loss-resilient keyframe path).
///
/// The frame is encrypted as ONE AEAD unit — plaintext is the entire frame, the
/// 16-byte MediaHeader is the AAD, and the nonce derives from the same
/// `(ssrc, epoch, sequence)` scheme as the datagram path. The header is built
/// once and left immutable so the bytes bound as AAD are byte-identical to the
/// bytes on the wire (the whole-frame path is length-delimited by the stream's
/// FIN, so `payload_length` is not needed and stays 0). One sequence number is
/// consumed from the shared per-`(ssrc, epoch)` counter so the nonce never
/// collides with a datagram fragment's.
#[cfg(feature = "vpx")]
#[allow(clippy::too_many_arguments)]
fn send_encoded_video_frame_stream(
    connection: &quinn::Connection,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    key_epoch: u8,
    ssrc: u32,
    seq: &mut u16,
    frame_timestamp: u32,
    simulcast_layer: u8,
    codec: VideoCodec,
    is_keyframe: bool,
    stream_id: &StreamId,
    track_id: &TrackId,
    frame_id: u64,
    frame_timestamp_us: u64,
    frame_data: &[u8],
) -> Result<(), String> {
    if frame_data.is_empty() {
        return Ok(());
    }

    let this_seq = *seq;
    let message = encode_stream_frame_message(
        frame_encryptor,
        key_epoch,
        ssrc,
        this_seq,
        frame_timestamp,
        simulcast_layer,
        codec,
        is_keyframe,
        stream_id,
        track_id,
        frame_id,
        frame_timestamp_us,
        frame_data,
    )?;

    // One whole frame per uni stream: open, write, finish. The send runs off the
    // encode thread (open_uni is async); frame ordering is preserved by the
    // synchronous sequence assignment above and re-established at the receiver by
    // the per-track frame_id reorder stage.
    let connection = connection.clone();
    tokio::spawn(async move {
        match connection.open_uni().await {
            Ok(mut send) => {
                if let Err(e) = send.write_all(&message).await {
                    tracing::debug!("keyframe uni-stream write failed: {e}");
                    return;
                }
                let _ = send.finish();
            }
            Err(e) => tracing::debug!("keyframe uni-stream open failed: {e}"),
        }
    });

    *seq = seq.wrapping_add(1);
    Ok(())
}

#[cfg(feature = "vpx")]
fn reassemble_video_payload(
    header: &MediaHeader,
    decrypted_payload: &[u8],
) -> Option<(VideoFrameMetadata, Vec<u8>)> {
    let (metadata, chunk) = decode_video_fragment_payload(header, decrypted_payload)?;

    if metadata.fragment_count == 1 {
        return Some((metadata, chunk));
    }

    let key = format!(
        "{}:{}:{}",
        metadata.stream_id.0, metadata.track_id.0, metadata.frame_id
    );
    let now = Instant::now();
    let mut pool = video_reassembly_pool().lock().ok()?;

    // The TTL sweep used to be a full O(n) `retain` on EVERY fragment, so a
    // large pool made fragment handling quadratic — an attacker-controlled cost,
    // since the pool key (stream:track:frame) is entirely attacker-chosen.
    // Sweep on a timer instead, and additionally whenever the pool is over its
    // entry cap (which is the only case where a stale entry actually matters).
    let due_for_sweep = last_reassembly_sweep()
        .lock()
        .ok()
        .map(|mut last| {
            if now.duration_since(*last) >= VIDEO_REASSEMBLY_SWEEP_INTERVAL {
                *last = now;
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if due_for_sweep || pool.len() >= MAX_INFLIGHT_REASSEMBLY_FRAMES {
        pool.retain(|_, state| now.duration_since(state.last_update) <= VIDEO_REASSEMBLY_TTL);
    }

    // Hard cap on concurrent partial frames. Each entry holds a slot vector
    // sized from the wire's `fragment_count`, so without a cap a stream of
    // single fragments with distinct (attacker-chosen) frame ids grows the pool
    // without bound. Once at capacity, only fragments for frames already being
    // reassembled are accepted.
    if !pool.contains_key(&key) && pool.len() >= MAX_INFLIGHT_REASSEMBLY_FRAMES {
        tracing::debug!(
            ssrc = header.ssrc,
            inflight = pool.len(),
            "video reassembly pool at capacity; dropping fragment for a new frame"
        );
        return None;
    }

    let state = pool
        .entry(key.clone())
        .or_insert_with(|| VideoReassemblyState {
            fragment_count: metadata.fragment_count,
            is_keyframe: metadata.is_keyframe,
            chunks: vec![None; metadata.fragment_count as usize],
            received: 0,
            last_update: now,
        });

    if state.fragment_count != metadata.fragment_count {
        *state = VideoReassemblyState {
            fragment_count: metadata.fragment_count,
            is_keyframe: metadata.is_keyframe,
            chunks: vec![None; metadata.fragment_count as usize],
            received: 0,
            last_update: now,
        };
    } else {
        state.is_keyframe = metadata.is_keyframe;
        state.last_update = now;
    }

    let slot = &mut state.chunks[metadata.fragment_index as usize];
    if slot.is_none() {
        *slot = Some(chunk);
        state.received += 1;
    }

    if state.received != state.fragment_count as usize {
        return None;
    }

    let state = pool.remove(&key)?;
    let total_len: usize = state
        .chunks
        .iter()
        .filter_map(|chunk| chunk.as_ref())
        .map(Vec::len)
        .sum();
    let mut frame = Vec::with_capacity(total_len);
    for chunk in state.chunks {
        frame.extend_from_slice(chunk.as_deref()?);
    }
    Some((metadata, frame))
}

#[cfg(feature = "vpx")]
fn decode_video_fragment_payload(
    header: &MediaHeader,
    decrypted_payload: &[u8],
) -> Option<(VideoFrameMetadata, Vec<u8>)> {
    let mut cursor = decrypted_payload;
    if let Ok(metadata) = VideoFrameMetadata::decode(&mut cursor) {
        // `VideoFrameMetadata::decode` already enforces
        // `0 < fragment_count <= MAX_FRAGMENTS_PER_FRAME` and
        // `fragment_index < fragment_count`. This second cap is tighter still:
        // it bounds a partial frame by what a whole frame is allowed to be
        // (MAX_STREAM_FRAME_SIZE) at the smallest datagram a sender can use, so
        // the slot vector can never exceed what a real frame would need.
        if metadata.fragment_count as usize > MAX_REASSEMBLY_FRAGMENTS {
            return None;
        }
        return Some((metadata, cursor.to_vec()));
    }
    let _ = header;
    None
}

#[cfg(feature = "vpx")]
fn local_video_stream_id(session: &NativeMediaSession, is_screen: bool) -> StreamId {
    if is_screen {
        if let Some(track) = session.published_screen_track.as_ref() {
            return track.stream_id.clone();
        }
        return StreamId::new(format!("stream:{}:screen", session.session_id));
    }
    if let Some(track) = session.published_video_track.as_ref() {
        return track.stream_id.clone();
    }
    StreamId::new(format!("stream:{}:camera", session.session_id))
}

#[cfg(feature = "vpx")]
fn local_video_track_id(is_screen: bool) -> TrackId {
    if is_screen {
        TrackId::new("screen")
    } else {
        TrackId::new("camera")
    }
}

#[cfg(feature = "vpx")]
fn sync_published_video_track_metadata(session: &mut NativeMediaSession, is_screen: bool) {
    let updated_track = if is_screen {
        match super::screen_capture::build_screen_track(session) {
            Ok(track) => track,
            Err(_) => return,
        }
    } else {
        match build_camera_track(session) {
            Ok(track) => track,
            Err(_) => return,
        }
    };

    let current_track = if is_screen {
        session.published_screen_track.as_ref()
    } else {
        session.published_video_track.as_ref()
    };
    let Some(current_track) = current_track else {
        return;
    };
    if current_track == &updated_track {
        return;
    }
    let layers_only_update = current_track.stream_id == updated_track.stream_id
        && current_track.track_id == updated_track.track_id
        && current_track.publisher_user_id == updated_track.publisher_user_id
        && current_track.kind == updated_track.kind
        && current_track.codec == updated_track.codec;

    if is_screen {
        session.published_screen_track = Some(updated_track.clone());
    } else {
        session.published_video_track = Some(updated_track.clone());
    }

    let registry = session.stream_registry.clone();
    let conn = session.connection.inner().clone();
    tokio::spawn(async move {
        {
            let mut registry = registry.lock().await;
            registry.publish_track(updated_track.clone());
        }
        let message = if layers_only_update {
            paracord_transport::control::ControlMessage::TrackLayers {
                stream_id: updated_track.stream_id.clone(),
                track_id: updated_track.track_id.clone(),
                layers: updated_track.layers.clone(),
            }
        } else {
            paracord_transport::control::ControlMessage::TrackPublish {
                track: updated_track,
            }
        };
        let _ = send_control_message(&conn, &message).await;
    });
}

#[cfg(feature = "vpx")]
async fn send_control_message(
    conn: &quinn::Connection,
    message: &paracord_transport::control::ControlMessage,
) -> Result<(), String> {
    let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let encoded = message.encode().map_err(|e| e.to_string())?;
    send.write_all(&encoded).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(feature = "vpx")]
fn codec_to_transport(codec: VideoCodec) -> TransportVideoCodec {
    match codec {
        VideoCodec::Vp9 => TransportVideoCodec::Vp9,
        VideoCodec::Av1 => TransportVideoCodec::Av1,
        VideoCodec::H264 => TransportVideoCodec::H264,
    }
}

#[cfg(feature = "vpx")]
fn transport_codec_to_codec(codec: TransportVideoCodec) -> VideoCodec {
    match codec {
        TransportVideoCodec::Vp9 => VideoCodec::Vp9,
        TransportVideoCodec::Av1 => VideoCodec::Av1,
        TransportVideoCodec::H264 => VideoCodec::H264,
    }
}

/// Publish the camera track for the current encoder config and emit the
/// `media_track_publish` app event the webview waits on. Camera mirror of
/// [`publish_screen_track_for_current_config`], called once from
/// [`begin_camera_frame`] before the first send.
#[cfg(feature = "vpx")]
pub async fn publish_camera_track_for_current_config(
    session: &mut NativeMediaSession,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let track = build_camera_track(session)?;
    ensure_track_sender_key(session, &track).await?;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.publish_track(track.clone());
    }
    session
        .send_control_message(&paracord_transport::control::ControlMessage::TrackPublish {
            track: track.clone(),
        })
        .await?;
    session.published_video_track = Some(track.clone());
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("media_track_publish", track);
    }
    Ok(())
}

#[cfg(feature = "vpx")]
fn build_camera_track(
    session: &NativeMediaSession,
) -> Result<paracord_transport::stream::PublishedTrack, String> {
    let (codec, layers) = if let Some(simulcast) = session.video_simulcast.as_ref() {
        let active_layer_id = simulcast
            .layers
            .last()
            .map(|(layer, _)| *layer as u8)
            .unwrap_or(0);
        let layers = simulcast
            .layers
            .iter()
            .map(|(layer, layer_config)| {
                let layer_id = *layer as u8;
                let width = u16::try_from(layer_config.width)
                    .map_err(|_| format!("camera track width too large: {}", layer_config.width))?;
                let height = u16::try_from(layer_config.height).map_err(|_| {
                    format!("camera track height too large: {}", layer_config.height)
                })?;
                let ssrc = simulcast
                    .ssrcs
                    .iter()
                    .find_map(|(mapped_layer_id, ssrc)| {
                        (*mapped_layer_id == layer_id).then_some(*ssrc)
                    })
                    .unwrap_or(session.video_ssrc);
                Ok(paracord_transport::stream::PublishedLayer {
                    layer_id,
                    ssrc,
                    width: Some(width),
                    height: Some(height),
                    max_bitrate_kbps: Some(layer_config.bitrate_kbps),
                    active: layer_id == active_layer_id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        (codec_to_transport(simulcast.codec), layers)
    } else {
        let encoder = session
            .video_encoder
            .as_ref()
            .ok_or("video encoder not active while publishing camera track")?;
        let config = encoder.config();
        let width = u16::try_from(config.width)
            .map_err(|_| format!("camera track width too large: {}", config.width))?;
        let height = u16::try_from(config.height)
            .map_err(|_| format!("camera track height too large: {}", config.height))?;
        (
            codec_to_transport(encoder.codec()),
            vec![paracord_transport::stream::PublishedLayer {
                layer_id: 0,
                ssrc: session.video_ssrc,
                width: Some(width),
                height: Some(height),
                max_bitrate_kbps: Some(config.bitrate_kbps),
                active: true,
            }],
        )
    };
    Ok(paracord_transport::stream::PublishedTrack {
        stream_id: StreamId::new(format!("stream:{}:camera", session.session_id)),
        track_id: TrackId::new("camera"),
        publisher_user_id: session.local_user_id,
        kind: paracord_transport::control::TrackKind::Video,
        codec: Some(codec),
        layers,
    })
}

#[cfg(feature = "vpx")]
pub async fn ensure_track_sender_key(
    session: &mut NativeMediaSession,
    track: &PublishedTrack,
) -> Result<(), String> {
    use rand::RngCore;

    let key = {
        let mut sender_keys = session.track_sender_keys.lock().await;
        sender_keys
            .entry((track.stream_id.clone(), track.track_id.clone()))
            .or_insert_with(|| {
                let mut key = [0u8; 16];
                rand::thread_rng().fill_bytes(&mut key);
                super::session::SenderKeyState {
                    epoch: session.current_key_epoch.load(Ordering::SeqCst),
                    key,
                }
            })
            .to_owned()
    };

    {
        let mut encryptor = session
            .frame_encryptor
            .lock()
            .map_err(|_| "frame encryptor lock poisoned".to_string())?;
        for layer in &track.layers {
            encryptor.set_peer_key(layer.ssrc, key.epoch, &key.key);
        }
    }
    // Register our own key with the local decryptor too: self-view subscribes
    // to our own stream, which the server loops back encrypted with this key.
    let mut decryptor = session
        .frame_decryptor
        .lock()
        .map_err(|_| "frame decryptor lock poisoned".to_string())?;
    for layer in &track.layers {
        decryptor.set_peer_key(layer.ssrc, key.epoch, &key.key);
    }
    Ok(())
}

#[cfg(feature = "vpx")]
pub async fn publish_screen_track_for_current_config(
    session: &mut NativeMediaSession,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let track = super::screen_capture::build_screen_track(session)?;
    ensure_track_sender_key(session, &track).await?;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.publish_track(track.clone());
    }
    session
        .send_control_message(&paracord_transport::control::ControlMessage::TrackPublish {
            track: track.clone(),
        })
        .await?;
    session.published_screen_track = Some(track.clone());
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("media_track_publish", track);
    }
    Ok(())
}

#[cfg(feature = "vpx")]
pub async fn clear_track_sender_key(session: &mut NativeMediaSession, track: &PublishedTrack) {
    let removed = {
        let mut sender_keys = session.track_sender_keys.lock().await;
        sender_keys.remove(&(track.stream_id.clone(), track.track_id.clone()))
    };
    if let Ok(mut encryptor) = session.frame_encryptor.lock() {
        let epoch = removed
            .map(|state| state.epoch)
            .unwrap_or(session.current_key_epoch.load(Ordering::SeqCst));
        for layer in &track.layers {
            encryptor.remove_peer_key(layer.ssrc, epoch);
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub async fn ensure_track_sender_key(
    _session: &mut NativeMediaSession,
    _track: &PublishedTrack,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "vpx"))]
pub async fn clear_track_sender_key(_session: &mut NativeMediaSession, _track: &PublishedTrack) {}

#[cfg(all(test, feature = "vpx"))]
mod tests {
    use super::*;

    #[test]
    fn decodes_new_video_metadata_payload() {
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream:1:screen"),
            track_id: TrackId::new("screen"),
            frame_id: 42,
            layer_id: 1,
            codec: TransportVideoCodec::H264,
            timestamp_us: 123_456,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        let mut payload = BytesMut::new();
        metadata.encode(&mut payload).unwrap();
        payload.extend_from_slice(&[1, 2, 3, 4]);

        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 1,
            sequence: 7,
            timestamp: 90_000,
            ssrc: 99,
            audio_level: 127,
            key_epoch: 0,
            payload_length: payload.len() as u16,
            codec: TransportVideoCodec::H264.header_id(),
        };

        let decoded = decode_video_fragment_payload(&header, &payload).unwrap();
        assert_eq!(decoded.0.stream_id.0, "stream:1:screen");
        assert_eq!(decoded.0.track_id.0, "screen");
        assert_eq!(decoded.0.frame_id, 42);
        assert_eq!(decoded.0.codec, TransportVideoCodec::H264);
        assert_eq!(decoded.1, vec![1, 2, 3, 4]);
    }

    fn published_layer(
        ssrc: u32,
        width: u16,
        height: u16,
    ) -> paracord_transport::stream::PublishedLayer {
        paracord_transport::stream::PublishedLayer {
            layer_id: 0,
            ssrc,
            width: Some(width),
            height: Some(height),
            max_bitrate_kbps: Some(2500),
            active: true,
        }
    }

    /// The relay authorizes only the SSRC. A hostile peer whose own SSRC is
    /// authorized must not be able to label its frames with another
    /// participant's `stream_id:track_id` and have them render on that
    /// participant's tile.
    #[test]
    fn frames_may_not_claim_another_tracks_identity() {
        let victim = make_track_key("stream:victim", "camera");
        let attacker = make_track_key("stream:attacker", "camera");
        bind_remote_video_track(
            "stream:victim",
            "camera",
            &[published_layer(1000, 1280, 720)],
        );
        bind_remote_video_track(
            "stream:attacker",
            "camera",
            &[published_layer(2000, 1280, 720)],
        );

        // Each track's own SSRC is accepted.
        assert!(video_frame_identity_is_authorized(1000, &victim));
        assert!(video_frame_identity_is_authorized(2000, &attacker));

        // The attacker's authorized SSRC claiming the victim's identity is not.
        assert!(!video_frame_identity_is_authorized(2000, &victim));
        // ...and neither is the reverse relabel.
        assert!(!video_frame_identity_is_authorized(1000, &attacker));

        // An SSRC nobody announced cannot borrow a known track's identity.
        assert!(!video_frame_identity_is_authorized(3000, &victim));

        unbind_remote_video_track("stream:victim", "camera");
        unbind_remote_video_track("stream:attacker", "camera");
    }

    /// Simulcast must keep working: every layer's SSRC belongs to the track, so
    /// a layer switch must not be read as a spoof.
    #[test]
    fn every_simulcast_layer_ssrc_is_authorized_for_its_track() {
        let key = make_track_key("stream:sim", "screen");
        bind_remote_video_track(
            "stream:sim",
            "screen",
            &[
                published_layer(10, 320, 180),
                published_layer(11, 640, 360),
                published_layer(12, 1280, 720),
            ],
        );
        for ssrc in [10, 11, 12] {
            assert!(
                video_frame_identity_is_authorized(ssrc, &key),
                "layer ssrc {ssrc} must be accepted for its own track"
            );
        }
        // The negotiated cap is the largest advertised layer.
        assert_eq!(track_max_dimensions(&key), Some((1280, 720)));

        unbind_remote_video_track("stream:sim", "screen");
        assert_eq!(track_max_dimensions(&key), None);
        // With the binding gone the check can no longer adjudicate, so it stops
        // rejecting rather than silently blackholing a re-publishing track.
        assert!(video_frame_identity_is_authorized(10, &key));
    }

    /// `fragment_count` sizes a slot vector straight from the wire. The
    /// protocol decoder caps it, and the pipeline applies a second, tighter cap
    /// derived from the largest legal whole frame.
    #[test]
    fn implausible_fragment_counts_are_rejected_before_allocating() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 0,
            sequence: 0,
            timestamp: 0,
            ssrc: 1,
            audio_level: 127,
            key_epoch: 0,
            payload_length: 0,
            codec: TransportVideoCodec::Vp9.header_id(),
        };

        // Hand-build the wire bytes: `encode` cannot express these, which is
        // exactly why the decoder must not trust them.
        let build = |index: u16, count: u16| {
            // stream_len=1 "s", track_len=1 "t"
            let mut buf = vec![1u8, b's', 1u8, b't'];
            buf.extend_from_slice(&0u64.to_be_bytes()); // frame_id
            buf.push(0); // layer_id
            buf.push(TransportVideoCodec::Vp9.header_id());
            buf.extend_from_slice(&0u64.to_be_bytes()); // timestamp_us
            buf.push(0); // is_keyframe
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&count.to_be_bytes());
            buf.extend_from_slice(&[0xAA; 16]);
            buf
        };

        // The amplification case: one small datagram declaring 65535 fragments.
        assert!(decode_video_fragment_payload(&header, &build(0, u16::MAX)).is_none());
        // Degenerate counts.
        assert!(decode_video_fragment_payload(&header, &build(0, 0)).is_none());
        // Index outside the declared count would index past the slot vector.
        assert!(decode_video_fragment_payload(&header, &build(4, 4)).is_none());
        // A plausible fragmentation still parses.
        assert!(decode_video_fragment_payload(&header, &build(2, 8)).is_some());
    }

    /// `frame_id` is an unauthenticated `u64`; `as i64` wrapped anything at or
    /// above 2^63 to a negative pts and fed it to libvpx/libavcodec.
    #[test]
    fn frame_id_never_becomes_a_negative_pts() {
        assert_eq!(frame_id_to_pts(0), 0);
        assert_eq!(frame_id_to_pts(1234), 1234);
        assert_eq!(frame_id_to_pts(i64::MAX as u64), i64::MAX);
        assert_eq!(frame_id_to_pts(i64::MAX as u64 + 1), i64::MAX);
        assert_eq!(frame_id_to_pts(u64::MAX), i64::MAX);
        for id in [u64::MAX, u64::MAX - 1, 1 << 63, (1 << 63) + 77] {
            assert!(
                frame_id_to_pts(id) >= 0,
                "frame_id {id} produced a negative pts"
            );
        }
    }

    #[test]
    fn rejects_legacy_video_fragment_payload() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 0,
            sequence: 11,
            timestamp: 1234,
            ssrc: 55,
            audio_level: 127,
            key_epoch: 0,
            payload_length: 9,
            codec: TransportVideoCodec::Vp9.header_id(),
        };
        let payload = vec![0x01, 0, 0, 0, 1, 9, 8, 7, 6];
        assert!(decode_video_fragment_payload(&header, &payload).is_none());
    }

    #[test]
    fn decodes_vp9_keyframe_datagram_into_cpu_handle() {
        use paracord_codec::video::decoder::{create_decoder, VideoDecoder};
        use paracord_codec::video::encoder::create_encoder;
        use paracord_codec::video::{
            DecodedFrameHandle, DecoderConfig, EncoderConfig, PixelFormat, VideoContentHint,
        };

        let width = 320u32;
        let height = 240u32;

        // Encode a real VP9 keyframe so libvpx produces a valid bitstream.
        let mut encoder = create_encoder(
            VideoCodec::Vp9,
            EncoderConfig {
                width,
                height,
                fps: 30,
                bitrate_kbps: 500,
                pixel_format: PixelFormat::I420,
                keyframe_interval: 0,
                content_hint: VideoContentHint::Default,
            },
        )
        .expect("vp9 encoder");

        let y_size = (width * height) as usize;
        let uv_size = ((width / 2) * (height / 2)) as usize;
        let mut i420 = vec![128u8; y_size + 2 * uv_size];
        for (i, px) in i420.iter_mut().take(y_size).enumerate() {
            *px = (i % 256) as u8;
        }
        let keyframe = encoder
            .encode(0, &i420, true)
            .expect("encode keyframe")
            .into_iter()
            .find(|frame| frame.is_keyframe)
            .expect("encoder emits a keyframe when forced");

        // Wrap the encoded keyframe in a single-fragment video datagram payload.
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream:decode-test:camera"),
            track_id: TrackId::new("camera"),
            frame_id: 3,
            layer_id: 0,
            codec: TransportVideoCodec::Vp9,
            timestamp_us: 4_242,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        let mut payload = BytesMut::new();
        metadata.encode(&mut payload).unwrap();
        payload.extend_from_slice(&keyframe.data);

        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 90_000,
            ssrc: 4321,
            audio_level: 127,
            key_epoch: 0,
            payload_length: payload.len() as u16,
            codec: TransportVideoCodec::Vp9.header_id(),
        };

        // Reassembly + native decode should yield a CpuI420 handle (spec §3.2):
        // the software floor / tier-2 output the native surface uploads — never a
        // raw-I420 frame stored over IPC (that path is deleted, spec §2).
        let (decoded_metadata, encoded_bytes) =
            reassemble_video_payload(&header, &payload).expect("single fragment reassembles");
        let encoded = paracord_codec::video::EncodedFrame {
            data: encoded_bytes,
            codec: VideoCodec::Vp9,
            pts: decoded_metadata.frame_id as i64,
            is_keyframe: decoded_metadata.is_keyframe,
            layer: None,
            width: 0,
            height: 0,
            colorspace: paracord_codec::video::ColorSpace::default(),
        };
        let mut decoder: Box<dyn VideoDecoder> =
            create_decoder(VideoCodec::Vp9, DecoderConfig::default()).expect("vp9 decoder");
        let result = decode_frame_to_handles(decoder.as_mut(), &encoded);
        let handles = match result {
            HandleDecodeResult::Frames(handles) => handles,
            other => panic!(
                "expected decoded handles, got {}",
                handle_result_label(&other)
            ),
        };
        assert_eq!(handles.len(), 1, "one keyframe → one decoded handle");
        assert_eq!(handles[0].width(), width);
        assert_eq!(handles[0].height(), height);
        // The software VP9 floor keeps frames on the CPU as I420 handles; there
        // is no raw-I420 IPC store to inspect.
        assert!(
            matches!(handles[0], DecodedFrameHandle::CpuI420 { .. }),
            "libvpx VP9 decode yields a CpuI420 handle"
        );
    }

    /// A `VideoSurface` test double: records presented frame dimensions and can
    /// be told to fail presents, exercising the route bookkeeping and the
    /// failure law (spec §3.7) without a GTK/GL session.
    struct MockSurface {
        presented: Arc<Mutex<Vec<(u32, u32)>>>,
        geometry_updates: Arc<AtomicU32>,
        fail_present: Arc<AtomicBool>,
    }

    impl super::super::native_render::VideoSurface for MockSurface {
        fn new(
            _app: &tauri::AppHandle,
            _id: super::super::native_render::SurfaceId,
        ) -> Result<Self, String> {
            unreachable!("mock is constructed directly in tests")
        }
        fn update_geometry(
            &mut self,
            _geometry: super::super::native_render::SurfaceGeometry,
        ) -> Result<(), String> {
            self.geometry_updates.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn present(
            &mut self,
            frame: paracord_codec::video::DecodedFrameHandle,
        ) -> Result<(), String> {
            if self.fail_present.load(Ordering::Relaxed) {
                return Err("mock present failure".into());
            }
            self.presented
                .lock()
                .unwrap()
                .push((frame.width(), frame.height()));
            Ok(())
        }
        fn destroy(self) {}
    }

    #[test]
    fn native_surface_route_bookkeeping() {
        let stream = "stream:route-test";
        let track = "camera";
        let key = make_track_key(stream, track);

        // No surface bound → no native-surface route.
        detach_native_surface(stream, track);
        assert!(track_surface_binding(&key).is_none());

        let presented = Arc::new(Mutex::new(Vec::new()));
        let mock = MockSurface {
            presented: presented.clone(),
            geometry_updates: Arc::new(AtomicU32::new(0)),
            fail_present: Arc::new(AtomicBool::new(false)),
        };
        let shared: super::super::native_render::SharedSurface =
            Arc::new(Mutex::new(Box::new(mock)));
        let id = super::super::native_render::SurfaceId(9_999);
        super::super::native_render::registry().insert(id, shared.clone());
        // Attach without a full Tauri app: build the binding through the public
        // dispatch state directly (attach_native_surface needs an AppHandle).
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_prefer_encoded.remove(&key);
            state.remote_track_surfaces.insert(
                key.clone(),
                TrackSurfaceBinding {
                    surface_id: id,
                    surface: shared.clone(),
                    stream_id: stream.to_string(),
                    track_id: track.to_string(),
                    app: None,
                    present_errors: Arc::new(AtomicU32::new(0)),
                    first_frame_presented: Arc::new(AtomicBool::new(false)),
                },
            );
        }

        // The route is now native-surface; a present through the binding lands on
        // the mock surface.
        let binding = track_surface_binding(&key).expect("binding present");
        {
            let mut surface = binding.surface.lock().unwrap();
            surface
                .present(paracord_codec::video::DecodedFrameHandle::CpuI420 {
                    data: vec![0u8; 320 * 180 * 3 / 2],
                    width: 320,
                    height: 180,
                    colorspace: paracord_codec::video::ColorSpace::Bt709,
                })
                .expect("present ok");
        }
        assert_eq!(presented.lock().unwrap().as_slice(), &[(320, 180)]);

        // Detach by id removes the binding and the registry entry.
        detach_native_surface_by_id(id);
        super::super::native_render::registry().remove(id);
        assert!(track_surface_binding(&key).is_none());
        assert!(super::super::native_render::registry().get(id).is_none());
    }

    fn handle_result_label(result: &HandleDecodeResult) -> &'static str {
        match result {
            HandleDecodeResult::Frames(_) => "Frames",
            HandleDecodeResult::NeedKeyframe => "NeedKeyframe",
            HandleDecodeResult::Drop => "Drop",
        }
    }

    /// The 2026-07-07 wedged-decoder storm: a keyframe that fails to decode must
    /// drop the decoder instance (so the next keyframe decodes fresh) and request
    /// a new keyframe; a streak of failing keyframes must tear the subscription
    /// down loudly (spec §3.7) instead of re-requesting keyframes at frame rate
    /// forever.
    #[tokio::test]
    async fn keyframe_decode_failure_drops_instance_then_tears_down() {
        let stream = "stream:wedge-test";
        let track = "screen";
        let key = make_track_key(stream, track);

        let mock = MockSurface {
            presented: Arc::new(Mutex::new(Vec::new())),
            geometry_updates: Arc::new(AtomicU32::new(0)),
            fail_present: Arc::new(AtomicBool::new(false)),
        };
        let shared: super::super::native_render::SharedSurface =
            Arc::new(Mutex::new(Box::new(mock)));
        let id = super::super::native_render::SurfaceId(9_998);
        super::super::native_render::registry().insert(id, shared.clone());
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_hidden.remove(&key);
            state.remote_track_prefer_encoded.remove(&key);
            state.remote_track_surfaces.insert(
                key.clone(),
                TrackSurfaceBinding {
                    surface_id: id,
                    surface: shared.clone(),
                    stream_id: stream.to_string(),
                    track_id: track.to_string(),
                    app: None,
                    present_errors: Arc::new(AtomicU32::new(0)),
                    first_frame_presented: Arc::new(AtomicBool::new(false)),
                },
            );
        }

        // Garbage bytes flagged as a VP9 keyframe: every decode fails with
        // DecodeFailed, on the lazily-created instance and on each fresh one.
        let garbage_keyframe = |frame_id: u64| ReassembledVideoFrame {
            frame_id,
            timestamp_us: frame_id * 33_000,
            encoded: paracord_codec::video::EncodedFrame {
                data: vec![0xA5; 64],
                codec: VideoCodec::Vp9,
                pts: frame_id as i64,
                is_keyframe: true,
                layer: None,
                width: 320,
                height: 240,
                colorspace: paracord_codec::video::ColorSpace::Bt709,
            },
            simulcast_layer: 0,
        };
        let force_keyframe = Arc::new(AtomicBool::new(false));
        let sink = KeyframeSink::LocalEncoder {
            force_keyframe: force_keyframe.clone(),
        };
        let drop_until_keyframe = Arc::new(AtomicBool::new(false));
        let mut keyframe_failures = 0u32;

        // Failures below the limit: instance dropped, keyframe requested, the
        // binding survives.
        for round in 1..KEYFRAME_DECODE_FAILURE_LIMIT {
            force_keyframe.store(false, Ordering::SeqCst);
            deliver_decoded_frame(
                &key,
                &sink,
                &drop_until_keyframe,
                &mut keyframe_failures,
                garbage_keyframe(round as u64),
            )
            .await;
            assert_eq!(keyframe_failures, round, "failure streak counts keyframes");
            assert!(
                !video_decoder_pool().lock().unwrap().contains_key(&key),
                "wedged decoder instance is dropped so the next keyframe decodes fresh"
            );
            assert!(
                force_keyframe.load(Ordering::SeqCst),
                "a fresh keyframe is requested from the local encoder"
            );
            assert!(
                track_surface_binding(&key).is_some(),
                "below the limit the subscription stays up"
            );
        }

        // The limit-hitting failure tears the subscription down (spec §3.7).
        deliver_decoded_frame(
            &key,
            &sink,
            &drop_until_keyframe,
            &mut keyframe_failures,
            garbage_keyframe(KEYFRAME_DECODE_FAILURE_LIMIT as u64),
        )
        .await;
        assert!(
            track_surface_binding(&key).is_none(),
            "a keyframe-failure streak removes the surface binding"
        );
        assert!(
            super::super::native_render::registry().get(id).is_none(),
            "a keyframe-failure streak removes the surface from the registry"
        );
    }

    #[test]
    fn stream_frame_message_round_trips_encrypt_decrypt() {
        use paracord_codec::crypto::{FrameDecryptor, FrameEncryptor, KEY_SIZE};

        const SSRC: u32 = 0xDEAD_BEEF;
        const EPOCH: u8 = 4;
        const SEQ: u16 = 4321;
        let key = [0x33u8; KEY_SIZE];

        let encryptor = Arc::new(Mutex::new(FrameEncryptor::new()));
        encryptor.lock().unwrap().set_peer_key(SSRC, EPOCH, &key);

        // Larger than u16::MAX to prove the whole-frame path is not bounded by the
        // 16-bit header payload_length field.
        let frame_data: Vec<u8> = (0..80_000u32).map(|n| (n % 251) as u8).collect();
        let stream_id = StreamId::new("stream:resil-test:screen");
        let track_id = TrackId::new("screen");

        let message = encode_stream_frame_message(
            &encryptor,
            EPOCH,
            SSRC,
            SEQ,
            90_000,
            1,
            VideoCodec::Vp9,
            true,
            &stream_id,
            &track_id,
            77,
            123_456,
            &frame_data,
        )
        .expect("encode stream frame message");

        let frame = MediaStreamFrame::decode(&message).expect("decode stream frame");
        assert_eq!(frame.header.ssrc, SSRC);
        assert_eq!(frame.header.key_epoch, EPOCH);
        assert_eq!(frame.metadata.frame_id, 77);
        assert!(frame.metadata.is_keyframe);
        assert_eq!(frame.metadata.fragment_count, 1);

        // Decrypt exactly as `handle_video_stream_frame` does: the AAD is the 16
        // wire header bytes, byte-identical to what the sender bound at encrypt
        // time (this is why the whole-frame path leaves the header immutable).
        let header_bytes: [u8; HEADER_SIZE] = message[..HEADER_SIZE].try_into().unwrap();
        let mut decryptor = FrameDecryptor::new();
        // The wrong epoch must fail rather than silently decode.
        decryptor.set_peer_key(SSRC, EPOCH.wrapping_add(1), &key);
        assert!(decryptor
            .decrypt(&header_bytes, SSRC, EPOCH, SEQ, &frame.payload)
            .is_err());
        decryptor.set_peer_key(SSRC, EPOCH, &key);
        let decrypted = decryptor
            .decrypt(&header_bytes, SSRC, EPOCH, SEQ, &frame.payload)
            .expect("whole-frame decrypt");
        assert_eq!(
            decrypted, frame_data,
            "the whole encoded frame round-trips through the stream path"
        );
    }

    #[test]
    fn stale_stream_keyframe_is_culled() {
        let track_key = make_track_key("stream:cull-test:screen", "screen");
        assert!(
            stream_frame_is_newest(&track_key, 10),
            "the first keyframe is accepted"
        );
        assert!(
            !stream_frame_is_newest(&track_key, 10),
            "a duplicate keyframe is culled"
        );
        assert!(
            !stream_frame_is_newest(&track_key, 5),
            "an older keyframe (a slow viewer's stale stream) is culled"
        );
        assert!(
            stream_frame_is_newest(&track_key, 11),
            "a newer keyframe is accepted"
        );
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_stream_high_water.remove(&track_key);
        }
    }

    #[tokio::test]
    async fn stream_keyframe_then_datagram_deltas_decode_in_order() {
        use paracord_codec::video::encoder::create_encoder;
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let width = 320u32;
        let height = 240u32;
        let mut encoder = create_encoder(
            VideoCodec::Vp9,
            EncoderConfig {
                width,
                height,
                fps: 30,
                bitrate_kbps: 500,
                pixel_format: PixelFormat::I420,
                keyframe_interval: 0,
                content_hint: VideoContentHint::Default,
            },
        )
        .expect("vp9 encoder");

        let y_size = (width * height) as usize;
        let uv_size = ((width / 2) * (height / 2)) as usize;
        let mut i420 = vec![128u8; y_size + 2 * uv_size];
        let mut encoded_frames = Vec::new();
        for pts in 0..3i64 {
            // Vary the luma so the delta frames carry real residual.
            for (i, px) in i420.iter_mut().take(y_size).enumerate() {
                *px = ((i as i64 + pts * 9) % 256) as u8;
            }
            let force_keyframe = pts == 0;
            for frame in encoder.encode(pts, &i420, force_keyframe).expect("encode") {
                encoded_frames.push(frame);
            }
        }
        assert!(
            encoded_frames.iter().any(|frame| frame.is_keyframe),
            "the forced first frame must be a keyframe"
        );

        let stream_id = "stream:interleave-test:screen";
        let track_id = "screen";
        let track_key = make_track_key(stream_id, track_id);
        let sink = KeyframeSink::LocalEncoder {
            force_keyframe: Arc::new(AtomicBool::new(false)),
        };

        // Route the track to a native surface (the new native-surface route,
        // spec §2): decoded frames are presented on the surface, not stored over
        // IPC. A MockSurface records the presented frame dimensions in order.
        let presented = Arc::new(Mutex::new(Vec::new()));
        let mock = MockSurface {
            presented: presented.clone(),
            geometry_updates: Arc::new(AtomicU32::new(0)),
            fail_present: Arc::new(AtomicBool::new(false)),
        };
        let shared: super::super::native_render::SharedSurface =
            Arc::new(Mutex::new(Box::new(mock)));
        let surface_id = super::super::native_render::SurfaceId(7_777);
        super::super::native_render::registry().insert(surface_id, shared.clone());
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_surfaces.insert(
                track_key.clone(),
                TrackSurfaceBinding {
                    surface_id,
                    surface: shared.clone(),
                    stream_id: stream_id.to_string(),
                    track_id: track_id.to_string(),
                    app: None,
                    present_errors: Arc::new(AtomicU32::new(0)),
                    first_frame_presented: Arc::new(AtomicBool::new(false)),
                },
            );
        }

        // Feed the keyframe followed by its deltas through the SAME per-track
        // worker a datagram delta would use, in frame_id order. Await between so
        // the bounded decode channel drains rather than shedding.
        let frame_count = encoded_frames.len();
        for frame in encoded_frames {
            let frame_id = frame.pts.max(0) as u64;
            dispatch_frame_to_worker(
                &track_key,
                ReassembledVideoFrame {
                    frame_id,
                    timestamp_us: frame_id * 1000,
                    encoded: frame,
                    simulcast_layer: 0,
                },
                sink.clone(),
            );
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }

        // The keyframe and every delta must have decoded (in frame_id order) and
        // been presented to the native surface at full frame size.
        let mut count = 0;
        for _ in 0..50 {
            count = presented.lock().unwrap().len();
            if count >= frame_count {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let dims = presented.lock().unwrap().clone();
        assert_eq!(
            count, frame_count,
            "keyframe + deltas all decode on top of the keyframe and present in order"
        );
        assert!(
            dims.iter().all(|&(w, h)| w == width && h == height),
            "each presented frame is the full decoded size (no CPU downscale): {dims:?}"
        );

        stop_decode_worker(&track_key);
        detach_native_surface_by_id(surface_id);
        super::super::native_render::registry().remove(surface_id);
        unregister_stream_video_subscription(stream_id, track_id);
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_stream_high_water.remove(&track_key);
        }
    }
}
