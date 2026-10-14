use super::session::NativeMediaSession;
use super::CallEventSink as AppHandle;
use paracord_transport::protocol::MediaHeader;
use paracord_transport::stream::PublishedTrack;

#[cfg(feature = "vpx")]
use bytes::{Bytes, BytesMut};
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

/// Bounded depth of the per-track decode worker's input channel. A stalled
/// decoder sheds load (drop-until-keyframe) instead of piling reassembled
/// frames on the heap. Every frame arrives on a reliable stream, and a frame
/// held up by a retransmission releases the frames queued behind it all at
/// once, and a fresh hardware decoder (a layer switch) can take the better part
/// of a second over its first keyframe on a loaded machine (measured up to
/// 0.96 s), so the channel absorbs about a second and a half at 60 fps rather
/// than shedding into a keyframe wait.
#[cfg(feature = "vpx")]
const DECODE_CHANNEL_DEPTH: usize = 96;
/// Most out-of-order frames the reorder stage holds before it force-delivers
/// the oldest; only a memory bound (the hold below decides in practice: 400 ms
/// is 24 frames at 60 fps).
#[cfg(feature = "vpx")]
const REORDER_MAX_HELD: usize = 32;
/// How long a frame waits for a missing predecessor before the predecessor is
/// declared lost, before this track has seen a gap fill. Every frame rides a
/// reliable stream, so a missing frame is normally a retransmission in
/// progress; past the hold the gap is a broken reference: the worker drops
/// deltas and asks for a keyframe (see [`TrackRecovery`]). V1 held 120 ms,
/// which a frame resent twice (a lost packet and a lost acknowledgement, at 5%
/// loss on both legs with 15 ms each way) overran: 35 keyframe recoveries in
/// 40 s (stream-fix V5). The hold then follows the gaps the track has seen
/// fill ([`ReorderHold`]).
#[cfg(feature = "vpx")]
const REORDER_HOLD_INITIAL: Duration = Duration::from_millis(250);
/// The adaptive hold's range. It never goes under the initial hold: on a
/// clean path frames reorder by a few milliseconds (gaps that fill at once),
/// and a hold fitted to those overran the first retransmission when loss
/// began (the lab: 150 ms, then a keyframe recovery for a frame that arrived
/// 337 ms late). Above 400 ms a frame that really is gone (shed by the relay)
/// costs more than the keyframe it is waiting to ask for.
#[cfg(feature = "vpx")]
const REORDER_HOLD_MIN: Duration = REORDER_HOLD_INITIAL;
#[cfg(feature = "vpx")]
const REORDER_HOLD_MAX: Duration = Duration::from_millis(400);
/// How far back the gaps the hold is fitted to go.
#[cfg(feature = "vpx")]
const REORDER_FILL_WINDOW: Duration = Duration::from_secs(30);
/// How long a track waiting for a keyframe waits before asking again. The
/// relay coalesces requests per layer for 250 ms, so a re-ask is never folded
/// into the request it repeats.
#[cfg(feature = "vpx")]
const KEYFRAME_RETRY_AFTER: Duration = Duration::from_millis(300);
/// A visible, live track that has presented nothing for this long tells the
/// page so ("Reconnecting video…") instead of leaving a frozen picture that
/// still reads as live, and logs why.
#[cfg(feature = "vpx")]
const STALL_AFTER: Duration = Duration::from_secs(1);
/// A pause this long between two frames arriving at a playing track's worker
/// is logged: it tells a transport stall (nothing arrives, then a burst) from a
/// decode or render stall (frames arrive, the picture does not move).
/// A decode, or a hand-off to the surface, that holds the track's worker this
/// long is logged (every frame behind it waits).
#[cfg(feature = "vpx")]
const SLOW_STEP_LOG_AFTER: Duration = Duration::from_millis(100);
#[cfg(feature = "vpx")]
const ARRIVAL_GAP_LOG_AFTER: Duration = Duration::from_millis(200);
/// How often a decode worker checks its keyframe retries and its stall
/// watchdog.
#[cfg(feature = "vpx")]
const WORKER_TICK: Duration = Duration::from_millis(100);
/// How far behind the newest frame id a frame may be and still count as late
/// (reordered or lost) rather than as a new numbering.
///
/// The browser publisher numbers a frame by its 16-bit packet sequence
/// (`browserMediaEngine.ts`, `& 0xffff`), so its frame ids wrap to 0 every
/// 65,536 packets: a few minutes of a screen share. A publisher that restarts
/// starts again from 0 as well. Either way the next frame id is far *below* the
/// last one, and comparing plainly (`id <= last`) dropped every frame after the
/// wrap as stale, and culled every keyframe until the count climbed back past
/// the old high-water mark: a desktop viewer's picture froze for minutes at a
/// time (WP-G23). Real reordering and loss are a handful of frames, so a jump
/// back of half the 16-bit range or more is a new numbering.
#[cfg(feature = "vpx")]
const FRAME_ID_RENUMBER_GAP: u64 = 1 << 15;

/// Whether `frame_id`, at or below `reference`, starts a new numbering (a wrap
/// or a restarted publisher) rather than being a late frame.
#[cfg(feature = "vpx")]
fn frame_id_renumbered(reference: u64, frame_id: u64) -> bool {
    frame_id <= reference && reference - frame_id >= FRAME_ID_RENUMBER_GAP
}

/// What the reorder stage does with an arriving frame, given the last frame id
/// it delivered.
#[cfg(feature = "vpx")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReorderAdmission {
    /// Buffer it in frame-id order.
    Accept,
    /// A keyframe: a resync point. Drop what is buffered older than it and
    /// continue from it.
    Resync,
    /// A new numbering (see [`FRAME_ID_RENUMBER_GAP`]): everything buffered
    /// belongs to the old one; drop it all and continue from this frame. The
    /// decoder's state is unaffected by a renumbering, so a delta still decodes.
    Renumber,
    /// Older than a frame already delivered: lost, drop it.
    Stale,
}

#[cfg(feature = "vpx")]
fn admit_reordered_frame(
    last_delivered: Option<u64>,
    frame_id: u64,
    is_keyframe: bool,
) -> ReorderAdmission {
    if let Some(last) = last_delivered {
        if frame_id_renumbered(last, frame_id) {
            return ReorderAdmission::Renumber;
        }
    }
    if is_keyframe {
        return ReorderAdmission::Resync;
    }
    if last_delivered.is_some_and(|last| frame_id <= last) {
        return ReorderAdmission::Stale;
    }
    ReorderAdmission::Accept
}

/// Smallest datagram a video sender can be using; bounds how many fragments a
/// datagram-delivered frame (a browser publisher's delta) may declare. The
/// native sender sends every video frame on a uni stream.
#[cfg(feature = "vpx")]
const FALLBACK_MAX_DATAGRAM_SIZE: usize = 1200;
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
/// Senders move large frames onto the
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
/// Camera keyframe cadence in seconds (a GOP of `fps x` this) — a safety net
/// only: recovery and late joins ride explicit RequestKeyframe messages.
#[cfg(feature = "vpx")]
const CAMERA_KEYFRAME_INTERVAL_SECONDS: u32 = 4;
/// The screen encoders' own GOP, in seconds of frames at the preset rate: a
/// backstop under the wall-clock keyframe timer ([`screen_keyframe_interval`]),
/// which is what actually spaces periodic screen keyframes.
#[cfg(feature = "vpx")]
const SCREEN_CODEC_GOP_BACKSTOP_SECONDS: u32 = 10;

/// How often a screen share emits a keyframe when nobody asks for one, in real
/// time. Recovery rides explicit RequestKeyframe messages (a viewer that sees a
/// broken reference asks at once and re-asks every 300 ms); this interval only
/// bounds the worst case for a viewer whose requests all went missing, and the
/// first picture of a viewer whose request raced the subscription.
///
/// It was a frame count, `fps x 4` at the preset's rate: 240 frames at a 60 fps
/// preset that encodes ~30 fps is 8 s (stream audit B3). Per preset: 2 s;
/// film content (the Movie presets) 3 s, because a film keyframe is the
/// largest frame and film viewers tolerate the longest worst case.
#[cfg(feature = "vpx")]
fn screen_keyframe_interval(config: &paracord_codec::video::EncoderConfig) -> Duration {
    match config.content_hint {
        paracord_codec::video::VideoContentHint::Film => Duration::from_secs(3),
        _ => Duration::from_secs(2),
    }
}
/// Floor for relay-feedback-driven bitrate reduction; below this, screen
/// content becomes unreadable and further reduction rarely helps.
#[cfg(feature = "vpx")]
const MIN_ADAPTIVE_SCREEN_BITRATE_KBPS: u32 = 512;
#[cfg(feature = "vpx")]
static VIDEO_SEND_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);

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
    /// Subscriber viewport (target render size) per track: the relay's layer
    /// selection hint (spec §4.2). The surface scales on the GPU; nothing is
    /// downscaled on the CPU.
    remote_track_viewports: HashMap<String, (u32, u32)>,
    /// Tracks the page paused (off screen, or the window hidden). While paused
    /// nothing is decoded; a resume waits for a keyframe (see
    /// [`set_stream_video_visibility`]). A surface hidden under a dialog or a
    /// stage move is NOT paused: it keeps decoding so it comes back current.
    remote_track_hidden: std::collections::HashSet<String>,
    /// Highest keyframe frame_id already accepted from a uni stream, per track.
    /// A stream keyframe whose frame_id is not newer is culled (a newer keyframe
    /// already superseded it), so a viewer too slow to drain the previous
    /// keyframe stream does not waste work decoding a stale one (L1 backpressure).
    remote_track_stream_high_water: HashMap<String, u64>,
    /// Native-surface bindings (spec §3.6): tracks whose frames are decoded
    /// natively and presented on a surface (or kept as stills by a sampler).
    /// This is the only video consumer in the desktop app: a track with no
    /// binding has nothing to show its frames, and they are dropped after the
    /// clip ring has seen them.
    remote_track_surfaces: HashMap<String, TrackSurfaceBinding>,
    /// Authoritative SSRC → track-key binding, taken from the relay's
    /// `TrackPublish`/`TrackLayers` announcements (every simulcast layer's
    /// SSRC).
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
    /// Tracks whose announced resolution changed (a share-quality change): the
    /// decoder instance, whose limits are fixed, is recreated at the track's
    /// next keyframe, which is where the new resolution starts. Dropping it at
    /// once instead left the keyframe that had already arrived decoded on the
    /// old instance and every delta after it with no decoder (B5 mid-stream).
    remote_track_decoder_reset: std::collections::HashSet<String>,
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
    /// When the last frame was presented, for the frame-gap diagnostic: a
    /// visible stream that stops moving says so in the log, with how long.
    /// `None` for a sampler, whose ambient view sends a keyframe every couple
    /// of seconds by design.
    last_present: Option<Arc<Mutex<Option<Instant>>>>,
    /// Latched while the stall watchdog has told the page this surface shows a
    /// frozen picture (see [`STALL_AFTER`]); cleared by the next presented frame.
    stalled: Arc<AtomicBool>,
}

/// A gap between presented frames of a decoding track longer than this is
/// logged (a frozen picture, or a publisher that stopped sending).
#[cfg(feature = "vpx")]
const PRESENT_GAP_LOG_AFTER: Duration = Duration::from_millis(1500);

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
            remote_track_viewports: HashMap::new(),
            remote_track_hidden: std::collections::HashSet::new(),
            remote_track_stream_high_water: HashMap::new(),
            remote_track_surfaces: HashMap::new(),
            remote_ssrc_track_bindings: HashMap::new(),
            remote_track_max_dimensions: HashMap::new(),
            remote_track_decoder_reset: std::collections::HashSet::new(),
        }
    }
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
/// native decoder backend exists for `codec`; the caller then fails the
/// subscription loudly. The map lock is released before the handle is returned.
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
    // This handle only ever feeds a native surface (deliver_decoded_frame →
    // surface.present), so the decoder emits handles the platform surface can
    // present, chosen once at construction (spec §3.2). On macOS VideoToolbox
    // decodes H.264 to a CVPixelBuffer the AVSampleBufferDisplayLayer enqueues
    // as it is; every other codec there (VP9 on libvpx) is CPU I420, which the
    // macOS surface wraps in a CVPixelBuffer itself. The Linux GLArea and the
    // Windows Direct3D surface upload CPU I420 (spec §3.4 tier 2) for every
    // codec.
    #[cfg(target_os = "macos")]
    let output = if codec == paracord_codec::video::VideoCodec::H264 {
        DecodeOutput::Gpu
    } else {
        DecodeOutput::Cpu
    };
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
    /// Where keyframe requests go: the sink of the session that delivered the
    /// latest frame. A track's worker outlives the session that started it (a
    /// watch moving from its view session onto the call), and a request sent
    /// down a closed connection never arrives.
    sink: Arc<Mutex<KeyframeSink>>,
}

