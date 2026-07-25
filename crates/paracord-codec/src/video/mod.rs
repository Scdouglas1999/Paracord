//! Video encoding and decoding pipeline with simulcast support.
//!
//! This module provides a trait-based abstraction for video codecs,
//! with a concrete VP9 implementation gated behind the `vpx` feature flag.
//!
//! # Architecture
//!
//! - [`VideoEncoder`] / [`VideoDecoder`] traits define the codec interface.
//! - [`SimulcastEncoder`] wraps multiple encoder instances for simultaneous
//!   multi-quality encoding (low / medium / high).
//! - [`Vp9Encoder`] / [`Vp9Decoder`] provide the VP9 implementation (requires `vpx` feature).
//! - [`NullEncoder`] / [`NullDecoder`] provide a zero-dependency test/stub implementation.
//!
//! # Simulcast Layers
//!
//! Three quality tiers are defined:
//!
//! | Layer  | Resolution | FPS | Target Bitrate |
//! |--------|-----------|-----|----------------|
//! | Low    | 320x180   | 15  | 150 kbps       |
//! | Medium | 640x360   | 30  | 500 kbps       |
//! | High   | 1280x720  | 30  | 1500 kbps      |

pub mod decoder;
pub mod encoder;
/// GPU-resident decoded-frame handles ([`DecodedFrameHandle`]) — the single type
/// a native video surface consumes (spec §3.2). Additive to the CPU
/// [`DecodedFrame`] API.
pub mod handle;
/// In-process libavcodec GPU codec engine (opt-in `lavc` feature). Replaces the
/// ffmpeg *subprocess* encoders with in-process libavcodec; consumers are
/// switched over by a later integration pass.
#[cfg(feature = "lavc")]
pub mod lavc;

pub use decoder::DecodeOutput;
pub use handle::DecodedFrameHandle;

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ── Error types ──────────────────────────────────────────────────────

/// Errors produced by video encoding or decoding operations.
#[derive(Debug, Error)]
pub enum VideoError {
    #[error("encoder initialization failed: {0}")]
    EncoderInit(String),

    #[error("decoder initialization failed: {0}")]
    DecoderInit(String),

    #[error("encoding failed: {0}")]
    EncodeFailed(String),

    #[error("decoding failed: {0}")]
    DecodeFailed(String),

    #[error("invalid frame dimensions: {width}x{height} (must be even and positive)")]
    InvalidDimensions { width: u32, height: u32 },

    #[error("frame data size mismatch: expected {expected} bytes, got {actual}")]
    FrameSizeMismatch { expected: usize, actual: usize },

    #[error("unsupported pixel format: {0:?}")]
    UnsupportedPixelFormat(PixelFormat),

    #[error("keyframe required but not available")]
    KeyframeRequired,

    #[error("codec not available: {0}")]
    CodecUnavailable(String),
}

// ── Pixel format ─────────────────────────────────────────────────────

/// Pixel format for raw video frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PixelFormat {
    /// Planar YUV 4:2:0 — the native format for VP9.
    /// Layout: Y plane (w*h), U plane (w/2 * h/2), V plane (w/2 * h/2).
    I420,
    /// Packed RGBA (4 bytes per pixel). Convenient for desktop capture.
    Rgba,
    /// Packed BGRA (4 bytes per pixel). Common for native desktop capture.
    Bgra,
}

impl PixelFormat {
    /// Calculate the expected byte size for a frame at the given resolution.
    pub fn frame_size(self, width: u32, height: u32) -> usize {
        match self {
            PixelFormat::I420 => {
                let y = (width * height) as usize;
                let uv = ((width / 2) * (height / 2)) as usize;
                y + 2 * uv
            }
            PixelFormat::Rgba | PixelFormat::Bgra => (width * height * 4) as usize,
        }
    }
}

/// The YUV↔RGB conversion matrix a frame is expressed in (contract C1).
///
/// Project-wide the encode path targets BT.709 limited range and every encoder
/// signals it; `Bt601` exists only to faithfully report a backend whose actual
/// output could not be forced onto BT.709 (signaled must always match actual).
/// A decoder must select the matching matrix when converting to RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum ColorSpace {
    /// ITU-R BT.601 (SDTV) coefficients.
    Bt601,
    /// ITU-R BT.709 (HDTV) coefficients — the project default.
    #[default]
    Bt709,
}

impl ColorSpace {
    /// The colorspace tag written to the packed IPC frame header's reserved
    /// byte (offset 19): `0` = BT.601, `1` = BT.709.
    pub fn header_tag(self) -> u8 {
        match self {
            ColorSpace::Bt601 => 0,
            ColorSpace::Bt709 => 1,
        }
    }

    /// Parse the colorspace tag from the packed IPC frame header. Any value
    /// other than `0` maps to BT.709 (the default), so an older peer that left
    /// the reserved byte zeroed is read as BT.601 only when it explicitly wrote
    /// `0`; unknown/high values fall back to the project default.
    pub fn from_header_tag(value: u8) -> Self {
        match value {
            0 => ColorSpace::Bt601,
            _ => ColorSpace::Bt709,
        }
    }
}

/// High-level hint for how the encoder should tune compression decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VideoContentHint {
    /// Generic/default video content.
    Default,
    /// Prioritize crisp text and UI edges.
    Detail,
    /// Prioritize smooth motion and scene changes.
    Motion,
    /// Prioritize film-like content and grain retention.
    Film,
}

/// Video codec carried on the native media path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VideoCodec {
    Vp9,
    Av1,
    H264,
}

impl VideoCodec {
    pub fn header_id(self) -> u8 {
        match self {
            VideoCodec::Vp9 => 1,
            VideoCodec::Av1 => 2,
            VideoCodec::H264 => 3,
        }
    }

    pub fn from_header_id(value: u8) -> Option<Self> {
        match value {
            1 => Some(VideoCodec::Vp9),
            2 => Some(VideoCodec::Av1),
            3 => Some(VideoCodec::H264),
            _ => None,
        }
    }
}

// ── Simulcast layer definitions ──────────────────────────────────────

/// Identifies a simulcast quality tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SimulcastLayer {
    /// 320x180 @ 15 fps, ~150 kbps
    Low,
    /// 640x360 @ 30 fps, ~500 kbps
    Medium,
    /// 1280x720 @ 30 fps, ~1500 kbps
    High,
}

impl SimulcastLayer {
    /// Resolution (width, height) for this layer.
    pub fn resolution(self) -> (u32, u32) {
        match self {
            SimulcastLayer::Low => (320, 180),
            SimulcastLayer::Medium => (640, 360),
            SimulcastLayer::High => (1280, 720),
        }
    }

    /// Target frame rate for this layer.
    pub fn fps(self) -> u32 {
        match self {
            SimulcastLayer::Low => 15,
            SimulcastLayer::Medium => 30,
            SimulcastLayer::High => 30,
        }
    }

    /// Target bitrate in kilobits per second.
    pub fn bitrate_kbps(self) -> u32 {
        match self {
            SimulcastLayer::Low => 150,
            SimulcastLayer::Medium => 500,
            SimulcastLayer::High => 1500,
        }
    }

    /// All layers from lowest to highest quality.
    pub fn all() -> &'static [SimulcastLayer] {
        &[
            SimulcastLayer::Low,
            SimulcastLayer::Medium,
            SimulcastLayer::High,
        ]
    }
}

// ── Encoder configuration ────────────────────────────────────────────

/// Configuration for creating a video encoder instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderConfig {
    /// Frame width in pixels (must be even).
    pub width: u32,
    /// Frame height in pixels (must be even).
    pub height: u32,
    /// Target frames per second.
    pub fps: u32,
    /// Target bitrate in kilobits per second.
    pub bitrate_kbps: u32,
    /// Input pixel format.
    pub pixel_format: PixelFormat,
    /// Keyframe interval in frames (0 = codec default).
    pub keyframe_interval: u32,
    /// Optional content hint for backend-specific tuning.
    pub content_hint: VideoContentHint,
}

impl EncoderConfig {
    /// Create an `EncoderConfig` matching a simulcast layer definition.
    pub fn for_layer(layer: SimulcastLayer, pixel_format: PixelFormat) -> Self {
        let (width, height) = layer.resolution();
        Self {
            width,
            height,
            fps: layer.fps(),
            bitrate_kbps: layer.bitrate_kbps(),
            pixel_format,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        }
    }

    /// Validate that width and height are even and positive.
    pub fn validate(&self) -> Result<(), VideoError> {
        if self.width == 0
            || self.height == 0
            || !self.width.is_multiple_of(2)
            || !self.height.is_multiple_of(2)
        {
            return Err(VideoError::InvalidDimensions {
                width: self.width,
                height: self.height,
            });
        }
        Ok(())
    }
}

// ── Simulcast ladder policy (spec §4.1) ──────────────────────────────

/// Which capture surface a simulcast ladder is being built for. Screen and
/// camera use different rungs (spec §4.1): screen favors resolution/clarity,
/// camera favors motion smoothness at lower resolutions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimulcastKind {
    /// Desktop/window capture.
    Screen,
    /// Webcam capture.
    Camera,
}