/// Which simulcast layer a track's decoder is fed, so it is fed one encoding.
///
/// Every layer of a track decodes in the same worker (one worker per track),
/// and two sessions can carry the same track at once for a moment (a watch
/// moving from its view session onto the call); each relay picks its own layer.
/// A decoder handed deltas of two encodings draws garbage until the next
/// keyframe. The relay switches layers at a keyframe of the new one (spec §4.2),
/// so: a keyframe sets the layer, and a delta of another layer is dropped. When
/// only another layer arrives for a while (its keyframe was lost), it is asked
/// for one.
#[cfg(feature = "vpx")]
#[derive(Default)]
struct LayerLock {
    layer: Option<u8>,
    last_own_frame: Option<Instant>,
    last_foreign_request: Option<Instant>,
}

/// How long only another layer's deltas may arrive before its keyframe is asked
/// for, and how often after that.
#[cfg(feature = "vpx")]
const FOREIGN_LAYER_KEYFRAME_AFTER: Duration = Duration::from_millis(700);

#[cfg(feature = "vpx")]
impl LayerLock {
    /// Whether to decode `frame`; asks `sink` for a keyframe of a layer that
    /// has taken over without one.
    fn admit(&mut self, layer: u8, is_keyframe: bool, sink: &KeyframeSink) -> bool {
        let now = Instant::now();
        if is_keyframe || self.layer.is_none() || self.layer == Some(layer) {
            if is_keyframe {
                self.layer = Some(layer);
            }
            self.last_own_frame = Some(now);
            return true;
        }
        let starved = self
            .last_own_frame
            .is_none_or(|at| now.duration_since(at) > FOREIGN_LAYER_KEYFRAME_AFTER);
        let asked_recently = self
            .last_foreign_request
            .is_some_and(|at| now.duration_since(at) < FOREIGN_LAYER_KEYFRAME_AFTER);
        if starved && !asked_recently {
            self.last_foreign_request = Some(now);
            sink.request(layer);
        }
        false
    }
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
/// worker on first use with the given keyframe sink. On overflow the worker
/// drops deltas until the next keyframe and one is requested: a decoder that
/// skipped a frame would otherwise draw on top of a missing reference.
#[cfg(feature = "vpx")]
fn dispatch_frame_to_worker(track_key: &str, frame: ReassembledVideoFrame, sink: KeyframeSink) {
    super::av_sync::note_video_received(track_key, frame.timestamp_us);
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
    // Requests follow the session delivering now (see `DecodeWorker::sink`).
    *worker.sink.lock().unwrap_or_else(|e| e.into_inner()) = sink.clone();
    let result = worker.tx.try_send(frame);
    // Clone the Arc so the `&mut worker` borrow of the map ends here and the
    // Closed arm can `workers.remove(..)` without a borrow conflict.
    let drop_until_keyframe = worker.drop_until_keyframe.clone();
    match result {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            drop_until_keyframe.store(true, Ordering::SeqCst);
            sink.request(layer_id);
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            // Worker exited; drop the stale handle so the next frame respawns it.
            workers.remove(track_key);
        }
    }
}

/// A track's loss recovery and stall watchdog, owned by its decode worker.
///
/// The decoder cannot be trusted to notice a missing reference: NVDEC (AV1)
/// decodes a delta whose reference was lost without an error and goes on
/// showing the same picture until the next keyframe, which is how the 1440p
/// and 4K presets froze for 5 to 8 s with nothing in any log (stream audit
/// B3). So the worker treats a gap in frame ids as a broken reference itself:
/// it drops deltas, asks the publisher for a keyframe at once, asks again every
/// [`KEYFRAME_RETRY_AFTER`] until one decodes, and logs each step. And a
/// visible track that presents nothing for [`STALL_AFTER`] says so to the page.
#[cfg(feature = "vpx")]
struct TrackRecovery {
    /// When the last frame arrived from the network (any layer), for the stall
    /// reason.
    last_frame_at: Option<Instant>,
    /// Smoothed interval between arriving frames, in ms: the track's cadence,
    /// against which an arrival pause counts as a stall.
    arrival_interval_ms: f64,
    /// Since when the track has been waiting for a keyframe, and why.
    waiting: Option<(Instant, String)>,
    /// When a keyframe was last asked for, and how many times in this wait.
    last_request_at: Option<Instant>,
    requests: u32,
    /// The layer to ask a keyframe of: the one this track decodes.
    layer: u8,
    /// The simulcast layer whose keyframe the decoder instance last decoded:
    /// a keyframe of another layer recreates the instance (B4).
    decoded_layer: Option<u8>,
    /// Since when the track has been visible again after a pause; a paused
    /// track presents nothing by design, so the watchdog counts from here.
    visible_since: Option<Instant>,
    was_hidden: bool,
}

#[cfg(feature = "vpx")]
impl TrackRecovery {
    fn new() -> Self {
        Self {
            last_frame_at: None,
            arrival_interval_ms: 33.0,
            waiting: None,
            last_request_at: None,
            requests: 0,
            layer: 0,
            decoded_layer: None,
            visible_since: None,
            was_hidden: false,
        }
    }

    /// Start waiting for a keyframe (unless already waiting) and ask for one.
    fn break_reference(
        &mut self,
        track_key: &str,
        sink: &KeyframeSink,
        drop_until_keyframe: &AtomicBool,
        layer: u8,
        reason: String,
    ) {
        let now = Instant::now();
        drop_until_keyframe.store(true, Ordering::SeqCst);
        self.layer = layer;
        if self.waiting.is_none() {
            self.waiting = Some((now, reason.clone()));
            self.requests = 0;
        }
        self.requests += 1;
        self.last_request_at = Some(now);
        recovery_diag(
            sink,
            &format!(
                "video-recovery: {reason}; dropping deltas and asking for a keyframe \
                 track={track_key} layer={layer}"
            ),
        );
        sink.request(layer);
    }

    /// A keyframe decoded: the wait (if any) is over.
    fn recovered(&mut self, track_key: &str, sink: &KeyframeSink, frame_id: u64) {
        if let Some((since, reason)) = self.waiting.take() {
            recovery_diag(
                sink,
                &format!(
                    "video-recovery: keyframe {frame_id} decoded {} ms after \"{reason}\" \
                     ({} request(s)) track={track_key}",
                    since.elapsed().as_millis(),
                    self.requests
                ),
            );
        }
        self.requests = 0;
        self.last_request_at = None;
    }

    /// Periodic work: re-ask for a keyframe while waiting, and run the stall
    /// watchdog for the track's visible surface.
    fn tick(&mut self, track_key: &str, sink: &KeyframeSink, drop_until_keyframe: &AtomicBool) {
        let now = Instant::now();
        if drop_until_keyframe.load(Ordering::SeqCst) {
            if self.waiting.is_none() {
                // Set outside the worker: a resumed pause or an input overflow,
                // whose caller asked for the keyframe already.
                self.waiting = Some((now, "decode resumed after frames were skipped".into()));
                self.requests = 1;
                self.last_request_at = Some(now);
            } else if self
                .last_request_at
                .is_none_or(|at| now.duration_since(at) >= KEYFRAME_RETRY_AFTER)
            {
                self.requests += 1;
                self.last_request_at = Some(now);
                let waited = self
                    .waiting
                    .as_ref()
                    .map_or(0, |(since, _)| now.duration_since(*since).as_millis());
                recovery_diag(
                    sink,
                    &format!(
                        "video-recovery: no keyframe {waited} ms into the wait; asking again \
                         (request {}) track={track_key} layer={}",
                        self.requests, self.layer
                    ),
                );
                sink.request(self.layer);
            }
        }
        self.watch_for_stall(track_key, now);
    }

    fn watch_for_stall(&mut self, track_key: &str, now: Instant) {
        let Some(binding) = track_surface_binding(track_key) else {
            return;
        };
        let Some(last_present) = binding.last_present.as_ref() else {
            return; // a sampler: sparse frames by design
        };
        if track_is_hidden(track_key) {
            self.was_hidden = true;
            return;
        }
        if std::mem::take(&mut self.was_hidden) {
            self.visible_since = Some(now);
        }
        if !binding.first_frame_presented.load(Ordering::Relaxed)
            || binding.stalled.load(Ordering::Relaxed)
        {
            return;
        }
        let Some(last) = last_present.lock().ok().and_then(|last| *last) else {
            return;
        };
        let since = self.visible_since.map_or(last, |visible| visible.max(last));
        // A still screen sends a frame every second or so: count a stall
        // against the track's own cadence, never less than STALL_AFTER.
        let threshold = STALL_AFTER.max(Duration::from_secs_f64(
            self.arrival_interval_ms * 3.0 / 1000.0,
        ));
        if now.duration_since(since) < threshold {
            return;
        }
        binding.stalled.store(true, Ordering::Relaxed);
        let reason = match (&self.waiting, self.last_frame_at) {
            (Some((waiting_since, why)), _) => format!(
                "waiting {} ms for a keyframe ({} request(s)) after {why}",
                now.duration_since(*waiting_since).as_millis(),
                self.requests
            ),
            (None, Some(frame)) if now.duration_since(frame) >= STALL_AFTER => format!(
                "no video from the relay for {} ms",
                now.duration_since(frame).as_millis()
            ),
            (None, None) => "no video from the relay".to_string(),
            (None, Some(_)) => "frames arrive but none presents".to_string(),
        };
        native_diag(
            binding.app.as_ref(),
            &format!(
                "native-render: no frame presented for {} ms; showing reconnecting \
                 track={track_key} reason={reason}",
                now.duration_since(last).as_millis()
            ),
        );
        if let Some(app) = binding.app.as_ref() {
            super::events::emit_media_native_render_stalled(
                app,
                &binding.stream_id,
                &binding.track_id,
                true,
                &reason,
            );
        }
    }
}

/// Log a recovery step where the track's diagnostics go: the remote track's
/// session log (client-voice.log), or stderr for the self-view.
#[cfg(feature = "vpx")]
fn recovery_diag(sink: &KeyframeSink, line: &str) {
    match sink {
        KeyframeSink::Upstream { app, .. } => native_diag(Some(app), line),
        KeyframeSink::LocalEncoder { .. } => tracing::debug!("{line}"),
    }
}

/// The reorder stage's hold, fitted to how long this track's gaps take to fill
/// (stream-fix V6).
///
/// A hold only costs time when a frame is missing: in order, frames go
/// straight through, so a longer hold adds nothing on a clean path. On a lossy
/// one it decides between waiting out a retransmission and giving the picture
/// up for a keyframe. So the hold is 1.5 × the slowest gap that filled in the
/// last 30 s, plus 30 ms, within [`REORDER_HOLD_MIN`]..[`REORDER_HOLD_MAX`]
/// (250 to 400 ms). A frame that arrives after
/// the hold gave up on it counts as a gap that filled that late, so the next
/// one is waited for.
#[cfg(feature = "vpx")]
#[derive(Debug)]
struct ReorderHold {
    /// (when, how long the gap took to fill), oldest first.
    fills: std::collections::VecDeque<(Instant, Duration)>,
    /// The last gap the hold gave up on: its missing frame ids and when the
    /// first frame after it arrived.
    given_up: Option<(u64, u64, Instant)>,
    current: Duration,
}

#[cfg(feature = "vpx")]
impl ReorderHold {
    fn new() -> Self {
        Self {
            fills: std::collections::VecDeque::new(),
            given_up: None,
            current: REORDER_HOLD_INITIAL,
        }
    }

    fn hold(&self) -> Duration {
        self.current
    }

    /// A gap filled: the frame after it had waited `waited`. Returns the
    /// previous hold when the hold changed enough to log.
    fn note_fill(&mut self, now: Instant, waited: Duration) -> Option<Duration> {
        self.fills.push_back((now, waited));
        self.refit(now)
    }

    /// The hold gave up on frames `first..=last`; the frame after them arrived
    /// at `gap_began`.
    fn note_given_up(&mut self, first: u64, last: u64, gap_began: Instant) {
        self.given_up = Some((first, last, gap_began));
    }

    /// A frame older than the last one delivered arrived. If it is one the
    /// hold gave up on, that gap took this long to fill: returns how long, and
    /// the previous hold when the hold changed.
    fn note_stale(&mut self, frame_id: u64, now: Instant) -> Option<(Duration, Option<Duration>)> {
        let (first, last, gap_began) = self.given_up?;
        if !(first..=last).contains(&frame_id) {
            return None;
        }
        self.given_up = None;
        let waited = now.saturating_duration_since(gap_began);
        self.fills.push_back((now, waited));
        Some((waited, self.refit(now)))
    }

    /// The slowest fill in the window it is fitted to.
    fn slowest_fill(&self) -> Option<Duration> {
        self.fills.iter().map(|(_, waited)| *waited).max()
    }