/// Fit `src` into a `max_w`×`max_h` box, preserving aspect ratio, never
/// upscaling, and rounding down to even dimensions (codec requirement).
///
/// This is the config-level twin of the pipeline's `fit_encode_dimensions`,
/// kept here so the ladder helper carries no client dependency.
fn fit_within_box(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 || max_w == 0 || max_h == 0 {
        return (src_w, src_h);
    }
    let (mut w, mut h) = if src_w <= max_w && src_h <= max_h {
        (src_w, src_h)
    } else {
        // Whichever edge hits its cap first bounds the fit.
        let width_limited = (max_w as u64 * src_h as u64) <= (max_h as u64 * src_w as u64);
        if width_limited {
            let fitted_h = ((src_h as u64 * max_w as u64) / src_w as u64) as u32;
            (max_w, fitted_h.clamp(2, max_h))
        } else {
            let fitted_w = ((src_w as u64 * max_h as u64) / src_h as u64) as u32;
            (fitted_w.clamp(2, max_w), max_h)
        }
    };
    w &= !1;
    h &= !1;
    (w.max(2), h.max(2))
}

/// Compute the simulcast ladder for a source per spec §4.1.
///
/// Rungs (lowest→highest), each aspect-fitted to the source and never upscaled:
///
/// - **Screen**: L 640×360@30 / 800 kbps · M 1280×720@min(source,60) / 3500 kbps
///   · H source dims @ source fps / `preset_kbps`.
/// - **Camera**: L 480×270@15 / 350 kbps · M 640×360@30 / 900 kbps
///   · H source dims @ source fps / `preset_kbps`.
///
/// The High rung is always the source dimensions at `preset_kbps`; the lower
/// rungs cap their suggested budget at `preset_kbps` so a low preset never
/// produces a rung richer than the top layer. A rung whose fitted dimensions,
/// fps, and bitrate collapse onto the previous rung (a small source) is dropped
/// so a sub-Medium capture does not triple-encode the same picture. This is a
/// pure function (no runtime probing) so the pipeline phase can build layer
/// configs deterministically.
#[allow(clippy::too_many_arguments)]
pub fn simulcast_ladder(
    kind: SimulcastKind,
    source_width: u32,
    source_height: u32,
    source_fps: u32,
    preset_kbps: u32,
    pixel_format: PixelFormat,
    content_hint: VideoContentHint,
    keyframe_interval_seconds: u32,
) -> Vec<(SimulcastLayer, EncoderConfig)> {
    // (layer, box_w, box_h, max_fps, suggested_kbps).
    let source_rung = (
        SimulcastLayer::High,
        source_width,
        source_height,
        source_fps,
        preset_kbps,
    );
    let rungs: [(SimulcastLayer, u32, u32, u32, u32); 3] = match kind {
        SimulcastKind::Screen => [
            (SimulcastLayer::Low, 640, 360, 30, 800),
            (SimulcastLayer::Medium, 1280, 720, 60, 3_500),
            source_rung,
        ],
        SimulcastKind::Camera => [
            (SimulcastLayer::Low, 480, 270, 15, 350),
            (SimulcastLayer::Medium, 640, 360, 30, 900),
            source_rung,
        ],
    };

    let mut out: Vec<(SimulcastLayer, EncoderConfig)> = Vec::with_capacity(3);
    for (layer, box_w, box_h, max_fps, suggested_kbps) in rungs {
        let (width, height) = fit_within_box(source_width, source_height, box_w, box_h);
        let fps = source_fps.min(max_fps).max(1);
        let bitrate_kbps = match layer {
            // The top layer always rides the preset budget; lower rungs cap
            // their suggested budget at the preset.
            SimulcastLayer::High => preset_kbps.max(1),
            _ => suggested_kbps.min(preset_kbps).max(1),
        };
        let config = EncoderConfig {
            width,
            height,
            fps,
            bitrate_kbps,
            pixel_format,
            keyframe_interval: fps.saturating_mul(keyframe_interval_seconds),
            content_hint,
        };
        if out.last().is_some_and(|(_, prev)| {
            prev.width == config.width
                && prev.height == config.height
                && prev.fps == config.fps
                && prev.bitrate_kbps == config.bitrate_kbps
        }) {
            continue;
        }
        out.push((layer, config));
    }

    if out.is_empty() {
        out.push((
            SimulcastLayer::High,
            EncoderConfig {
                width: source_width.max(2) & !1,
                height: source_height.max(2) & !1,
                fps: source_fps.max(1),
                bitrate_kbps: preset_kbps.max(1),
                pixel_format,
                keyframe_interval: source_fps.max(1).saturating_mul(keyframe_interval_seconds),
                content_hint,
            },
        ));
    }

    out
}

// ── Decoder configuration ────────────────────────────────────────────

/// Configuration for creating a video decoder instance.
#[derive(Debug, Clone)]
pub struct DecoderConfig {
    /// Output pixel format.
    pub pixel_format: PixelFormat,
    /// The largest resolution the remote peer negotiated for this track when it
    /// published it (`TrackPublish` layer dimensions), if known.
    ///
    /// The decoder's own resolution ceiling is a global 8K constant — enough to
    /// let a peer that published a 320x180 layer hand every frame an 8K
    /// bitstream header, so a few hundred bytes of all-skip keyframe expands
    /// into a ~50 MB plane allocation and (for VP9) a 16-thread decoder. Setting
    /// this caps the decode at what the peer actually announced. `None` keeps
    /// only the global ceiling.
    pub max_dimensions: Option<(u32, u32)>,
}

impl Default for DecoderConfig {
    fn default() -> Self {
        Self {
            pixel_format: PixelFormat::I420,
            max_dimensions: None,
        }
    }
}

/// Tolerance applied to a peer's negotiated resolution before it becomes a hard
/// decode cap. Encoders align dimensions up (macroblock/CTU granularity) and a
/// publisher may bump its top layer slightly between the `TrackPublish` we hold
/// and the frames in flight, so the cap is deliberately loose — it exists to
/// turn "unbounded" into "bounded by what was announced", not to police exact
/// pixel counts.
const NEGOTIATED_RESOLUTION_TOLERANCE: u32 = 2;

/// Resolve the effective decode ceiling for a track: the peer's negotiated
/// resolution (scaled by [`NEGOTIATED_RESOLUTION_TOLERANCE`]) when known, always
/// clamped by the global limits. Returns `(max_width, max_height, max_pixels)`.
pub fn negotiated_decode_ceiling(
    negotiated: Option<(u32, u32)>,
    global_max_dimension: u32,
    global_max_pixels: u32,
) -> (u32, u32, u32) {
    match negotiated {
        Some((w, h)) if w > 0 && h > 0 => {
            let max_w = w
                .saturating_mul(NEGOTIATED_RESOLUTION_TOLERANCE)
                .min(global_max_dimension);
            let max_h = h
                .saturating_mul(NEGOTIATED_RESOLUTION_TOLERANCE)
                .min(global_max_dimension);
            let max_px = max_w
                .checked_mul(max_h)
                .unwrap_or(global_max_pixels)
                .min(global_max_pixels);
            (max_w, max_h, max_px)
        }
        _ => (
            global_max_dimension,
            global_max_dimension,
            global_max_pixels,
        ),
    }
}

// ── Encoded / decoded frame types ────────────────────────────────────

/// An encoded video frame produced by a [`VideoEncoder`].
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    /// The compressed frame data.
    pub data: Vec<u8>,
    /// Codec used to encode this frame.
    pub codec: VideoCodec,
    /// Presentation timestamp (units depend on encoder timebase).
    pub pts: i64,
    /// Whether this frame is a keyframe (IDR / intra).
    pub is_keyframe: bool,
    /// Which simulcast layer produced this frame, if applicable.
    pub layer: Option<SimulcastLayer>,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Colorspace the bitstream is signaled in (contract C1). This is the
    /// matrix the encoder actually produced, not merely the requested one.
    pub colorspace: ColorSpace,
}

/// A decoded video frame produced by a [`VideoDecoder`].
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    /// Raw pixel data in the format indicated by `pixel_format`.
    pub data: Vec<u8>,
    /// Pixel format of the data buffer.
    pub pixel_format: PixelFormat,
    /// Frame width.
    pub width: u32,
    /// Frame height.
    pub height: u32,
    /// Presentation timestamp forwarded from the encoded frame.
    pub pts: i64,
    /// Colorspace the source bitstream was signaled in (contract C1); selects
    /// the YUV→RGB matrix a consumer must use to convert `data`.
    pub colorspace: ColorSpace,
}

// ── Color-space conversion helpers ───────────────────────────────────

#[inline]
fn clamp_to_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

// BT.709 limited-range (studio swing) coefficients in Q8 fixed point. These
// replace the previous BT.601 set so the whole encode path is 709 (contract
// C1); the inverse in `i420_to_rgba` uses the matching 709 dequant matrix.
#[inline]
fn rgb_to_y(r: i32, g: i32, b: i32) -> u8 {
    clamp_to_u8(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16)
}