    fn refit(&mut self, now: Instant) -> Option<Duration> {
        while self
            .fills
            .front()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) > REORDER_FILL_WINDOW)
        {
            self.fills.pop_front();
        }
        let next = match self.slowest_fill() {
            Some(slowest) => (slowest * 3 / 2 + Duration::from_millis(30))
                .clamp(REORDER_HOLD_MIN, REORDER_HOLD_MAX),
            None => REORDER_HOLD_INITIAL,
        };
        let previous = std::mem::replace(&mut self.current, next);
        (previous.abs_diff(next) >= Duration::from_millis(20)).then_some(previous)
    }
}

#[cfg(feature = "vpx")]
fn note_reorder_hold_change(
    track_key: &str,
    sink: &KeyframeSink,
    hold: &ReorderHold,
    previous: Duration,
) {
    recovery_diag(
        sink,
        &format!(
            "video-transport: reorder hold {} -> {} ms (the slowest gap to fill in the last {} s \
             took {} ms) track={track_key}",
            previous.as_millis(),
            hold.hold().as_millis(),
            REORDER_FILL_WINDOW.as_secs(),
            hold.slowest_fill().unwrap_or_default().as_millis(),
        ),
    );
}

#[cfg(feature = "vpx")]
fn spawn_decode_worker(track_key: String, sink: KeyframeSink) -> DecodeWorker {
    let (tx, mut rx) = mpsc::channel::<ReassembledVideoFrame>(DECODE_CHANNEL_DEPTH);
    let shutdown = Arc::new(Notify::new());
    let drop_until_keyframe = Arc::new(AtomicBool::new(false));
    let sink = Arc::new(Mutex::new(sink));

    let worker_shutdown = shutdown.clone();
    let worker_duk = drop_until_keyframe.clone();
    let worker_sink = sink.clone();
    let handle = tokio::spawn(async move {
        let current_sink = || {
            worker_sink
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        };
        let mut layer_lock = LayerLock::default();
        let mut recovery = TrackRecovery::new();
        let mut tick = tokio::time::interval(WORKER_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Reorder stage: hold frames by frame_id up to the hold for a
        // missing predecessor, deliver in order, drop anything older than
        // last-delivered.
        let mut reorder: BTreeMap<u64, (Instant, ReassembledVideoFrame)> = BTreeMap::new();
        let mut hold = ReorderHold::new();
        let mut last_delivered: Option<u64> = None;
        // Consecutive keyframes that failed to decode (wedged-decoder recovery;
        // see KEYFRAME_DECODE_FAILURE_LIMIT). Reset by any successful decode.
        let mut keyframe_failures: u32 = 0;
        loop {
            let next_deadline = reorder
                .values()
                .next()
                .map(|(arrived, _)| *arrived + hold.hold());
            tokio::select! {
                _ = worker_shutdown.notified() => break,
                msg = rx.recv() => {
                    let Some(frame) = msg else { break };
                    let arrived = Instant::now();
                    if let Some(gap) = recovery.last_frame_at.map(|at| arrived.duration_since(at)) {
                        // A pause well past the track's own cadence: a sharer
                        // whose screen is still sends a frame a second or so,
                        // and that is not a stall to log every second.
                        let usual = recovery.arrival_interval_ms;
                        recovery.arrival_interval_ms =
                            usual * 0.9 + (gap.as_secs_f64() * 1000.0).min(2000.0) * 0.1;
                        if gap >= ARRIVAL_GAP_LOG_AFTER && gap.as_secs_f64() * 1000.0 >= usual * 3.0 {
                            recovery_diag(
                                &current_sink(),
                                &format!(
                                    "video-transport: no frame arrived for {} ms (frame {} ends it) \
                                     track={track_key}",
                                    gap.as_millis(),
                                    frame.frame_id
                                ),
                            );
                        }
                    }
                    recovery.last_frame_at = Some(arrived);
                    match admit_reordered_frame(last_delivered, frame.frame_id, frame.encoded.is_keyframe) {
                        ReorderAdmission::Accept => {}
                        ReorderAdmission::Resync => {
                            // A keyframe is a self-contained resync point. Accept it
                            // even when a slower path let later frames overtake it
                            // and advance last_delivered past it: drop anything
                            // older and rebase onto the keyframe so it and every
                            // following frame still decode. This is what turns a
                            // loss-delayed keyframe from a permanent stall (the
                            // keyframe-request death spiral) into a recovery.
                            reorder.retain(|&fid, _| fid > frame.frame_id);
                            last_delivered = frame.frame_id.checked_sub(1);
                        }
                        ReorderAdmission::Renumber => {
                            // The frame ids wrapped (or the publisher restarted):
                            // everything held is from before, and plain ordering
                            // would call every frame from now on stale.
                            reorder.clear();
                            last_delivered = frame.frame_id.checked_sub(1);
                        }
                        ReorderAdmission::Stale => {
                            // Older than something already delivered. If the
                            // hold gave up on it, the hold was too short for
                            // this path: say so, and wait longer next time.
                            if let Some((waited, changed)) = hold.note_stale(frame.frame_id, arrived) {
                                recovery_diag(
                                    &current_sink(),
                                    &format!(
                                        "video-transport: frame {} arrived {} ms after the frame behind it, \
                                         after the reorder hold gave up on it track={track_key}",
                                        frame.frame_id,
                                        waited.as_millis()
                                    ),
                                );
                                if let Some(previous) = changed {
                                    note_reorder_hold_change(&track_key, &current_sink(), &hold, previous);
                                }
                            }
                            continue;
                        }
                    }
                    // This frame fills a gap that held later frames back: how
                    // long they waited is what the hold is fitted to.
                    let fills_gap = last_delivered.is_some_and(|last| frame.frame_id == last.wrapping_add(1));
                    if let (true, Some((waiting_since, _))) = (fills_gap, reorder.values().next()) {
                        let waited = arrived.saturating_duration_since(*waiting_since);
                        if let Some(previous) = hold.note_fill(arrived, waited) {
                            note_reorder_hold_change(&track_key, &current_sink(), &hold, previous);
                        }
                    }
                    reorder.insert(frame.frame_id, (Instant::now(), frame));
                    drain_reorder(&track_key, &current_sink(), &worker_duk, &mut keyframe_failures, &mut layer_lock, &mut recovery, &mut hold, &mut reorder, &mut last_delivered, false).await;
                }
                _ = sleep_until_opt(next_deadline) => {
                    drain_reorder(&track_key, &current_sink(), &worker_duk, &mut keyframe_failures, &mut layer_lock, &mut recovery, &mut hold, &mut reorder, &mut last_delivered, true).await;
                }
                _ = tick.tick() => {
                    recovery.tick(&track_key, &current_sink(), &worker_duk);
                }
            }
        }
    });

    DecodeWorker {
        tx,
        shutdown,
        handle,
        drop_until_keyframe,
        sink,
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
/// oldest buffered frame regardless of gaps. A delta delivered past a gap has
/// lost a reference: the track waits for a keyframe (see [`TrackRecovery`]).
#[cfg(feature = "vpx")]
#[allow(clippy::too_many_arguments)]
async fn drain_reorder(
    track_key: &str,
    sink: &KeyframeSink,
    drop_until_keyframe: &Arc<AtomicBool>,
    keyframe_failures: &mut u32,
    layer_lock: &mut LayerLock,
    recovery: &mut TrackRecovery,
    hold: &mut ReorderHold,
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
        let (arrived, frame) = reorder.remove(&frame_id).expect("frame present");
        let previous = last_delivered.replace(frame_id);
        if !contiguous {
            if let Some(last) = previous {
                if frame_id > last.wrapping_add(1) {
                    hold.note_given_up(last.wrapping_add(1), frame_id - 1, arrived);
                }
            }
        }
        if !layer_lock.admit(frame.simulcast_layer, frame.encoded.is_keyframe, sink) {
            continue;
        }
        if !contiguous && !frame.encoded.is_keyframe && !drop_until_keyframe.load(Ordering::SeqCst)
        {
            let missing = previous.map_or_else(
                || "an earlier frame".to_string(),
                |last| match frame_id.saturating_sub(last) {
                    2 => format!("frame {}", last + 1),
                    _ => format!("frames {}..={}", last + 1, frame_id.saturating_sub(1)),
                },
            );
            recovery.break_reference(
                track_key,
                sink,
                drop_until_keyframe,
                frame.simulcast_layer,
                format!(
                    "{missing} never arrived (frame {frame_id} waited {} ms; hold {} ms)",
                    arrived.elapsed().as_millis(),
                    hold.hold().as_millis()
                ),
            );
        }
        deliver_decoded_frame(
            track_key,
            sink,
            drop_until_keyframe,
            keyframe_failures,
            recovery,
            frame,
        )
        .await;
    }
}

/// Decode one delivered frame and present it on the track's native surface,
/// honoring the page's pause (N4) and drop-until-keyframe (spec §3.6/§3.7).
/// Nothing crosses IPC. Every frame reaches the clip ring first, whether or
/// not anything shows it.
#[cfg(feature = "vpx")]
async fn deliver_decoded_frame(
    track_key: &str,
    sink: &KeyframeSink,
    drop_until_keyframe: &Arc<AtomicBool>,
    keyframe_failures: &mut u32,
    recovery: &mut TrackRecovery,
    frame: ReassembledVideoFrame,
) {
    // Clip intake (docs/glass-spec.md §6.4): every decrypted frame of the
    // track, in order, whichever route renders it and even while hidden.
    super::clip_buffer::note_video_frame(
        track_key,
        frame.encoded.codec.header_id(),
        frame.encoded.is_keyframe,
        frame.timestamp_us,
        &frame.encoded.data,
    );
    let hidden = track_is_hidden(track_key);

    if let Some(binding) = track_surface_binding(track_key) {
        // Paused ⇒ nothing decoded (spec §2). A resume drops deltas until a
        // fresh keyframe (see set_stream_video_visibility).
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
        let layer = frame.simulcast_layer;
        let was_keyframe = frame.encoded.is_keyframe;
        let frame_id = frame.frame_id;
        if was_keyframe {
            // A keyframe of another simulcast layer starts another bitstream
            // (another resolution): decode it on a fresh decoder instance, never
            // on one primed by the old layer. A share-quality change does the
            // same at its first keyframe.
            let layer_changed = recovery
                .decoded_layer
                .is_some_and(|decoded| decoded != layer);
            let resized = take_decoder_reset(track_key);
            if layer_changed || resized {
                drop_track_decoder_instance(track_key);
                native_diag(
                    binding.app.as_ref(),
                    &format!(
                        "native-decode: decoder recreated at keyframe {frame_id} \
                         ({}) track={track_key} layer={layer}",
                        if layer_changed {
                            format!(
                                "layer {} -> {layer}",
                                recovery.decoded_layer.unwrap_or(layer)
                            )
                        } else {
                            "the track's resolution changed".to_string()
                        }
                    ),
                );
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
        let captured_us = frame.timestamp_us;
        // Hold the picture for its sound when the sound's path is longer
        // (stream audit B7, `av_sync`); before decode, so nothing GPU-side waits.
        let held_us = match super::av_sync::video_hold(track_key, captured_us) {
            Some(wait) => {
                tokio::time::sleep(wait).await;
                wait.as_micros() as u64
            }
            None => 0,
        };
        let encoded = frame.encoded;
        // The synchronous decode runs on the blocking pool; awaiting it here
        // preserves this worker's strict FIFO ordering. The decoder yields
        // GPU-resident (or tier-2 CPU-I420) handles via `decode_to_handles`.
        let decode_started = Instant::now();
        let outcome = tokio::task::spawn_blocking(move || {
            let mut guard = decoder.lock().unwrap_or_else(|e| e.into_inner());
            decode_frame_to_handles(guard.as_mut(), &encoded)
        })
        .await
        .unwrap_or(HandleDecodeResult::NeedKeyframe);
        let decode_took = decode_started.elapsed();
        if decode_took >= SLOW_STEP_LOG_AFTER {
            native_diag(
                binding.app.as_ref(),
                &format!(
                    "native-decode: decoding frame {frame_id} took {} ms track={track_key}",
                    decode_took.as_millis()
                ),
            );
        }

        match outcome {
            HandleDecodeResult::Frames(handles) => {
                *keyframe_failures = 0;
                if was_keyframe {
                    recovery.decoded_layer = Some(layer);
                    recovery.layer = layer;
                    recovery.recovered(track_key, sink, frame_id);
                }
                for handle in handles {
                    let present_started = Instant::now();
                    let present = {
                        let mut surface = binding.surface.lock().unwrap_or_else(|e| e.into_inner());
                        surface.present(handle)
                    };
                    let present_took = present_started.elapsed();
                    if present_took >= SLOW_STEP_LOG_AFTER {
                        native_diag(
                            binding.app.as_ref(),
                            &format!(
                                "native-render: handing frame {frame_id} to the surface took {} ms \
                                 track={track_key}",
                                present_took.as_millis()
                            ),
                        );
                    }
                    match present {
                        Ok(()) => {
                            binding.present_errors.store(0, Ordering::Relaxed);
                            // The picture's clock, which the stream's audio
                            // plays against (stream audit B7, `av_sync`).
                            super::av_sync::note_video_presented(track_key, captured_us, held_us);
                            let now = Instant::now();
                            let previous = binding
                                .last_present
                                .as_ref()
                                .and_then(|last| last.lock().ok())
                                .and_then(|mut last| last.replace(now));
                            if let Some(gap) = previous.map(|at| now.duration_since(at)) {
                                if gap > PRESENT_GAP_LOG_AFTER {
                                    native_diag(
                                        binding.app.as_ref(),
                                        &format!(
                                            "native-render: picture resumed after {} ms without a frame \
                                             track={track_key} keyframe={was_keyframe}",
                                            gap.as_millis()
                                        ),
                                    );
                                }
                            }
                            if binding.stalled.swap(false, Ordering::Relaxed) {
                                if let Some(app) = binding.app.as_ref() {
                                    super::events::emit_media_native_render_stalled(
                                        app,
                                        &binding.stream_id,
                                        &binding.track_id,
                                        false,
                                        "a frame was presented",
                                    );
                                }
                            }
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
                    recovery.decoded_layer = None;
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
                recovery.break_reference(
                    track_key,
                    sink,
                    drop_until_keyframe,
                    layer,
                    format!("frame {frame_id} could not be decoded (keyframe={was_keyframe})"),
                );
            }
            HandleDecodeResult::Drop => {}
        }
        return;
    }

    // No surface bound: nothing in this process shows the track (a subscription
    // whose `native_render_attach` has not landed yet, or a trailing frame after
    // detach). Drop it; the clip ring above has it already.
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
    on_screen: bool,
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
        last_present: on_screen.then(|| Arc::new(Mutex::new(None))),
        stalled: Arc::new(AtomicBool::new(false)),
    };
    if let Ok(mut state) = video_dispatch_state().lock() {
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
    _on_screen: bool,
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

/// Pause or resume a track's decode (N4 / contract C2). The page pauses a
/// track whose tile is off screen or whose window is hidden; a surface merely
/// covered (a dialog, a stage move) keeps decoding. A paused decoder skipped
/// frames, so on resume its worker drops deltas until a keyframe and this
/// returns true: the caller asks the publisher for one.
#[cfg(feature = "vpx")]
pub fn set_stream_video_visibility(stream_id: &str, track_id: &str, visible: bool) -> bool {
    let key = make_track_key(stream_id, track_id);
    let was_hidden = match video_dispatch_state().lock() {
        Ok(mut state) => {
            if visible {
                state.remote_track_hidden.remove(&key)
            } else {
                !state.remote_track_hidden.insert(key.clone())
            }
        }
        Err(_) => return false,
    };
    if !visible || !was_hidden {
        return false;
    }
    if let Some(worker) = decode_workers()
        .lock()
        .ok()
        .and_then(|workers| workers.get(&key).map(|w| w.drop_until_keyframe.clone()))
    {
        worker.store(true, Ordering::SeqCst);
    }
    true
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

/// Drop the process-wide video state of the named tracks only: their
/// surfaces, decoders and decode workers, SSRC bindings and partial frames.
///
/// The call and the view session are separate sessions over one set of
/// process-wide video tables, keyed by track. One session ending must not
/// blank the other's picture, so a session tears down exactly the tracks it
/// knew (see `NativeMediaSession::video_track_keys`), and
/// [`clear_all_stream_video_state`] is reserved for "no session is left".
#[cfg(feature = "vpx")]
pub fn clear_stream_video_state_for_tracks(tracks: &[(String, String)]) {
    for (stream_id, track_id) in tracks {
        unregister_stream_video_subscription(stream_id, track_id);
        unbind_remote_video_track(stream_id, track_id);
        let key = make_track_key(stream_id, track_id);
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_viewports.remove(&key);
            state.remote_track_hidden.remove(&key);
            state.remote_track_stream_high_water.remove(&key);
        }
        let prefix = format!("{key}:");
        if let Ok(mut pool) = video_reassembly_pool().lock() {
            pool.retain(|partial, _| !partial.starts_with(&prefix));
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub fn clear_stream_video_state_for_tracks(_tracks: &[(String, String)]) {}

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

/// Drop a track's surface binding and decoder (its subscription went away).
#[cfg(feature = "vpx")]
pub fn unregister_stream_video_subscription(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        // Drop the binding so the surface is not left orphaned when the
        // subscription goes away.
        if let Some(binding) = state.remote_track_surfaces.remove(&key) {
            super::native_render::registry().remove(binding.surface_id);
        }
    }
    remove_remote_video_decoder(stream_id, track_id);
}

/// One-shot snapshot of a track's self-view dispatch state, taken under a
/// single lock (N12a): `(has_surface, hidden)`. A bound surface owns keyframe
/// recovery (drop-until-keyframe + the `LocalEncoder` sink forcing our own
/// encoder), so it is always primed: gating it on a stored frame forced a
/// keyframe every other frame, permanently (the black-screen / keyframe
/// ping-pong bug of 2026-07-07).
#[cfg(feature = "vpx")]
fn video_dispatch_snapshot(track_key: &str) -> (bool, bool) {
    match video_dispatch_state().lock() {
        Ok(state) => (
            state.remote_track_surfaces.contains_key(track_key),
            state.remote_track_hidden.contains(track_key),
        ),
        Err(_) => (false, false),
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
    let previous_dims = state.remote_track_max_dimensions.get(&key).copied();
    match max_dims {
        Some(dims) => {
            state.remote_track_max_dimensions.insert(key.clone(), dims);
        }
        None => {
            state.remote_track_max_dimensions.remove(&key);
        }
    }
    if previous_dims.is_some() && previous_dims != max_dims {
        // Decoder limits are immutable. Recreate after a negotiated resize so
        // live quality upgrades can decode, and downgrades retain the tighter
        // cap: at the next keyframe, where the new resolution starts.
        state.remote_track_decoder_reset.insert(key.clone());
    }
    drop(state);
    if previous_dims != max_dims {
        tracing::info!(
            track = %key,
            ?previous_dims,
            ?max_dims,
            "remote track resolution changed; decoder is recreated at its next keyframe"
        );
    }
}

/// Take a pending decoder recreation for `track_key` (see
/// `VideoDispatchState::remote_track_decoder_reset`).
#[cfg(feature = "vpx")]
fn take_decoder_reset(track_key: &str) -> bool {
    video_dispatch_state()
        .lock()
        .is_ok_and(|mut state| state.remote_track_decoder_reset.remove(track_key))
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
        // The next share is another bitstream, maybe another size under the
        // same layer id (a 720p30 ladder's top layer is "high" as a 1440p60
        // one's is): decode its first keyframe on a fresh decoder. Without
        // this a re-share from 5120x1440 to 2560x720 went on through the
        // 5120x1440 decoder, a green and magenta picture (final audit, V6).
        state.remote_track_decoder_reset.insert(key.clone());
        // The share ended. Its next share numbers its frames from 0 again, and
        // a keyframe mark left from this one culled every keyframe of the next
        // as "stale" until its frame ids climbed past it: minutes of frozen
        // picture after a long share (stream audit B1).
        state.remote_track_stream_high_water.remove(&key);
        // The share behind a surface that stays up (a viewer still watching)
        // ended: its next share is a new picture, announced to the page by a
        // first-frame event of its own (the page shows "stopped sharing", then
        // "waiting", until it comes).
        if let Some(binding) = state.remote_track_surfaces.get(&key) {
            binding
                .first_frame_presented
                .store(false, Ordering::Relaxed);
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub fn unbind_remote_video_track(_stream_id: &str, _track_id: &str) {}

/// The remote video track (stream id, track id) a relay-announced SSRC belongs
/// to, for diagnostics that only know the SSRC (a run of packets that do not
/// decrypt). `None` for audio and for SSRCs no `TrackPublish` named.
#[cfg(feature = "vpx")]
pub fn remote_video_track_for_ssrc(ssrc: u32) -> Option<(String, String)> {
    let state = video_dispatch_state().lock().ok()?;
    let key = state.remote_ssrc_track_bindings.get(&ssrc)?;
    // Track keys are `{stream_id}:{track_id}`; track ids carry no colon.
    let (stream_id, track_id) = key.rsplit_once(':')?;
    Some((stream_id.to_string(), track_id.to_string()))
}

#[cfg(not(feature = "vpx"))]
pub fn remote_video_track_for_ssrc(_ssrc: u32) -> Option<(String, String)> {
    None
}

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
            keyframe_interval: fps.max(1) * CAMERA_KEYFRAME_INTERVAL_SECONDS,
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
        match kind {
            paracord_codec::video::SimulcastKind::Screen => SCREEN_CODEC_GOP_BACKSTOP_SECONDS,
            paracord_codec::video::SimulcastKind::Camera => CAMERA_KEYFRAME_INTERVAL_SECONDS,
        },
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

/// The simulcast encoder for a capture of `input_width`x`input_height`, camera
/// and screen alike. The in-process libavcodec hardware encoders (H.264/AV1)
/// encode every layer from ONE upload of the capture-sized frame, split and
/// scaled on the GPU (stream audit B2: one upload per layer cost 3 × 6.4 ms of
/// a 16.7 ms frame), and retarget a layer's bitrate on the running encoder
/// (NVENC in place; VAAPI/QSV reopen that layer's codec context only). VP9
/// stays on the libvpx factory, one encoder per layer.
#[cfg(feature = "vpx")]
fn build_simulcast_encoder(
    codec: paracord_codec::video::VideoCodec,
    input_format: paracord_codec::video::PixelFormat,
    input_width: u32,
    input_height: u32,
    layers: &[(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )],
) -> Result<paracord_codec::video::encoder::SimulcastEncoder, paracord_codec::video::VideoError> {
    use paracord_codec::video::encoder::{create_encoder, SimulcastEncoder};
    #[cfg(all(unix, not(target_os = "macos")))]
    if matches!(
        codec,
        paracord_codec::video::VideoCodec::H264 | paracord_codec::video::VideoCodec::Av1
    ) {
        let shared = paracord_codec::video::lavc::LavcSimulcastEncoder::new(
            codec,
            input_width,
            input_height,
            layers,
        )?;
        return SimulcastEncoder::new_shared(
            input_width,
            input_height,
            input_format,
            Box::new(shared),
        );
    }
    SimulcastEncoder::new_with_configs(input_width, input_height, input_format, layers, |cfg| {
        create_encoder(codec, cfg)
    })
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
    // One upload of the capture-sized frame for every layer, split and scaled
    // on the GPU, and a bitrate change that retargets the running encoder
    // (the screen path's encoder, stream-fix V3/V5). The camera used one
    // `LavcEncoder` per layer: an upload each, and a whole new GPU pipeline
    // (hardware device included) on every bitrate change.
    let preferred = session
        .video_encoder_codec
        .unwrap_or_else(default_camera_codec);
    let preferred_input_format = layers
        .last()
        .map(|(_, config)| config.pixel_format)
        .unwrap_or(paracord_codec::video::PixelFormat::I420);
    // No silent codec substitution (parity with the screen path): a failed init
    // means the capability probe and reality disagree — surface it.
    let (codec, encoder, effective_layers) = match build_simulcast_encoder(
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
    let (applied_kbps, active_layers, resume_at_keyframe) =
        super::session::NativeSimulcastState::uplink_defaults(&effective_layers);
    Ok(super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: effective_layers,
        codec,
        ssrcs: session.video_layer_ssrcs.clone(),
        applied_kbps,
        active_layers,
        resume_at_keyframe,
        shedding: false,
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

        // The config holds the PRESET (its 16:9 definition: lines, nominal
        // width, bitrate). What it sends from this source, its height kept in
        // the source's shape, is resolved per frame in `begin_screen_frame`
        // (`paracord_codec::video::preset_geometry`).
        let width = max_width.unwrap_or(source_width) & !1;
        let height = max_height.unwrap_or(source_height) & !1;
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
            // A backstop only: periodic screen keyframes come from a
            // wall-clock timer (`screen_keyframe_interval`), and late joiners
            // and loss recovery from RequestKeyframe.
            keyframe_interval: fps.max(1) * SCREEN_CODEC_GOP_BACKSTOP_SECONDS,
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
                "start_screen_share: codec={codec:?} source {source_width}x{source_height}, preset {}x{} fps={} bitrate_kbps={} (16:9 definition)",
                config.width, config.height, config.fps, config.bitrate_kbps
            ),
        );
        reset_screen_send_meter();
        session.screen_encoder = None;
        session.screen_simulcast = None;
        session
            .screen_encode_fps
            .store(config.fps, Ordering::Relaxed);
        session.screen_encoder_config = Some(config);
        session.screen_encoder_codec = Some(codec);
        session.screen_layer_ssrcs = build_track_layer_ssrcs(session.local_user_id, "screen");
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
        session.screen_share_clock.reset();
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
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
        session.screen_share_clock.reset();
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
    let (codec, encoder, effective_layers) = match build_simulcast_encoder(
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
    let (applied_kbps, active_layers, resume_at_keyframe) =
        super::session::NativeSimulcastState::uplink_defaults(&effective_layers);
    Ok(super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: effective_layers,
        codec,
        ssrcs: session.screen_layer_ssrcs.clone(),
        applied_kbps,
        active_layers,
        resume_at_keyframe,
        shedding: false,
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
    seq: paracord_transport::protocol::VideoSequences,
    timestamp: u32,
    pts: i64,
    capture_timestamp_us: u64,
    preset_kbps: u32,
    feedback_kbps: u32,
    applied_kbps: u32,
    key_epoch: u8,
    connection: quinn::Connection,
    frame_encryptor: Arc<Mutex<paracord_codec::crypto::FrameEncryptor>>,
    video_force_keyframe: Arc<AtomicBool>,
    i420_convert_buf: Vec<u8>,
}

/// Results carried from [`run_camera_frame`] back to [`finish_camera_frame`].
#[cfg(feature = "vpx")]
pub struct CameraFrameOutcome {
    simulcast: super::session::NativeSimulcastState,
    generation: u64,
    seq: paracord_transport::protocol::VideoSequences,
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
    let track_changed = sync_published_video_track_metadata(session, false);
    // A reconfiguration can add a simulcast layer (a share-quality change from
    // a two-rung ladder to a three-rung one): its SSRC needs the track's key
    // before the first frame on it is sealed, or the encode thread stops on
    // "no key for epoch" and every viewer is left with nothing (stream-fix V1,
    // Movie 100 -> 1440p60). Idempotent: the key itself does not change.
    if let Some(track) = session
        .published_video_track
        .clone()
        .filter(|_| track_changed)
    {
        ensure_track_sender_key(session, &track).await?;
    }

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
        seq: session.video_seq.clone(),
        timestamp: session.video_timestamp,
        pts,
        capture_timestamp_us,
        preset_kbps,
        feedback_kbps,
        applied_kbps,
        key_epoch,
        connection: session.connection.inner().clone(),
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
    let mut local_seq = job.seq.clone();
    let self_view_track_key = make_track_key(&job.stream_id.0, &job.track_id.0);
    let (sv_has_subscriber, _sv_hidden) = video_dispatch_snapshot(&self_view_track_key);
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
        // Every frame, delta or keyframe, rides its own reliable uni stream:
        // one path per track, so frames are neither lost nor reordered against
        // each other by the split (stream audit B3; see `send_encoded_video_frame_stream`).
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
            false,
        )?;
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
            {
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
    seq: paracord_transport::protocol::VideoSequences,
    timestamp: u32,
    pts: i64,
    /// Wire PTS in microseconds derived from the frame's true capture time (L2),
    /// monotonic per track. Shared by every simulcast layer of this frame.
    capture_timestamp_us: u64,
    preset_kbps: u32,
    feedback_kbps: u32,
    key_epoch: u8,
    connection: quinn::Connection,
    frame_encryptor: Arc<Mutex<paracord_codec::crypto::FrameEncryptor>>,
    screen_force_keyframe: Arc<AtomicBool>,
    i420_convert_buf: Vec<u8>,
}

/// Results carried from [`run_screen_frame`] back to [`finish_screen_frame`].
#[cfg(feature = "vpx")]
pub struct ScreenFrameOutcome {
    simulcast: super::session::NativeSimulcastState,
    generation: u64,
    seq: paracord_transport::protocol::VideoSequences,
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
    // The config is the preset's 16:9 definition; resolve what it sends from
    // this source: its height in the source's shape, within the codec's size
    // limit, the bitrate scaled with the pixels (Movie keeps its own), and a
    // preset that sends the same picture as a smaller one here takes that
    // one's settings.
    let resolved = paracord_codec::video::resolve_screen_preset(
        frame_width,
        frame_height,
        &screen_config,
        paracord_codec::video::codec_max_encode_dimension(requested_codec),
    );
    let geometry = resolved.geometry;
    let (encode_width, encode_height) =
        align_dimensions_for_codec(requested_codec, geometry.width, geometry.height);
    let desired_config = EncoderConfig {
        width: encode_width,
        height: encode_height,
        fps: resolved.fps,
        bitrate_kbps: geometry.bitrate_kbps,
        content_hint: resolved.content_hint,
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
        let unlimited = paracord_codec::video::resolve_screen_preset(
            frame_width,
            frame_height,
            &screen_config,
            u32::MAX,
        );
        let codec_limited = (unlimited.geometry.width, unlimited.geometry.height)
            != (geometry.width, geometry.height);
        native_diag(
            app,
            &format!(
                "screen share geometry: source {frame_width}x{frame_height}, preset {} lines \
                 ({}x{} at {} kbps, 16:9) -> sending {}x{} at {} fps, {} kbps{}{}; layers {}",
                screen_config.height,
                screen_config.width,
                screen_config.height,
                screen_config.bitrate_kbps,
                desired_config.width,
                desired_config.height,
                desired_config.fps,
                desired_config.bitrate_kbps,
                match resolved.same_as {
                    Some(name) => format!(
                        " (the same picture as {name} on this source, so {name}'s settings)"
                    ),
                    None if screen_config.content_hint
                        == paracord_codec::video::VideoContentHint::Film =>
                    {
                        " (Movie: its stated bitrate on any screen)".to_string()
                    }
                    None => String::new(),
                },
                if codec_limited {
                    format!(", reduced to fit {requested_codec:?}'s size limit")
                } else {
                    String::new()
                },
                desired_layers
                    .iter()
                    .map(|(_, c)| format!("{}x{}/{}k", c.width, c.height, c.bitrate_kbps))
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
        );
        // The share menu says which presets are the same picture on the
        // screen being shared; it needs that screen's size.
        if let Some(app) = app {
            super::events::emit_media_screen_share_source(app, frame_width, frame_height);
        }
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
        session.screen_timestamp = 0;
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
        session.screen_applied_bitrate_kbps = 0;
        session.screen_encoder_generation = session.screen_encoder_generation.wrapping_add(1);
    }

    // Periodic keyframe on a wall-clock timer (see `screen_keyframe_interval`).
    // A keyframe asked for by a viewer or a reconfiguration restarts the timer.
    let now = Instant::now();
    let keyframe_due = session
        .screen_last_keyframe_at
        .is_none_or(|at| now.duration_since(at) >= screen_keyframe_interval(&screen_config));
    if keyframe_due && !session.screen_force_keyframe.swap(true, Ordering::SeqCst) {
        tracing::debug!(
            interval_ms = screen_keyframe_interval(&screen_config).as_millis() as u64,
            "screen encoder: periodic keyframe"
        );
    }
    if session.screen_force_keyframe.load(Ordering::SeqCst) {
        session.screen_last_keyframe_at = Some(now);
    }

    // Publish the track before the first send (moved from post-encode). Publish
    // only needs the encoder's layer configs, which exist now that any reinit
    // has run.
    if session.published_screen_track.is_none() {
        publish_screen_track_for_current_config(session, app).await?;
    }
    let track_changed = sync_published_video_track_metadata(session, true);
    if track_changed {
        // The relay stages viewers of a layer that is no longer published onto
        // the one below at its next keyframe: make that keyframe now.
        session.screen_force_keyframe.store(true, Ordering::SeqCst);
    }
    // A reconfiguration can add a simulcast layer (a share-quality change from
    // a two-rung ladder to a three-rung one): its SSRC needs the track's key
    // before the first frame on it is sealed, or the encode thread stops on
    // "no key for epoch" and every viewer is left with nothing (stream-fix V1,
    // Movie 100 -> 1440p60). Idempotent: the key itself does not change.
    if let Some(track) = session
        .published_screen_track
        .clone()
        .filter(|_| track_changed)
    {
        ensure_track_sender_key(session, &track).await?;
    }

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

    // Adaptive-bitrate inputs: snapshot the relay feedback; the retarget
    // decisions + hysteresis run in the encode phase against the rates the
    // encoder carries (`NativeSimulcastState::applied_kbps`). The preset
    // resolved for this source (scaled with its pixels), not its 16:9
    // definition.
    let preset_kbps = desired_config.bitrate_kbps;
    let feedback_kbps = session.screen_bitrate_feedback_kbps.load(Ordering::Relaxed);

    let pts = session.screen_pts;
    session.screen_pts = session.screen_pts.wrapping_add(1);

    // L2: derive the wire PTS from the frame's true capture time relative to the
    // first frame of this share, instead of a synthesized frame_index/fps. Kept
    // monotonic per track so a capture backend with a non-monotonic clock cannot
    // rewind playback timing.
    // One zero point with the share's audio (stream audit B7, `av_sync`).
    let base = session.screen_share_clock.base_or_init(capture_time);
    let raw_us = capture_time
        .duration_since(base)
        .map(|delta| delta.as_micros() as u64)
        .unwrap_or(session.screen_last_timestamp_us);
    let capture_timestamp_us = raw_us.max(session.screen_last_timestamp_us);
    session.screen_last_timestamp_us = capture_timestamp_us;

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
        seq: session.screen_seq.clone(),
        timestamp: session.screen_timestamp,
        pts,
        capture_timestamp_us,
        preset_kbps,
        feedback_kbps,
        key_epoch,
        connection: session.connection.inner().clone(),
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

    // Adaptive bitrate, two limits (each change logged with its numbers):
    //
    // - The share's own uplink (`uplink.rs`, stream-fix V6): frames that queue
    //   for the relay's acknowledgement bring a budget for every layer
    //   together down to what the uplink carries; the top layer gives up
    //   bitrate first, then is dropped (unpublished, so viewers move to the
    //   layer below at its keyframe), then the next one. The budget climbs
    //   back once the queue is gone, and dropped layers return from a
    //   keyframe.
    // - The relay's estimate (`screen_rate_step`), a LIMIT on the top layer
    //   only once it falls (it falls only on loss): with no loss it is a probe
    //   just above the measured goodput, and treating that as a target held
    //   Movie 50/100 at ~17 Mb/s (stream audit B5).
    //
    // The 1/8 (12.5%) hysteresis keeps estimator noise from thrashing rate
    // control; returning to a layer's preset always applies.
    let preset_kbps = job.preset_kbps;
    let feedback_kbps = job.feedback_kbps;
    let sent_kbps = screen_send_meter_kbps();
    let decision = screen_rate_decision(preset_kbps, feedback_kbps);
    let ladder: Vec<u32> = simulcast
        .layers
        .iter()
        .map(|(_, config)| config.bitrate_kbps)
        .collect();
    let ladder_total: u32 = ladder.iter().sum();
    let uplink = SCREEN_UPLINK
        .lock()
        .map(|mut uplink| uplink.evaluate(Instant::now(), ladder_total))
        .unwrap_or_default();
    for line in [&uplink.change, &uplink.shed_change].into_iter().flatten() {
        native_diag(app, &format!("screen uplink: {line}"));
    }
    let mut plan = super::uplink::allocate_layers(&ladder, uplink.budget_kbps);
    if let Ok(mut gate) = SCREEN_LAYER_GATE.lock() {
        plan = gate.admit(
            Instant::now(),
            &ladder,
            uplink.budget_kbps,
            simulcast.active_layers,
            plan,
        );
    }
    if plan.active == ladder.len() {
        if let Some(top) = plan.kbps.last_mut() {
            *top = (*top).min(decision.target_kbps.max(1));
        }
    }
    if plan.active != simulcast.active_layers && plan.active > 0 {
        let size = |index: usize| {
            simulcast
                .layers
                .get(index)
                .map(|(_, config)| format!("{}x{}", config.width, config.height))
                .unwrap_or_default()
        };
        let line = if plan.active < simulcast.active_layers {
            format!(
                "screen uplink: sending {} of {} layers: {} dropped (budget {} kbps does not fit \
                 it at 1.5x the layer below); viewers on it move to {}",
                plan.active,
                ladder.len(),
                (plan.active..simulcast.active_layers)
                    .map(size)
                    .collect::<Vec<_>>()
                    .join(", "),
                uplink.budget_kbps.unwrap_or(ladder_total),
                size(plan.active - 1),
            )
        } else {
            format!(
                "screen uplink: sending {} of {} layers: {} restored from its next keyframe \
                 (budget {})",
                plan.active,
                ladder.len(),
                (simulcast.active_layers..plan.active)
                    .map(size)
                    .collect::<Vec<_>>()
                    .join(", "),
                uplink
                    .budget_kbps
                    .map_or_else(|| "the preset".to_string(), |k| format!("{k} kbps")),
            )
        };
        native_diag(app, &line);
        for index in simulcast.active_layers..plan.active {
            if let Some(resume) = simulcast.resume_at_keyframe.get_mut(index) {
                *resume = true;
            }
        }
        if plan.active > simulcast.active_layers {
            job.screen_force_keyframe.store(true, Ordering::SeqCst);
        } else if let Some((layer, _)) = simulcast.layers.get(plan.active) {
            flush_screen_frames_from(*layer as u8);
        }
        simulcast.active_layers = plan.active;
    }
    // A backlog: the highest layer still sent skips frames until it drains,
    // then resumes from a keyframe.
    let shed_index = uplink
        .shed
        .then(|| simulcast.active_layers.saturating_sub(1));
    if uplink.shed && !simulcast.shedding {
        if let Some((layer, _)) = shed_index.and_then(|index| simulcast.layers.get(index)) {
            flush_screen_frames_from(*layer as u8);
        }
    }
    if simulcast.shedding && !uplink.shed {
        if let Some(resume) = simulcast
            .resume_at_keyframe
            .get_mut(simulcast.active_layers.saturating_sub(1))
        {
            *resume = true;
        }
        job.screen_force_keyframe.store(true, Ordering::SeqCst);
    }
    simulcast.shedding = uplink.shed;

    let fps = simulcast
        .layers
        .last()
        .map(|(_, config)| config.fps.max(1))
        .unwrap_or(30);
    for (index, &preset) in ladder.iter().enumerate() {
        // A layer not sent keeps its preset (it returns from a keyframe at it,
        // and the self-view watches the top layer's bitstream).
        let target = plan.kbps.get(index).copied().unwrap_or(preset);
        let applied = simulcast.applied_kbps.get(index).copied().unwrap_or(preset);
        if target == 0
            || target == applied
            || (target != preset && target.abs_diff(applied).saturating_mul(8) < applied)
        {
            continue;
        }
        match simulcast.encoder.set_layer_bitrate(index, target) {
            Ok(true) => {
                if let Some(slot) = simulcast.applied_kbps.get_mut(index) {
                    *slot = target;
                }
                let top = index + 1 == ladder.len();
                let by_relay = top
                    && plan.active == ladder.len()
                    && target == decision.target_kbps
                    && decision.limited;
                if by_relay || (top && target == preset && uplink.budget_kbps.is_none()) {
                    note_screen_rate_change(
                        app,
                        applied,
                        target,
                        preset_kbps,
                        feedback_kbps,
                        sent_kbps,
                        decision.limited,
                    );
                } else {
                    native_diag(
                        app,
                        &format!(
                            "screen bitrate: layer {index} ({}) {applied} -> {target} kbps (preset \
                             {preset}): {}",
                            simulcast
                                .layers
                                .get(index)
                                .map(|(_, c)| format!("{}x{}", c.width, c.height))
                                .unwrap_or_default(),
                            match uplink.budget_kbps {
                                Some(budget) => format!(
                                    "uplink budget {budget} kbps for every layer together, sending {}",
                                    sent_kbps.map_or_else(|| "n/a".into(), |k| format!("{k} kbps"))
                                ),
                                None => "the uplink has room for the preset".to_string(),
                            }
                        ),
                    );
                }
            }
            // Backend cannot retarget live; keep the current rate rather than
            // restarting the encoder mid-stream.
            Ok(false) => {}
            Err(err) => {
                native_diag(
                    app,
                    &format!(
                        "screen bitrate retarget of layer {index} to {target} kbps failed: {err}"
                    ),
                );
            }
        }
    }
    let new_applied_kbps = simulcast
        .applied_kbps
        .last()
        .copied()
        .unwrap_or(preset_kbps);

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
    // Per-SSRC counters are shared with the session, so failed or orphaned
    // encode jobs cannot rewind packet numbering or reuse encryption nonces.
    let mut local_seq = job.seq.clone();
    // Single dispatch-state snapshot for this frame (N12a): whether a self-view
    // subscriber exists, whether it decodes in the webview, whether a frame is
    // already stored, and whether the tile is hidden. Used to gate the preview
    // clone below and to route the self-view without re-locking per predicate.
    let self_view_track_key = make_track_key(&job.stream_id.0, &job.track_id.0);
    let (sv_has_subscriber, _sv_hidden) = video_dispatch_snapshot(&self_view_track_key);
    let mut local_preview_frame: Option<LocalPreviewFrame> = None;
    let mut sent_bytes = 0usize;
    for frame in encoded_frames.drain(..) {
        let layer_id = frame.layer.map(|layer| layer as u8).unwrap_or(0);
        // The uplink's decisions (above): a layer not sent, a layer skipping
        // frames while a backlog drains, a layer waiting for its keyframe.
        let layer_index = simulcast
            .layers
            .iter()
            .position(|(layer, _)| *layer as u8 == layer_id)
            .unwrap_or(0);
        let resume = simulcast
            .resume_at_keyframe
            .get(layer_index)
            .copied()
            .unwrap_or(false);
        let send_it = layer_index < simulcast.active_layers
            && shed_index != Some(layer_index)
            && (!resume || frame.is_keyframe);
        if resume && frame.is_keyframe {
            if let Some(slot) = simulcast.resume_at_keyframe.get_mut(layer_index) {
                *slot = false;
            }
        }
        if send_it {
            sent_bytes += frame.data.len();
        }
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
        let ssrc = job
            .layer_ssrcs
            .iter()
            .find_map(|(mapped_layer_id, ssrc)| (*mapped_layer_id == layer_id).then_some(*ssrc))
            .unwrap_or(job.fallback_ssrc);
        // Every frame, delta or keyframe, rides its own reliable uni stream:
        // one path per track, so frames are neither lost nor reordered against
        // each other by the split (stream audit B3; see `send_encoded_video_frame_stream`).
        // A frame not sent still numbers its layer (`local_seq` is advanced
        // only by a send, and a skipped frame is never referenced: its layer
        // resumes at a keyframe).
        if send_it {
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
                true,
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
    record_screen_send(sent_bytes);
    if let Some(stages) = simulcast.encoder.stage_report() {
        native_diag(
            app,
            &format!(
                "{stages} | sending {} kbps, top layer {new_applied_kbps} kbps (preset {preset_kbps}), \
                 bandwidth estimate {} | {}",
                screen_send_meter_kbps().map_or_else(|| "n/a".to_string(), |k| k.to_string()),
                if feedback_kbps > 0 {
                    format!("{feedback_kbps} kbps")
                } else {
                    "none yet".to_string()
                },
                SCREEN_UPLINK
                    .lock()
                    .map(|uplink| uplink.summary(Instant::now()))
                    .unwrap_or_default(),
            ),
        );
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
            {
                // The self-view decodes the exact bitstream viewers receive in
                // the same per-track decode worker remote subscribers use, off
                // the encode thread and strictly ordered. A decoder that cannot
                // make progress forces our own encoder to emit a keyframe
                // directly (LocalEncoder sink), no relay round-trip.
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

/// What the screen share put on the wire over the last few seconds (every
/// layer, for the logs) and its rate-control state. One screen share per
/// process.
#[cfg(feature = "vpx")]
struct ScreenSendMeter {
    /// (when, bytes) per encoded frame, oldest first, over `SCREEN_SEND_WINDOW`.
    samples: std::collections::VecDeque<(Instant, usize)>,
    bytes: usize,
    rate: ScreenRateState,
}

#[cfg(feature = "vpx")]
const SCREEN_SEND_WINDOW: Duration = Duration::from_secs(4);

/// The screen share's uplink, from its own frames' acknowledgements
/// (`uplink.rs`). One screen share per process.
#[cfg(feature = "vpx")]
static SCREEN_UPLINK: std::sync::LazyLock<Mutex<super::uplink::UplinkEstimator>> =
    std::sync::LazyLock::new(|| Mutex::new(super::uplink::UplinkEstimator::new()));

/// When a layer the uplink budget dropped may come back (`uplink.rs`).
#[cfg(feature = "vpx")]
static SCREEN_LAYER_GATE: Mutex<super::uplink::LayerGate> =
    Mutex::new(super::uplink::LayerGate::new());

/// Bumped (generation, lowest layer id) when the uplink sheds or drops
/// layers: every screen frame of those layers still in flight is reset.
#[cfg(feature = "vpx")]
static SCREEN_UPLINK_FLUSH: std::sync::LazyLock<tokio::sync::watch::Sender<(u64, u8)>> =
    std::sync::LazyLock::new(|| tokio::sync::watch::Sender::new((0, u8::MAX)));

/// Reset every screen frame of layer `from_layer_id` and above still in
/// flight.
#[cfg(feature = "vpx")]
fn flush_screen_frames_from(from_layer_id: u8) {
    SCREEN_UPLINK_FLUSH.send_modify(|(generation, layer)| {
        *generation += 1;
        *layer = from_layer_id;
    });
}

#[cfg(feature = "vpx")]
static SCREEN_SEND_METER: Mutex<ScreenSendMeter> = Mutex::new(ScreenSendMeter {
    samples: std::collections::VecDeque::new(),
    bytes: 0,
    rate: ScreenRateState {
        last_feedback_kbps: 0,
        limit_kbps: None,
    },
});

#[cfg(feature = "vpx")]
fn reset_screen_send_meter() {
    if let Ok(mut uplink) = SCREEN_UPLINK.lock() {
        *uplink = super::uplink::UplinkEstimator::new();
    }
    if let Ok(mut gate) = SCREEN_LAYER_GATE.lock() {
        *gate = super::uplink::LayerGate::new();
    }
    if let Ok(mut meter) = SCREEN_SEND_METER.lock() {
        meter.samples.clear();
        meter.bytes = 0;
        meter.rate = ScreenRateState::default();
    }
}

#[cfg(feature = "vpx")]
fn record_screen_send(bytes: usize) {
    let now = Instant::now();
    if let Ok(mut meter) = SCREEN_SEND_METER.lock() {
        meter.samples.push_back((now, bytes));
        meter.bytes += bytes;
        while meter
            .samples
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > SCREEN_SEND_WINDOW)
        {
            if let Some((_, old)) = meter.samples.pop_front() {
                meter.bytes -= old;
            }
        }
    }
}

/// The share's send rate in kbps, once a second of it has been measured.
#[cfg(feature = "vpx")]
fn screen_send_meter_kbps() -> Option<u32> {
    let meter = SCREEN_SEND_METER.lock().ok()?;
    let first = meter.samples.front()?.0;
    let span = Instant::now().saturating_duration_since(first);
    if span < Duration::from_secs(1) {
        return None;
    }
    Some((meter.bytes as f64 * 8.0 / span.as_secs_f64() / 1000.0) as u32)
}

#[cfg(feature = "vpx")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenRateDecision {
    target_kbps: u32,
    /// The bandwidth estimate is what holds the rate below the preset.
    limited: bool,
}

/// What the screen's rate control remembers between frames.
#[cfg(feature = "vpx")]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ScreenRateState {
    /// The last relay estimate seen (0 = none yet).
    last_feedback_kbps: u32,
    /// The top layer's ceiling while the estimate limits it.
    limit_kbps: Option<u32>,
}

/// The screen's top-layer bitrate for this frame.
///
/// The relay's uplink estimate (`feedback_kbps`, 0 = none yet) only FALLS when
/// it measures loss above 2% (multiplicative decrease to 85% of the goodput);
/// with no loss it probes upward from the goodput. So a falling estimate is a
/// limit: the top layer drops to 85% of it. A rising one says the path is
/// clear: the limit climbs by a quarter (or to 85% of the estimate, if more)
/// per estimate, and lifts once it reaches the preset. An estimate that merely
/// trails an application-limited sender is never treated as a limit (that held
/// Movie 50/100 at ~17 Mb/s, stream audit B5).
#[cfg(feature = "vpx")]
fn screen_rate_step(
    state: &mut ScreenRateState,
    preset_kbps: u32,
    feedback_kbps: u32,
) -> ScreenRateDecision {
    if feedback_kbps > 0 && feedback_kbps != state.last_feedback_kbps {
        let previous = std::mem::replace(&mut state.last_feedback_kbps, feedback_kbps);
        if previous > 0 && feedback_kbps < previous {
            let limit =
                (feedback_kbps.saturating_mul(85) / 100).max(MIN_ADAPTIVE_SCREEN_BITRATE_KBPS);
            state.limit_kbps = (limit < preset_kbps).then_some(limit);
        } else if let Some(limit) = state.limit_kbps {
            let next = limit
                .saturating_add(limit / 4)
                .max(feedback_kbps.saturating_mul(85) / 100);
            state.limit_kbps = (next < preset_kbps).then_some(next);
        }
    }
    match state.limit_kbps {
        Some(limit) if limit < preset_kbps => ScreenRateDecision {
            target_kbps: limit,
            limited: true,
        },
        _ => ScreenRateDecision {
            target_kbps: preset_kbps,
            limited: false,
        },
    }
}

#[cfg(feature = "vpx")]
fn screen_rate_decision(preset_kbps: u32, feedback_kbps: u32) -> ScreenRateDecision {
    SCREEN_SEND_METER.lock().map_or(
        ScreenRateDecision {
            target_kbps: preset_kbps,
            limited: false,
        },
        |mut meter| screen_rate_step(&mut meter.rate, preset_kbps, feedback_kbps),
    )
}

/// Say why the screen's bitrate changed: an estimate that limits it is logged
/// with its numbers, never applied silently.
#[cfg(feature = "vpx")]
fn note_screen_rate_change(
    app: Option<&AppHandle>,
    from_kbps: u32,
    to_kbps: u32,
    preset_kbps: u32,
    feedback_kbps: u32,
    sent_kbps: Option<u32>,
    limited: bool,
) {
    let sent = sent_kbps.map_or_else(|| "n/a".to_string(), |k| k.to_string());
    let line = if limited && to_kbps < from_kbps {
        format!(
            "screen bitrate limited by the bandwidth estimate: the relay lowered it to \
             {feedback_kbps} kbps (it measured loss) while {sent} kbps were sent; top layer \
             {from_kbps} -> {to_kbps} kbps (preset {preset_kbps})"
        )
    } else if limited {
        format!(
            "screen bitrate recovering under the bandwidth estimate: it rose to {feedback_kbps} kbps \
             (no loss); top layer {from_kbps} -> {to_kbps} kbps of the preset {preset_kbps} \
             (sending {sent} kbps)"
        )
    } else {
        format!(
            "screen bitrate at the preset: top layer {from_kbps} -> {to_kbps} kbps \
             (bandwidth estimate {feedback_kbps} kbps, sending {sent} kbps)"
        )
    };
    native_diag(app, &line);
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
    app: &super::CallEventSink,
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
    app: &super::CallEventSink,
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

        // Decrypt the whole-frame ciphertext. The AAD is the wire header with
        // `payload_length` zeroed, which is what every sender binds at encrypt
        // time — see `MediaHeader::aad`.
        let wire_header: [u8; HEADER_SIZE] =
            body[..HEADER_SIZE].try_into().expect("header is 16 bytes");
        let header_bytes = MediaHeader::aad(&wire_header);
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
            super::events::note_decrypt_result(
                app,
                header.ssrc,
                header.key_epoch,
                result.as_ref().err(),
            );
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
        // A frame id far below the mark is a new numbering (a wrap or a
        // restarted publisher), not a stale keyframe: take it as the new mark.
        Some(&high_water)
            if frame_id <= high_water && !frame_id_renumbered(high_water, frame_id) =>
        {
            false
        }
        _ => {
            state
                .remote_track_stream_high_water
                .insert(track_key.to_string(), frame_id);
            true
        }
    }
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
    let header_bytes = MediaHeader::aad(
        &<[u8; HEADER_SIZE]>::try_from(&header_buf[..HEADER_SIZE]).expect("header is 16 bytes"),
    );

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

/// Send one whole encoded frame on a fresh QUIC unidirectional stream: how the
/// native sender sends every video frame.
///
/// Deltas used to go as datagram fragments and keyframes (and large deltas) on
/// streams. A datagram frame is all-or-nothing, so one lost packet of a 45-packet
/// 4K delta lost the frame, and the reliable keyframe stream was overtaken by the
/// deltas that followed it; either way the decoder ran on without a reference
/// and the picture froze for seconds (stream audit B3). On streams a lost packet
/// is retransmitted and the frame arrives late instead of never; the receiver's
/// reorder stage puts frames back in order, and a frame that still never comes
/// (the relay shed it for a slow downlink) is a gap the receiver recovers from
/// with a keyframe request.
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
    seq: &mut paracord_transport::protocol::VideoSequences,
    frame_timestamp: u32,
    simulcast_layer: u8,
    codec: VideoCodec,
    is_keyframe: bool,
    stream_id: &StreamId,
    track_id: &TrackId,
    frame_id: u64,
    frame_timestamp_us: u64,
    frame_data: &[u8],
    screen_uplink: bool,
) -> Result<(), String> {
    if frame_data.is_empty() {
        return Ok(());
    }

    let this_seq = seq.next(ssrc);
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
    //
    // A screen-share frame is followed to the relay's acknowledgement of all of
    // it: that is what the share's uplink estimate is built on (`uplink.rs`).
    // Lower simulcast layers go first when the uplink is short (QUIC stream
    // priority, higher first): a viewer on them keeps a picture while the
    // estimate catches up.
    let uplink_frame = screen_uplink.then(|| {
        SCREEN_UPLINK
            .lock()
            .map(|mut uplink| uplink.on_send(Instant::now(), message.len()))
            .ok()
    });
    let uplink_frame = uplink_frame.flatten();
    // A screen frame still queued when the uplink sheds its layer is dropped
    // (its stream reset): a backlog of stale video is worth nothing to a
    // viewer, and it holds up the frames behind it.
    let mut flush = screen_uplink.then(|| SCREEN_UPLINK_FLUSH.subscribe());
    let connection = connection.clone();
    tokio::spawn(async move {
        let abandon = |id: Option<u64>| {
            if let (Some(id), Ok(mut uplink)) = (id, SCREEN_UPLINK.lock()) {
                uplink.on_abandoned(id);
            }
        };
        let flushed = async {
            let Some(flush) = flush.as_mut() else {
                return std::future::pending::<()>().await;
            };
            loop {
                if flush.changed().await.is_err() {
                    return std::future::pending::<()>().await;
                }
                let (_, from_layer) = *flush.borrow_and_update();
                if simulcast_layer >= from_layer {
                    return;
                }
            }
        };
        tokio::pin!(flushed);
        match connection.open_uni().await {
            Ok(mut send) => {
                let _ = send.set_priority(-i32::from(simulcast_layer));
                let written = tokio::select! {
                    written = send.write_all(&message) => Some(written),
                    () = &mut flushed => None,
                };
                match written {
                    Some(Ok(())) => {}
                    Some(Err(e)) => {
                        tracing::debug!("video uni-stream write failed: {e}");
                        abandon(uplink_frame);
                        return;
                    }
                    None => {
                        let _ = send.reset(0u32.into());
                        abandon(uplink_frame);
                        return;
                    }
                }
                let _ = send.finish();
                if let Some(id) = uplink_frame {
                    let stopped = tokio::select! {
                        stopped = send.stopped() => Some(stopped),
                        () = &mut flushed => None,
                    };
                    match stopped {
                        Some(Ok(None)) => {
                            if let Ok(mut uplink) = SCREEN_UPLINK.lock() {
                                uplink.on_acked(id, Instant::now());
                            }
                        }
                        Some(_) => abandon(Some(id)),
                        None => {
                            let _ = send.reset(0u32.into());
                            abandon(Some(id));
                        }
                    }
                }
            }
            Err(e) => {
                tracing::debug!("video uni-stream open failed: {e}");
                abandon(uplink_frame);
            }
        }
    });

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
/// Returns whether the published track changed (and was re-announced).
fn sync_published_video_track_metadata(session: &mut NativeMediaSession, is_screen: bool) -> bool {
    let updated_track = if is_screen {
        match super::screen_capture::build_screen_track(session) {
            Ok(track) => track,
            Err(_) => return false,
        }
    } else {
        match build_camera_track(session) {
            Ok(track) => track,
            Err(_) => return false,
        }
    };

    let current_track = if is_screen {
        session.published_screen_track.as_ref()
    } else {
        session.published_video_track.as_ref()
    };
    let Some(current_track) = current_track else {
        return false;
    };
    if current_track == &updated_track {
        return false;
    }
    let layers_only_update = current_track.stream_id == updated_track.stream_id
        && current_track.track_id == updated_track.track_id
        && current_track.publisher_user_id == updated_track.publisher_user_id
        && current_track.kind == updated_track.kind
        && current_track.codec == updated_track.codec;

    bind_remote_video_track(
        &updated_track.stream_id.0,
        &updated_track.track_id.0,
        &updated_track.layers,
    );
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
    true
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

    let track_key = (track.stream_id.clone(), track.track_id.clone());
    // A track that ran before in this call starts under the epoch after its
    // last key's (see `retired_track_key_epochs`).
    let epoch = super::events::fresh_track_key_epoch(
        session.retired_track_key_epochs.get(&track_key).copied(),
        session.current_key_epoch.load(Ordering::SeqCst),
    );
    let key = {
        let mut sender_keys = session.track_sender_keys.lock().await;
        sender_keys
            .entry(track_key)
            .or_insert_with(|| {
                let mut key = [0u8; 16];
                rand::thread_rng().fill_bytes(&mut key);
                tracing::info!(
                    stream_id = %track.stream_id.0,
                    track_id = %track.track_id.0,
                    epoch,
                    "new sender key for a local track"
                );
                super::session::SenderKeyState { epoch, key }
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
    if let Some(state) = removed {
        session.retired_track_key_epochs.insert(
            (track.stream_id.clone(), track.track_id.clone()),
            state.epoch,
        );
    }
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
    /// The call and a view session share these process-wide tables. Ending one
    /// session must clear its own tracks and leave the other's alone, or
    /// stopping a watch would blank the call's camera tiles (and vice versa).
    #[test]
    fn a_decoder_is_fed_one_layer_and_switches_only_at_a_keyframe() {
        let asked = Arc::new(AtomicBool::new(false));
        let sink = KeyframeSink::LocalEncoder {
            force_keyframe: asked.clone(),
        };
        let mut lock = LayerLock::default();
        // Layer 1 starts with a keyframe and its deltas decode.
        assert!(lock.admit(1, true, &sink));
        assert!(lock.admit(1, false, &sink));
        // Another session's layer 0 deltas interleave: dropped, and not asked
        // for while layer 1 keeps coming.
        assert!(!lock.admit(0, false, &sink));
        assert!(!asked.load(Ordering::SeqCst));
        // A layer 0 keyframe switches the decoder over; layer 1 is now the stranger.
        assert!(lock.admit(0, true, &sink));
        assert!(lock.admit(0, false, &sink));
        assert!(!lock.admit(1, false, &sink));
    }

    #[test]
    fn a_layer_that_took_over_without_a_keyframe_is_asked_for_one() {
        let asked = Arc::new(AtomicBool::new(false));
        let sink = KeyframeSink::LocalEncoder {
            force_keyframe: asked.clone(),
        };
        let mut lock = LayerLock::default();
        assert!(lock.admit(1, true, &sink));
        // Layer 1 has gone quiet for longer than the grace period.
        lock.last_own_frame = Some(Instant::now() - FOREIGN_LAYER_KEYFRAME_AFTER * 2);
        assert!(!lock.admit(2, false, &sink));
        assert!(
            asked.swap(false, Ordering::SeqCst),
            "asked for layer 2's keyframe"
        );
        // Not again right away.
        assert!(!lock.admit(2, false, &sink));
        assert!(!asked.load(Ordering::SeqCst));
    }

    #[test]
    fn scoped_teardown_leaves_the_other_sessions_tracks_alone() {
        let layer = |ssrc: u32| paracord_transport::stream::PublishedLayer {
            layer_id: 0,
            ssrc,
            width: Some(640),
            height: Some(360),
            max_bitrate_kbps: Some(800),
            active: true,
        };
        bind_remote_video_track("stream:scoped-call:camera", "camera", &[layer(71_001)]);
        bind_remote_video_track("stream:scoped-view:screen", "screen", &[layer(71_002)]);
        assert!(
            track_max_dimensions(&make_track_key("stream:scoped-call:camera", "camera")).is_some()
        );

        clear_stream_video_state_for_tracks(&[(
            "stream:scoped-view:screen".to_string(),
            "screen".to_string(),
        )]);

        assert!(
            track_max_dimensions(&make_track_key("stream:scoped-view:screen", "screen")).is_none()
        );
        assert!(
            track_max_dimensions(&make_track_key("stream:scoped-call:camera", "camera")).is_some(),
            "the other session's track must survive a scoped teardown"
        );
        clear_stream_video_state_for_tracks(&[(
            "stream:scoped-call:camera".to_string(),
            "camera".to_string(),
        )]);
    }

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

    #[test]
    fn negotiated_quality_resize_recreates_decoder_with_the_new_cap() {
        use paracord_codec::video::{decoder::NullDecoder, DecoderConfig};
        let key = make_track_key("stream:resize-test", "screen");
        let small = [published_layer(9991, 1280, 720)];
        bind_remote_video_track("stream:resize-test", "screen", &small);
        let decoder: Box<dyn paracord_codec::video::decoder::VideoDecoder> = Box::new(
            NullDecoder::new(DecoderConfig {
                max_dimensions: Some((1280, 720)),
                ..Default::default()
            })
            .unwrap(),
        );
        video_decoder_pool()
            .lock()
            .unwrap()
            .insert(key.clone(), Arc::new(Mutex::new(decoder)));
        bind_remote_video_track("stream:resize-test", "screen", &small);
        assert!(video_decoder_pool().lock().unwrap().contains_key(&key));
        bind_remote_video_track(
            "stream:resize-test",
            "screen",
            &[published_layer(9991, 1920, 1080)],
        );
        assert_eq!(track_max_dimensions(&key), Some((1920, 1080)));
        // The instance is recreated at the next keyframe, where the new
        // resolution starts, not under the frames still arriving.
        assert!(video_decoder_pool().lock().unwrap().contains_key(&key));
        assert!(take_decoder_reset(&key), "a recreation is pending");
        assert!(!take_decoder_reset(&key));
        // A share that ends: the next one starts on a fresh decoder too, even
        // when it announces a size the track never had before.
        unbind_remote_video_track("stream:resize-test", "screen");
        assert!(
            take_decoder_reset(&key),
            "a re-share starts on a fresh decoder"
        );
        video_decoder_pool().lock().unwrap().remove(&key);
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
            _fit: super::super::native_render::SurfaceFit,
            _shown: super::super::native_render::ShownNotifier,
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
                    last_present: None,
                    stalled: Arc::new(AtomicBool::new(false)),
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
                    last_present: None,
                    stalled: Arc::new(AtomicBool::new(false)),
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
        let mut recovery = TrackRecovery::new();

        // Failures below the limit: instance dropped, keyframe requested, the
        // binding survives.
        for round in 1..KEYFRAME_DECODE_FAILURE_LIMIT {
            force_keyframe.store(false, Ordering::SeqCst);
            deliver_decoded_frame(
                &key,
                &sink,
                &drop_until_keyframe,
                &mut keyframe_failures,
                &mut recovery,
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
            &mut recovery,
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

    #[test]
    fn a_restarted_share_s_first_keyframe_is_not_culled_as_stale() {
        // A long share left a keyframe mark at frame 9000; the publisher stops
        // and shares again, numbering from 0. The unpublish between the two
        // forgets the mark, so the new share's keyframes are taken.
        let track_key = make_track_key("stream:reshare-test:screen", "screen");
        assert!(stream_frame_is_newest(&track_key, 9_000));
        assert!(!stream_frame_is_newest(&track_key, 12), "same share: stale");
        unbind_remote_video_track("stream:reshare-test:screen", "screen");
        assert!(
            stream_frame_is_newest(&track_key, 0),
            "the next share's opening keyframe is accepted"
        );
        assert!(stream_frame_is_newest(&track_key, 40));
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_stream_high_water.remove(&track_key);
        }
    }

    #[test]
    fn stream_keyframe_after_a_frame_id_wrap_is_accepted() {
        // The browser publisher's frame ids are its 16-bit packet sequence: a
        // keyframe after the wrap has a small id below the high-water mark.
        let track_key = make_track_key("stream:wrap-test:screen", "screen");
        assert!(stream_frame_is_newest(&track_key, 65_400));
        assert!(
            stream_frame_is_newest(&track_key, 120),
            "a keyframe after the 16-bit wrap is a new numbering, not a stale keyframe"
        );
        assert!(
            !stream_frame_is_newest(&track_key, 100),
            "and the mark follows it: an older keyframe of the new numbering is still culled"
        );
        assert!(stream_frame_is_newest(&track_key, 300));
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_stream_high_water.remove(&track_key);
        }
    }

    #[test]
    fn reorder_hold_follows_the_gaps_that_fill() {
        let start = Instant::now();
        let mut hold = ReorderHold::new();
        assert_eq!(hold.hold(), REORDER_HOLD_INITIAL);
        // Quick fills (frames a few ms out of order) never shorten it.
        assert_eq!(hold.note_fill(start, Duration::from_millis(40)), None);
        assert_eq!(hold.hold(), REORDER_HOLD_INITIAL);
        // A frame resent twice (180 ms) widens it to cover the next one.
        let changed = hold.note_fill(start + Duration::from_secs(1), Duration::from_millis(180));
        assert_eq!(changed, Some(REORDER_HOLD_INITIAL));
        assert_eq!(hold.hold(), Duration::from_millis(300));
        // A gap the hold gave up on, filled 380 ms later: wait longer, to the cap.
        hold.note_given_up(10, 11, start + Duration::from_secs(2));
        assert_eq!(hold.note_stale(9, start + Duration::from_secs(2)), None);
        let (waited, changed) = hold
            .note_stale(11, start + Duration::from_millis(2_380))
            .expect("a frame the hold gave up on");
        assert_eq!(waited, Duration::from_millis(380));
        assert_eq!(changed, Some(Duration::from_millis(300)));
        assert_eq!(hold.hold(), REORDER_HOLD_MAX);
        // Once those fills are older than the window, it narrows again.
        hold.note_fill(start + Duration::from_secs(40), Duration::from_millis(60));
        assert_eq!(hold.hold(), REORDER_HOLD_MIN);
    }

    #[test]
    fn reorder_admission_keeps_order_and_survives_a_wrap() {
        use ReorderAdmission::*;
        // Nothing delivered yet: anything goes.
        assert_eq!(admit_reordered_frame(None, 7, false), Accept);
        assert_eq!(admit_reordered_frame(None, 7, true), Resync);
        // Ordinary flow, late frames and loss.
        assert_eq!(admit_reordered_frame(Some(100), 104, false), Accept);
        assert_eq!(admit_reordered_frame(Some(100), 100, false), Stale);
        assert_eq!(admit_reordered_frame(Some(100), 90, false), Stale);
        // A loss-delayed keyframe still resyncs (the existing recovery).
        assert_eq!(admit_reordered_frame(Some(100), 90, true), Resync);
        // The 16-bit wrap of a browser publisher: the next delta and the next
        // keyframe both start the new numbering instead of being dropped.
        assert_eq!(admit_reordered_frame(Some(65_530), 3, false), Renumber);
        assert_eq!(admit_reordered_frame(Some(65_530), 3, true), Renumber);
        // A native publisher's u64 ids that restarted from zero.
        assert_eq!(admit_reordered_frame(Some(5_000_000), 0, false), Renumber);
        // Half the 16-bit range back is the boundary.
        assert_eq!(
            admit_reordered_frame(Some(40_000), 40_000 - (1 << 15) + 1, false),
            Stale
        );
        assert_eq!(
            admit_reordered_frame(Some(40_000), 40_000 - (1 << 15), false),
            Renumber
        );
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
                    last_present: None,
                    stalled: Arc::new(AtomicBool::new(false)),
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

    /// A frame that never arrives is a broken reference: once the reorder hold
    /// gives up on it, the deltas after it are not decoded (NVDEC would show a
    /// frozen or smeared picture without an error, stream audit B3), a keyframe
    /// is asked for at once, and the next keyframe brings the picture back.
    #[tokio::test]
    async fn a_lost_frame_stops_deltas_and_asks_for_a_keyframe() {
        use paracord_codec::video::encoder::create_encoder;
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let (width, height) = (320u32, 240u32);
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
        let mut i420 = vec![128u8; y_size + 2 * (y_size / 4)];
        let mut frames = Vec::new();
        for pts in 0..8i64 {
            for (i, px) in i420.iter_mut().take(y_size).enumerate() {
                *px = ((i as i64 + pts * 13) % 256) as u8;
            }
            frames.extend(
                encoder
                    .encode(pts, &i420, pts == 0 || pts == 7)
                    .expect("encode"),
            );
        }
        assert_eq!(frames.len(), 8);

        let stream_id = "stream:gap-test:screen";
        let track_id = "screen";
        let track_key = make_track_key(stream_id, track_id);
        let force_keyframe = Arc::new(AtomicBool::new(false));
        let sink = KeyframeSink::LocalEncoder {
            force_keyframe: force_keyframe.clone(),
        };
        let presented = Arc::new(Mutex::new(Vec::new()));
        let shared: super::super::native_render::SharedSurface =
            Arc::new(Mutex::new(Box::new(MockSurface {
                presented: presented.clone(),
                geometry_updates: Arc::new(AtomicU32::new(0)),
                fail_present: Arc::new(AtomicBool::new(false)),
            })));
        let surface_id = super::super::native_render::SurfaceId(7_778);
        super::super::native_render::registry().insert(surface_id, shared.clone());
        if let Ok(mut state) = video_dispatch_state().lock() {
            state.remote_track_surfaces.insert(
                track_key.clone(),
                TrackSurfaceBinding {
                    surface_id,
                    surface: shared,
                    stream_id: stream_id.to_string(),
                    track_id: track_id.to_string(),
                    app: None,
                    present_errors: Arc::new(AtomicU32::new(0)),
                    first_frame_presented: Arc::new(AtomicBool::new(false)),
                    last_present: None,
                    stalled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let send = |frame: paracord_codec::video::EncodedFrame| {
            let frame_id = frame.pts as u64;
            dispatch_frame_to_worker(
                &track_key,
                ReassembledVideoFrame {
                    frame_id,
                    timestamp_us: frame_id * 33_000,
                    encoded: frame,
                    simulcast_layer: 0,
                },
                sink.clone(),
            );
        };
        let mut frames = frames.into_iter();
        // Frames 0..=2 decode; frame 3 is lost; 4..=6 arrive.
        for _ in 0..3 {
            send(frames.next().unwrap());
        }
        for _ in 0..100 {
            if presented.lock().unwrap().len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _lost = frames.next().unwrap();
        for _ in 0..3 {
            send(frames.next().unwrap());
        }
        tokio::time::sleep(REORDER_HOLD_INITIAL + Duration::from_millis(150)).await;
        assert_eq!(
            presented.lock().unwrap().len(),
            3,
            "nothing decodes past the gap"
        );
        assert!(
            force_keyframe.load(Ordering::SeqCst),
            "the gap asked the encoder for a keyframe"
        );
        // The keyframe (frame 7) restores the picture.
        send(frames.next().unwrap());
        for _ in 0..50 {
            if presented.lock().unwrap().len() == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(presented.lock().unwrap().len(), 4, "the keyframe presents");

        stop_decode_worker(&track_key);
        detach_native_surface_by_id(surface_id);
        super::super::native_render::registry().remove(surface_id);
        unregister_stream_video_subscription(stream_id, track_id);
    }
}

#[cfg(all(test, feature = "vpx"))]
mod screen_rate_tests {
    use super::{screen_rate_step, ScreenRateDecision, ScreenRateState};

    const PRESET: u32 = 44_000;

    fn run(feedback: &[u32]) -> Vec<ScreenRateDecision> {
        let mut state = ScreenRateState::default();
        feedback
            .iter()
            .map(|&kbps| screen_rate_step(&mut state, PRESET, kbps))
            .collect()
    }

    #[test]
    fn a_rising_estimate_never_caps_the_preset() {
        // The relay probes upward from the goodput while nothing is lost
        // (2.5 Mb/s default, then 1.1x goodput): Movie 50 used to sit at 85%
        // of that. None of it is a limit.
        let decisions = run(&[2_500, 18_700, 20_600, 22_600, 40_000, 100_000]);
        assert!(decisions.iter().all(|d| *d
            == ScreenRateDecision {
                target_kbps: PRESET,
                limited: false
            }));
    }

    #[test]
    fn a_falling_estimate_limits_the_top_layer_and_a_rising_one_lifts_it() {
        let decisions = run(&[
            40_000, 20_000, 20_000, 22_000, 24_200, 30_000, 45_000, 50_000,
        ]);
        let targets: Vec<(u32, bool)> = decisions
            .iter()
            .map(|d| (d.target_kbps, d.limited))
            .collect();
        assert_eq!(
            targets,
            vec![
                (PRESET, false),
                // Loss: 85% of the lowered estimate.
                (17_000, true),
                // Holding (loss between 0.5% and 2%): unchanged.
                (17_000, true),
                // Clear again: a quarter more per rising estimate.
                (21_250, true),
                (26_562, true),
                (33_202, true),
                (41_502, true),
                // Reaches the preset: the limit lifts.
                (PRESET, false),
            ]
        );
    }

    #[test]
    fn a_limit_never_drops_below_the_floor() {
        let decisions = run(&[2_000, 300]);
        assert_eq!(
            decisions[1].target_kbps,
            super::MIN_ADAPTIVE_SCREEN_BITRATE_KBPS
        );
    }
}