#[inline]
fn rgb_to_u(r: i32, g: i32, b: i32) -> u8 {
    clamp_to_u8(((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128)
}

#[inline]
fn rgb_to_v(r: i32, g: i32, b: i32) -> u8 {
    clamp_to_u8(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128)
}

/// Packed 4-byte-per-pixel RGB → I420. This runs once per captured frame at
/// full screen resolution, so it is written for autovectorization: channel
/// offsets are const generics (constant-folded per format) and both passes
/// walk fixed-size row/pixel chunks so LLVM can elide bounds checks and emit
/// SIMD. Do not rewrite with per-pixel indexing — that form is ~an order of
/// magnitude slower and made screen sharing CPU-bound.
fn packed_rgb_to_i420<const R: usize, const G: usize, const B: usize>(
    data: &[u8],
    width: u32,
    height: u32,
    i420: &mut [u8],
) {
    let w = width as usize;
    let h = height as usize;
    let y_size = w * h;
    let uv_w = w / 2;
    let uv_h = h / 2;
    let row_bytes = w * 4;

    let (y_plane, uv_planes) = i420.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_w * uv_h);

    // Luma pass: one output byte per source pixel.
    for (src_row, y_row) in data
        .chunks_exact(row_bytes)
        .zip(y_plane.chunks_exact_mut(w))
        .take(h)
    {
        for (px, y_out) in src_row.chunks_exact(4).zip(y_row.iter_mut()) {
            *y_out = rgb_to_y(px[R] as i32, px[G] as i32, px[B] as i32);
        }
    }

    // Chroma pass: average each 2x2 pixel block. Walk row pairs and 2-pixel
    // (8-byte) chunks so all offsets are compile-time constants.
    for ((row_pair, u_row), v_row) in data
        .chunks_exact(row_bytes * 2)
        .zip(u_plane.chunks_exact_mut(uv_w))
        .zip(v_plane.chunks_exact_mut(uv_w))
        .take(uv_h)
    {
        let (top, bottom) = row_pair.split_at(row_bytes);
        for (((top_px, bottom_px), u_out), v_out) in top
            .chunks_exact(8)
            .zip(bottom.chunks_exact(8))
            .zip(u_row.iter_mut())
            .zip(v_row.iter_mut())
        {
            let r_sum = top_px[R] as i32
                + top_px[4 + R] as i32
                + bottom_px[R] as i32
                + bottom_px[4 + R] as i32;
            let g_sum = top_px[G] as i32
                + top_px[4 + G] as i32
                + bottom_px[G] as i32
                + bottom_px[4 + G] as i32;
            let b_sum = top_px[B] as i32
                + top_px[4 + B] as i32
                + bottom_px[B] as i32
                + bottom_px[4 + B] as i32;
            let r = (r_sum + 2) >> 2;
            let g = (g_sum + 2) >> 2;
            let b = (b_sum + 2) >> 2;
            *u_out = rgb_to_u(r, g, b);
            *v_out = rgb_to_v(r, g, b);
        }
    }
}

/// Convert an RGBA frame to I420 (YUV 4:2:0) in-place.
///
/// Both buffers must be pre-allocated to the correct sizes.
pub fn rgba_to_i420(rgba: &[u8], width: u32, height: u32, i420: &mut [u8]) {
    packed_rgb_to_i420::<0, 1, 2>(rgba, width, height, i420);
}

/// Convert a BGRA frame to I420 (YUV 4:2:0) in-place.
///
/// Both buffers must be pre-allocated to the correct sizes.
pub fn bgra_to_i420(bgra: &[u8], width: u32, height: u32, i420: &mut [u8]) {
    packed_rgb_to_i420::<2, 1, 0>(bgra, width, height, i420);
}

/// Convert an I420 (YUV 4:2:0) frame to RGBA.
///
/// Both buffers must be pre-allocated to the correct sizes.
pub fn i420_to_rgba(i420: &[u8], width: u32, height: u32, rgba: &mut [u8]) {
    let w = width as usize;
    let h = height as usize;
    let y_size = w * h;
    let uv_w = w / 2;
    let uv_h = h / 2;
    let uv_size = uv_w * uv_h;

    let y_plane = &i420[..y_size];
    let u_plane = &i420[y_size..y_size + uv_size];
    let v_plane = &i420[y_size + uv_size..];

    // Row-sliced, fixed-chunk iteration (2 luma pixels share one chroma
    // sample) keeps the inner loop free of bounds checks and index math so it
    // vectorizes. Same arithmetic as before, byte-for-byte.
    for (row, (y_row, out_row)) in y_plane
        .chunks_exact(w)
        .zip(rgba.chunks_exact_mut(w * 4))
        .enumerate()
        .take(h)
    {
        let chroma_row = (row / 2).min(uv_h.saturating_sub(1));
        let u_row = &u_plane[chroma_row * uv_w..chroma_row * uv_w + uv_w];
        let v_row = &v_plane[chroma_row * uv_w..chroma_row * uv_w + uv_w];

        for (((y_pair, out_pair), &u), &v) in y_row
            .chunks_exact(2)
            .zip(out_row.chunks_exact_mut(8))
            .zip(u_row.iter())
            .zip(v_row.iter())
        {
            let d = u as i32 - 128;
            let e = v as i32 - 128;
            for (&y, out) in y_pair.iter().zip(out_pair.chunks_exact_mut(4)) {
                let c = (y as i32 - 16).max(0);
                // BT.709 limited-range dequant (Q8), inverse of rgb_to_{y,u,v}.
                out[0] = clamp_to_u8((298 * c + 459 * e + 128) >> 8);
                out[1] = clamp_to_u8((298 * c - 55 * d - 136 * e + 128) >> 8);
                out[2] = clamp_to_u8((298 * c + 541 * d + 128) >> 8);
                out[3] = 255; // full alpha
            }
        }
    }
}

fn bilinear_sample_plane(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    dst: &mut [u8],
    dst_w: usize,
    dst_h: usize,
) {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return;
    }

    let x_scale = src_w as f32 / dst_w as f32;
    let y_scale = src_h as f32 / dst_h as f32;

    for (row, dst_row) in dst.chunks_exact_mut(dst_w).enumerate().take(dst_h) {
        let src_y = ((row as f32 + 0.5) * y_scale - 0.5).clamp(0.0, (src_h - 1) as f32);
        let y0 = src_y.floor() as usize;
        let y1 = (y0 + 1).min(src_h - 1);
        let fy = src_y - y0 as f32;
        let src_row0 = &src[y0 * src_w..y0 * src_w + src_w];
        let src_row1 = &src[y1 * src_w..y1 * src_w + src_w];

        for (col, out) in dst_row.iter_mut().enumerate() {
            let src_x = ((col as f32 + 0.5) * x_scale - 0.5).clamp(0.0, (src_w - 1) as f32);
            let x0 = src_x.floor() as usize;
            let x1 = (x0 + 1).min(src_w - 1);
            let fx = src_x - x0 as f32;

            let top = src_row0[x0] as f32 * (1.0 - fx) + src_row0[x1] as f32 * fx;
            let bottom = src_row1[x0] as f32 * (1.0 - fx) + src_row1[x1] as f32 * fx;
            *out = (top * (1.0 - fy) + bottom * fy).round() as u8;
        }
    }
}

/// Downscale an I420 frame to a target resolution using bilinear filtering.
pub fn downscale_i420(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let sw = src_w as usize;
    let sh = src_h as usize;
    let dw = dst_w as usize;
    let dh = dst_h as usize;

    let src_y_size = sw * sh;
    let src_uv_w = sw / 2;
    let src_uv_h = sh / 2;
    let src_uv_size = src_uv_w * src_uv_h;

    let dst_y_size = dw * dh;
    let dst_uv_w = dw / 2;
    let dst_uv_h = dh / 2;
    let dst_uv_size = dst_uv_w * dst_uv_h;

    let mut dst = vec![0u8; dst_y_size + 2 * dst_uv_size];

    let src_y = &src[..src_y_size];
    let src_u = &src[src_y_size..src_y_size + src_uv_size];
    let src_v = &src[src_y_size + src_uv_size..];

    let (dst_y, dst_uv) = dst.split_at_mut(dst_y_size);
    let (dst_u, dst_v) = dst_uv.split_at_mut(dst_uv_size);

    bilinear_sample_plane(src_y, sw, sh, dst_y, dw, dh);
    bilinear_sample_plane(src_u, src_uv_w, src_uv_h, dst_u, dst_uv_w, dst_uv_h);
    bilinear_sample_plane(src_v, src_uv_w, src_uv_h, dst_v, dst_uv_w, dst_uv_h);

    dst
}

// ── AV1 OBU keyframe detection ───────────────────────────────────────
//
// Feature-independent so both the lavc engine and the Windows Media Foundation
// AV1 encoder can classify a temporal unit without depending on `lavc`. A
// hardware MFT that lies about `MFSampleExtension_CleanPoint` would otherwise
// leave viewers unable to prime (permanent blank stream), so the MF path ORs a
// real bitstream parse into its keyframe decision.

const AV1_OBU_SEQUENCE_HEADER: u8 = 1;

/// Whether an AV1 temporal unit contains a sequence-header OBU, which hardware
/// encoders emit exactly on keyframes. Single source of truth for AV1 keyframe
/// detection across every backend.
pub fn av1_temporal_unit_is_keyframe(data: &[u8]) -> bool {
    let mut offset = 0usize;
    while offset < data.len() {
        let header = data[offset];
        // Forbidden bit set means we lost sync; stop parsing.
        if header & 0x80 != 0 {
            return false;
        }
        let obu_type = (header >> 3) & 0x0F;
        let has_extension = header & 0x04 != 0;
        let has_size = header & 0x02 != 0;
        offset += 1;
        if has_extension {
            offset += 1;
        }
        if !has_size {
            // Size-less OBU extends to the end of the temporal unit.
            return obu_type == AV1_OBU_SEQUENCE_HEADER;
        }
        let Some((size, leb_len)) = read_leb128(&data[offset.min(data.len())..]) else {
            return false;
        };
        offset += leb_len;
        if obu_type == AV1_OBU_SEQUENCE_HEADER {
            return true;
        }
        offset = match offset.checked_add(size as usize) {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

fn read_leb128(data: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (index, byte) in data.iter().take(8).enumerate() {
        value |= u64::from(byte & 0x7F) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_av1_keyframe_via_sequence_header() {
        // temporal delimiter (2) + sequence header (1) + frame (6).
        let tu = [
            (2u8 << 3) | 0x02,
            0, // TD, size 0
            (1u8 << 3) | 0x02,
            2,
            0xAA,
            0xBB, // seq header, size 2
            (6u8 << 3) | 0x02,
            2,
            1,
            2, // frame, size 2
        ];
        assert!(av1_temporal_unit_is_keyframe(&tu));

        let delta = [(2u8 << 3) | 0x02, 0, (6u8 << 3) | 0x02, 2, 1, 2];
        assert!(!av1_temporal_unit_is_keyframe(&delta));
        assert!(!av1_temporal_unit_is_keyframe(&[]));
    }

    #[test]
    fn pixel_format_frame_sizes() {
        assert_eq!(PixelFormat::I420.frame_size(320, 180), 320 * 180 * 3 / 2);
        assert_eq!(PixelFormat::Rgba.frame_size(320, 180), 320 * 180 * 4);
        assert_eq!(PixelFormat::I420.frame_size(1280, 720), 1280 * 720 * 3 / 2);
    }

    #[test]
    fn simulcast_layer_properties() {
        assert_eq!(SimulcastLayer::Low.resolution(), (320, 180));
        assert_eq!(SimulcastLayer::Medium.resolution(), (640, 360));
        assert_eq!(SimulcastLayer::High.resolution(), (1280, 720));

        assert_eq!(SimulcastLayer::Low.fps(), 15);
        assert_eq!(SimulcastLayer::Medium.fps(), 30);
        assert_eq!(SimulcastLayer::High.fps(), 30);
    }

    #[test]
    fn encoder_config_validation() {
        let good = EncoderConfig::for_layer(SimulcastLayer::Low, PixelFormat::I420);
        assert!(good.validate().is_ok());

        let bad = EncoderConfig {
            width: 321,
            height: 180,
            fps: 30,
            bitrate_kbps: 500,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        };
        assert!(bad.validate().is_err());

        let zero = EncoderConfig {
            width: 0,
            height: 0,
            fps: 30,
            bitrate_kbps: 500,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        };
        assert!(zero.validate().is_err());
    }

    #[test]
    fn rgba_i420_round_trip() {
        let w: u32 = 8;
        let h: u32 = 8;

        // Create a red RGBA frame
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[0] = 200; // R
            pixel[1] = 50; // G
            pixel[2] = 30; // B
            pixel[3] = 255; // A
        }

        // Convert to I420
        let i420_size = PixelFormat::I420.frame_size(w, h);
        let mut i420 = vec![0u8; i420_size];
        rgba_to_i420(&rgba, w, h, &mut i420);

        // Convert back to RGBA
        let mut rgba2 = vec![0u8; (w * h * 4) as usize];
        i420_to_rgba(&i420, w, h, &mut rgba2);

        // Check that the round-tripped values are close (lossy conversion)
        for pixel in rgba2.chunks_exact(4) {
            // Allow +/- 5 due to rounding in YUV conversion
            assert!(
                (pixel[0] as i16 - 200).unsigned_abs() <= 5,
                "R channel off: {}",
                pixel[0]
            );
            assert!(
                (pixel[1] as i16 - 50).unsigned_abs() <= 5,
                "G channel off: {}",
                pixel[1]
            );
            assert!(
                (pixel[2] as i16 - 30).unsigned_abs() <= 5,
                "B channel off: {}",
                pixel[2]
            );
            assert_eq!(pixel[3], 255, "Alpha must be preserved");
        }
    }

    #[test]
    fn simulcast_ladder_screen_matches_spec() {
        // 1920x1080@60 16:9 source, generous preset. Spec §4.1 screen rungs.
        let ladder = simulcast_ladder(
            SimulcastKind::Screen,
            1920,
            1080,
            60,
            12_000,
            PixelFormat::Bgra,
            VideoContentHint::Detail,
            2,
        );
        assert_eq!(ladder.len(), 3);

        let (l, low) = &ladder[0];
        assert_eq!(*l, SimulcastLayer::Low);
        assert_eq!(
            (low.width, low.height, low.fps, low.bitrate_kbps),
            (640, 360, 30, 800)
        );
        assert_eq!(low.pixel_format, PixelFormat::Bgra);
        assert_eq!(low.keyframe_interval, 60); // fps * seconds

        let (m, med) = &ladder[1];
        assert_eq!(*m, SimulcastLayer::Medium);
        assert_eq!(
            (med.width, med.height, med.fps, med.bitrate_kbps),
            (1280, 720, 60, 3_500)
        );

        let (h, high) = &ladder[2];
        assert_eq!(*h, SimulcastLayer::High);
        assert_eq!(
            (high.width, high.height, high.fps, high.bitrate_kbps),
            (1920, 1080, 60, 12_000)
        );
    }

    #[test]
    fn simulcast_ladder_camera_matches_spec() {
        // 1920x1080@30 source. Spec §4.1 camera rungs.
        let ladder = simulcast_ladder(
            SimulcastKind::Camera,
            1920,
            1080,
            30,
            2_500,
            PixelFormat::I420,
            VideoContentHint::Motion,
            2,
        );
        assert_eq!(ladder.len(), 3);
        assert_eq!(ladder[0].0, SimulcastLayer::Low);
        assert_eq!(
            {
                let c = &ladder[0].1;
                (c.width, c.height, c.fps, c.bitrate_kbps)
            },
            (480, 270, 15, 350)
        );
        assert_eq!(ladder[1].0, SimulcastLayer::Medium);
        assert_eq!(
            {
                let c = &ladder[1].1;
                (c.width, c.height, c.fps, c.bitrate_kbps)
            },
            (640, 360, 30, 900)
        );
        assert_eq!(ladder[2].0, SimulcastLayer::High);
        assert_eq!(
            {
                let c = &ladder[2].1;
                (c.width, c.height, c.fps, c.bitrate_kbps)
            },
            (1920, 1080, 30, 2_500)
        );
    }

    #[test]
    fn simulcast_ladder_screen_m_caps_fps_at_source() {
        // A 30 fps source must not ask the Medium screen rung for 60 fps.
        let ladder = simulcast_ladder(
            SimulcastKind::Screen,
            1920,
            1080,
            30,
            8_000,
            PixelFormat::Bgra,
            VideoContentHint::Detail,
            0,
        );
        let (_, med) = ladder
            .iter()
            .find(|(l, _)| *l == SimulcastLayer::Medium)
            .unwrap();
        assert_eq!(med.fps, 30);
        // keyframe_interval_seconds=0 → codec-default cadence (0).
        assert_eq!(med.keyframe_interval, 0);
    }

    #[test]
    fn simulcast_ladder_low_preset_caps_lower_rungs() {
        // A preset below a rung's suggested budget clamps that rung's bitrate.
        let ladder = simulcast_ladder(
            SimulcastKind::Screen,
            1920,
            1080,
            60,
            600, // below Low's 800 and Medium's 3500
            PixelFormat::Bgra,
            VideoContentHint::Detail,
            2,
        );
        for (_, cfg) in &ladder {
            assert!(
                cfg.bitrate_kbps <= 600,
                "rung bitrate {} exceeds preset",
                cfg.bitrate_kbps
            );
        }
    }

    #[test]
    fn simulcast_ladder_small_source_collapses_and_dedupes() {
        // A 640x360 source is at/below both lower screen boxes; rungs collapse
        // onto the source, so the ladder de-duplicates instead of triple-
        // encoding the same picture.
        let ladder = simulcast_ladder(
            SimulcastKind::Screen,
            640,
            360,
            30,
            1_000,
            PixelFormat::I420,
            VideoContentHint::Detail,
            2,
        );
        // Every surviving rung is 640x360 (the source); duplicates are dropped
        // (dedup keeps the first occurrence, matching the pipeline's ladder), so
        // fewer than three rungs remain and none upscales past the source.
        for (_, cfg) in &ladder {
            assert_eq!((cfg.width, cfg.height), (640, 360));
        }
        assert!(
            ladder.len() < 3,
            "collapsed rungs must dedupe (got {})",
            ladder.len()
        );
    }

    #[test]
    fn simulcast_ladder_non_16_9_source_aspect_fits() {
        // 16:10 source: Low rung fits inside the 640x360 box preserving aspect,
        // so it is not the literal 640x360 preset.
        let ladder = simulcast_ladder(
            SimulcastKind::Screen,
            1920,
            1200,
            60,
            10_000,
            PixelFormat::Bgra,
            VideoContentHint::Detail,
            2,
        );
        let (_, low) = &ladder[0];
        assert!(low.width.is_multiple_of(2) && low.height.is_multiple_of(2));
        // Aspect preserved (16:10 → height bound): 360-tall box, width 576.
        assert_eq!((low.width, low.height), (576, 360));
    }

    #[test]
    fn downscale_i420_basic() {
        let src_w: u32 = 8;
        let src_h: u32 = 8;
        let dst_w: u32 = 4;
        let dst_h: u32 = 4;

        let src_size = PixelFormat::I420.frame_size(src_w, src_h);
        let dst_size = PixelFormat::I420.frame_size(dst_w, dst_h);

        // Fill with a known pattern: Y=128, U=64, V=192
        let mut src = vec![0u8; src_size];
        let y_size = (src_w * src_h) as usize;
        let uv_size = ((src_w / 2) * (src_h / 2)) as usize;
        src[..y_size].fill(128);
        src[y_size..y_size + uv_size].fill(64);
        src[y_size + uv_size..].fill(192);

        let dst = downscale_i420(&src, src_w, src_h, dst_w, dst_h);
        assert_eq!(dst.len(), dst_size);

        let dy = (dst_w * dst_h) as usize;
        let duv = ((dst_w / 2) * (dst_h / 2)) as usize;
        // Uniform input should produce uniform output
        assert!(dst[..dy].iter().all(|&v| v == 128));
        assert!(dst[dy..dy + duv].iter().all(|&v| v == 64));
        assert!(dst[dy + duv..].iter().all(|&v| v == 192));
    }
}
