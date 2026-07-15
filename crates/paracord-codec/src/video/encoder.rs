//! Video encoder with simulcast support.
//!
//! This module defines the [`VideoEncoder`] trait and provides two
//! implementations:
//!
//! - [`Vp9Encoder`] (requires the `vpx` feature) — hardware-quality VP9
//!   encoding via libvpx.
//! - [`NullEncoder`] — a zero-dependency stub that "encodes" by passing raw
//!   data through. Useful for testing, development, and platforms where
//!   libvpx is not available.
//!
//! [`SimulcastEncoder`] wraps any `VideoEncoder` implementation and manages
//! multiple encoder instances for simultaneous multi-quality output.

#[cfg(feature = "vpx")]
use super::VideoContentHint;
use super::{
    bgra_to_i420, downscale_i420, rgba_to_i420, ColorSpace, EncodedFrame, EncoderConfig,
    PixelFormat, SimulcastLayer, VideoCodec, VideoError,
};

#[cfg(target_os = "windows")]
mod windows_h264;
// macOS has no lavc/MF encoder; VideoToolbox is the platform hardware codec.
#[cfg(target_os = "macos")]
pub mod videotoolbox;
// Linux H.264/AV1 encode is the in-process libavcodec GPU engine (NVENC →
// VAAPI → QSV, chosen once at construction). The ffmpeg-subprocess backends it
// replaced are gone.
#[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
use crate::video::lavc::LavcEncoder;
#[cfg(target_os = "macos")]
pub use videotoolbox::VideoToolboxH264Encoder;
#[cfg(target_os = "windows")]
pub use windows_h264::MfAv1Encoder;
#[cfg(target_os = "windows")]
pub use windows_h264::MfH264Encoder;
#[cfg(target_os = "windows")]
pub use windows_h264::WindowsAv1BackendProbe;
#[cfg(target_os = "windows")]
pub use windows_h264::WindowsH264BackendProbe;

// ── VideoEncoder trait ───────────────────────────────────────────────

/// Trait for video encoders.
///
/// Implementations must be able to encode raw pixel data into compressed
/// frames. The encoder is configured once at creation and accepts frames
/// sequentially via [`encode`](VideoEncoder::encode).
pub trait VideoEncoder: Send {
    /// Encode a single frame of raw pixel data.
    ///
    /// - `pts` — presentation timestamp in encoder timebase units.
    /// - `data` — raw pixel data in the format specified during construction.
    /// - `force_keyframe` — if `true`, the encoder should produce a keyframe.
    ///
    /// Returns zero or more encoded frames (some codecs buffer internally).
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError>;

    /// Flush any buffered frames from the encoder.
    ///
    /// Call this when the stream ends to retrieve trailing frames.
    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError>;

    /// Return the encoder configuration.
    fn config(&self) -> &EncoderConfig;

    /// Codec produced by this encoder.
    fn codec(&self) -> VideoCodec;

    /// Human-readable backend identifier used for diagnostics.
    fn backend_name(&self) -> &'static str;

    /// Whether this encoder backend is hardware accelerated.
    fn is_hardware_accelerated(&self) -> bool {
        false
    }

    /// Number of input frames this encoder has dropped (e.g. because the
    /// backend could not accept the frame in time). Surfaced for diagnostics /
    /// congestion telemetry; most backends never drop and return `0`.
    fn dropped_frames(&self) -> u64 {
        0
    }

    /// Raw frame dimensions accepted by this encoder. Most encoders consume
    /// their configured output size; hardware encoders may scale on the GPU.
    fn input_dimensions(&self) -> (u32, u32) {
        let config = self.config();
        (config.width, config.height)
    }

    /// Update the target bitrate mid-stream for congestion response.
    ///
    /// Returns `Ok(true)` if the new rate was applied, `Ok(false)` if this
    /// backend chose not to retarget (the caller keeps the current rate).
    ///
    /// Backends that expose a live rate-control reconfigure (libvpx) apply it in
    /// place. Backends that do not (the lavc hardware encoders) are permitted —
    /// and expected — to rebuild their pipeline at the new rate *inside* this
    /// call: same backend, no re-probe, a forced IDR on the next frame. The
    /// rebuild is synchronous and in-process, so the old prohibition on
    /// reinitializing here (which guarded a subprocess-restart hazard that no
    /// longer exists) does not apply. Implementations must self-throttle so a
    /// chatty congestion loop cannot rebuild every frame.
    fn set_bitrate(&mut self, _bitrate_kbps: u32) -> Result<bool, VideoError> {
        Ok(false)
    }
}

pub fn create_encoder(
    codec: VideoCodec,
    config: EncoderConfig,
) -> Result<Box<dyn VideoEncoder>, VideoError> {
    match codec {
        #[cfg(feature = "vpx")]
        VideoCodec::Vp9 => Ok(Box::new(Vp9Encoder::new(config)?)),
        #[cfg(not(feature = "vpx"))]
        VideoCodec::Vp9 => Err(VideoError::CodecUnavailable(format!(
            "vp9 encoder unavailable without 'vpx' feature (requested {}x{})",
            config.width, config.height
        ))),
        #[cfg(target_os = "windows")]
        VideoCodec::Av1 => Ok(Box::new(MfAv1Encoder::new(config)?)),
        #[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
        VideoCodec::Av1 => Ok(Box::new(LavcEncoder::new(VideoCodec::Av1, config)?)),
        #[cfg(all(unix, not(target_os = "macos"), not(feature = "lavc")))]
        VideoCodec::Av1 => Err(VideoError::CodecUnavailable(
            "av1 encoder backend requires the 'lavc' feature on this platform".into(),
        )),
        #[cfg(all(not(target_os = "windows"), not(all(unix, not(target_os = "macos")))))]
        VideoCodec::Av1 => Err(VideoError::CodecUnavailable(
            "av1 encoder backend not implemented on this platform yet".into(),
        )),
        #[cfg(target_os = "windows")]
        VideoCodec::H264 => Ok(Box::new(MfH264Encoder::new(config)?)),
        #[cfg(target_os = "macos")]
        VideoCodec::H264 => Ok(Box::new(VideoToolboxH264Encoder::new(config)?)),
        #[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
        VideoCodec::H264 => Ok(Box::new(LavcEncoder::new(VideoCodec::H264, config)?)),
        #[cfg(all(unix, not(target_os = "macos"), not(feature = "lavc")))]
        VideoCodec::H264 => Err(VideoError::CodecUnavailable(
            "h264 encoder backend requires the 'lavc' feature on this platform".into(),
        )),
        #[cfg(all(
            not(target_os = "windows"),
            not(target_os = "macos"),
            not(all(unix, not(target_os = "macos")))
        ))]
        VideoCodec::H264 => Err(VideoError::CodecUnavailable(
            "h264 encoder backend not implemented on this platform yet".into(),
        )),
    }
}

// ── SimulcastEncoder ─────────────────────────────────────────────────

/// Manages multiple [`VideoEncoder`] instances, one per simulcast layer.
///
/// Two input routes, each fixed once at construction (spec §4.1 — one
/// deterministic route per encoder, never switched at runtime):
///
/// - **Packed mode** (`input_format` is BGRA/RGBA *and* every layer encoder is
///   hardware): the full packed capture buffer is routed straight to each
///   layer's encoder, which scales+converts on the GPU (built via
///   `new_with_input(capture → layer)`). No CPU `bgra_to_i420`, no
///   `downscale_i420`.
/// - **I420 mode** (the software floor): the frame is converted to I420 once
///   (if needed) and bilinearly downscaled to each layer's configured
///   dimensions on the CPU.
///
/// A simulcast set that mixes hardware and software encoders has no correct
/// route (packed needs all-hardware; the CPU floor needs all-software) and is a
/// construction error.
pub struct SimulcastEncoder {
    /// Per-layer encoders ordered from lowest to highest quality, each with
    /// the exact dimensions its encoder was configured for. Downscaling must
    /// target these — not `SimulcastLayer::resolution()` presets — because
    /// layer configs are aspect-fitted to the actual input and only match the
    /// presets when the input happens to be 16:9.
    layers: Vec<LayerEncoder>,
    /// Pixel format of the input frames.
    input_format: PixelFormat,
    /// Width of the input frames (must match the highest layer or be provided externally).
    input_width: u32,
    /// Height of the input frames.
    input_height: u32,
    /// Reusable I420 conversion buffer for RGBA input.
    i420_buf: Vec<u8>,
    /// Backend identifier shared by the per-layer encoders.
    backend_name: &'static str,
    /// Whether the underlying encoder backend is hardware accelerated.
    hardware_accelerated: bool,
    /// Packed-input route selected at construction (spec §4.1): when set, the
    /// packed capture buffer is handed to every layer encoder untouched (GPU
    /// scale+convert per layer). Fixed here; never toggled per frame.
    packed_mode: bool,
}

struct LayerEncoder {
    layer: SimulcastLayer,
    width: u32,
    height: u32,
    encoder: Box<dyn VideoEncoder>,
}

impl SimulcastEncoder {
    /// Create a new simulcast encoder with explicit per-layer configurations.
    pub fn new_with_configs<F>(
        input_width: u32,
        input_height: u32,
        input_format: PixelFormat,
        layers: &[(SimulcastLayer, EncoderConfig)],
        mut factory: F,
    ) -> Result<Self, VideoError>
    where
        F: FnMut(EncoderConfig) -> Result<Box<dyn VideoEncoder>, VideoError>,
    {
        let mut layer_encoders = Vec::with_capacity(layers.len());
        let mut backend_name = "unknown";
        let mut hw_flags = Vec::with_capacity(layers.len());
        for (layer, config) in layers {
            let config = config.clone();
            config.validate()?;
            let (width, height) = (config.width, config.height);
            let enc = factory(config)?;
            if layer_encoders.is_empty() {
                backend_name = enc.backend_name();
            }
            hw_flags.push(enc.is_hardware_accelerated());
            layer_encoders.push(LayerEncoder {
                layer: *layer,
                width,
                height,
                encoder: enc,
            });
        }

        // One deterministic route per encoder (spec §4.1): the set must be
        // uniformly hardware (packed GPU simulcast) or uniformly software (the
        // I420 CPU floor). A mixed set has no correct route, so reject it loudly
        // at construction rather than silently pick one.
        let hardware_accelerated = hw_flags.first().copied().unwrap_or(false);
        if hw_flags.iter().any(|&hw| hw != hardware_accelerated) {
            return Err(VideoError::EncoderInit(
                "simulcast layer set mixes hardware and software encoders; a set must \
                 be all-hardware (packed GPU simulcast) or all-software (the I420 \
                 floor) (spec §4.1)"
                    .into(),
            ));
        }

        // Packed-input mode (spec §4.1): packed capture buffer + all-hardware
        // layers. Each layer encoder was built new_with_input(capture → layer)
        // and scales+converts on the GPU, so the raw packed buffer is routed to
        // every layer with no CPU conversion or downscale.
        let packed_mode = hardware_accelerated
            && !layer_encoders.is_empty()
            && matches!(input_format, PixelFormat::Bgra | PixelFormat::Rgba);

        // The I420 conversion buffer is only used on the CPU floor; the packed
        // route never touches it, so skip the full-frame allocation there.
        let i420_buf = if packed_mode {
            Vec::new()
        } else {
            vec![0u8; PixelFormat::I420.frame_size(input_width, input_height)]
        };

        Ok(Self {
            layers: layer_encoders,
            input_format,
            input_width,
            input_height,
            i420_buf,
            backend_name,
            hardware_accelerated,
            packed_mode,
        })
    }

    /// Create a new simulcast encoder.
    ///
    /// `factory` is called once per layer with the appropriate `EncoderConfig`.
    /// The caller decides which concrete encoder backend to use.
    pub fn new<F>(
        input_width: u32,
        input_height: u32,
        input_format: PixelFormat,
        layers: &[SimulcastLayer],
        factory: F,
    ) -> Result<Self, VideoError>
    where
        F: FnMut(EncoderConfig) -> Result<Box<dyn VideoEncoder>, VideoError>,
    {
        let configs = layers
            .iter()
            .copied()
            .map(|layer| {
                (
                    layer,
                    EncoderConfig {
                        pixel_format: PixelFormat::I420,
                        ..EncoderConfig::for_layer(layer, PixelFormat::I420)
                    },
                )
            })
            .collect::<Vec<_>>();
        Self::new_with_configs(input_width, input_height, input_format, &configs, factory)
    }

    /// Encode one input frame across all simulcast layers.
    ///
    /// Returns a `Vec` of encoded frames tagged with their layer.
    pub fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let expected = self
            .input_format
            .frame_size(self.input_width, self.input_height);
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }

        // Packed route (spec §4.1): hand the full packed capture buffer to every
        // layer's GPU encoder — no CPU conversion, no downscale.
        if self.packed_mode {
            return self.encode_packed(pts, data, force_keyframe);
        }

        let needs_i420 = self
            .layers
            .iter()
            .any(|layer| layer.encoder.config().pixel_format == PixelFormat::I420);
        if needs_i420 {
            match self.input_format {
                PixelFormat::I420 => {}
                PixelFormat::Rgba => rgba_to_i420(
                    data,
                    self.input_width,
                    self.input_height,
                    &mut self.i420_buf,
                ),
                PixelFormat::Bgra => bgra_to_i420(
                    data,
                    self.input_width,
                    self.input_height,
                    &mut self.i420_buf,
                ),
            }
        }
        let i420_full = if self.input_format == PixelFormat::I420 {
            data
        } else {
            self.i420_buf.as_slice()
        };

        // Step 2: For each layer, downscale to the layer's configured
        // dimensions and encode.
        let mut results = Vec::new();
        for layer_enc in &mut self.layers {
            let (lw, lh) = (layer_enc.width, layer_enc.height);

            let target_format = layer_enc.encoder.config().pixel_format;
            let scaled_i420;
            let frame_data: &[u8] = if target_format == self.input_format
                && layer_enc.encoder.input_dimensions() == (self.input_width, self.input_height)
            {
                data
            } else if target_format == PixelFormat::I420 {
                if lw == self.input_width && lh == self.input_height {
                    i420_full
                } else {
                    scaled_i420 =
                        downscale_i420(i420_full, self.input_width, self.input_height, lw, lh);
                    &scaled_i420
                }
            } else {
                return Err(VideoError::UnsupportedPixelFormat(target_format));
            };

            let mut encoded = layer_enc.encoder.encode(pts, frame_data, force_keyframe)?;
            // Tag each frame with the layer.
            for frame in &mut encoded {
                frame.layer = Some(layer_enc.layer);
            }
            results.extend(encoded);
        }

        Ok(results)
    }

    /// Packed-input encode (spec §4.1). The full packed capture buffer is routed
    /// to every layer encoder untouched; each one scales and converts to its
    /// output on the GPU (built via `new_with_input(capture → layer)`). There is
    /// deliberately no `bgra_to_i420` and no `downscale_i420` on this path — the
    /// whole point of packed mode is to keep pixel work off the CPU. The
    /// `force_keyframe` request rides to each layer independently, and the top
    /// (last) layer stays the source layer for `set_top_layer_bitrate`.
    fn encode_packed(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let mut results = Vec::new();
        for layer_enc in &mut self.layers {
            let mut encoded = layer_enc.encoder.encode(pts, data, force_keyframe)?;
            for frame in &mut encoded {
                frame.layer = Some(layer_enc.layer);
            }
            results.extend(encoded);
        }
        Ok(results)
    }

    /// Flush all layer encoders.
    pub fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        let mut results = Vec::new();
        for layer_enc in &mut self.layers {
            let mut flushed = layer_enc.encoder.flush()?;
            for frame in &mut flushed {
                frame.layer = Some(layer_enc.layer);
            }
            results.extend(flushed);
        }
        Ok(results)
    }

    pub fn backend_name(&self) -> &'static str {
        self.backend_name
    }

    pub fn is_hardware_accelerated(&self) -> bool {
        self.hardware_accelerated
    }

    pub fn input_format(&self) -> PixelFormat {
        self.input_format
    }

    /// Retarget the highest-quality layer's bitrate mid-stream, if the
    /// backend supports live rate updates. Lower simulcast layers keep their
    /// fixed budgets — congestion response only needs to shrink the layer
    /// that dominates the wire. Returns `Ok(true)` when the rate was applied.
    pub fn set_top_layer_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
        match self.layers.last_mut() {
            Some(layer) => layer.encoder.set_bitrate(bitrate_kbps),
            None => Ok(false),
        }
    }
}

// ── VP9 Encoder (feature-gated) ──────────────────────────────────────

#[cfg(feature = "vpx")]
mod vpx_impl {
    use super::*;
    use std::mem::MaybeUninit;
    use std::os::raw::{c_int, c_ulong};
    use std::ptr;
    use vpx_sys::*;

    /// VP9 video encoder backed by libvpx.
    ///
    /// Accepts I420 frames and produces compressed VP9 bitstream packets.
    pub struct Vp9Encoder {
        ctx: vpx_codec_ctx_t,
        config: EncoderConfig,
        /// The libvpx configuration handed to `vpx_codec_enc_init_ver`, kept
        /// so rate-control fields can be updated live via
        /// `vpx_codec_enc_config_set` (bandwidth adaptation).
        vpx_cfg: vpx_codec_enc_cfg_t,
        frame_count: i64,
    }

    // Safety: The vpx_codec_ctx_t is accessed only through &mut self, so
    // it is safe to send across threads.
    unsafe impl Send for Vp9Encoder {}

    impl Vp9Encoder {
        fn thread_count_for_config(config: &EncoderConfig) -> u32 {
            let available = std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(4);
            let recommended = match config.width.saturating_mul(config.height) {
                pixels if pixels >= 3840 * 2160 => 16,
                pixels if pixels >= 2560 * 1440 => 12,
                pixels if pixels >= 1600 * 900 => 8,
                pixels if pixels >= 1280 * 720 => 6,
                _ => 4,
            };
            // Never claim every core: audio, the UI, and (in self-hosted
            // setups) the server share this machine, and starving them can
            // stall the QUIC connection into a timeout.
            available.saturating_sub(2).clamp(2, recommended)
        }

        fn tile_columns_for_width(width: u32) -> i32 {
            if width >= 3840 {
                3
            } else if width >= 1920 {
                2
            } else if width >= 1280 {
                1
            } else {
                0
            }
        }

        /// Realtime speed presets. Each frame must encode inside the frame
        /// interval (16ms at 60fps) or capture frames get dropped and the
        /// stream judders; saturating every core also starves the rest of the
        /// system (audio, UI, a co-located server). Bitrate — not encoder
        /// effort — is the quality knob for realtime content: measured on a
        /// live 1870x1078@60 stream, cpu_used=4 blew the frame budget while
        /// pinning the CPU. Buckets classify by area with headroom because
        /// portal/window captures land just under canonical sizes.
        fn cpu_used_for_config(config: &EncoderConfig) -> i32 {
            const PIXELS_4K_CLASS: u32 = 3200 * 1800;
            const PIXELS_1440P_CLASS: u32 = 2240 * 1260;
            const PIXELS_1080P_CLASS: u32 = 1600 * 900;
            match config.width.saturating_mul(config.height) {
                pixels if pixels >= PIXELS_4K_CLASS => 9,
                pixels if pixels >= PIXELS_1440P_CLASS => 8,
                pixels if pixels >= PIXELS_1080P_CLASS => 7,
                _ => 6,
            }
        }

        fn quantizer_bounds(config: &EncoderConfig) -> (u32, u32) {
            match config.content_hint {
                VideoContentHint::Detail => (2, 24),
                VideoContentHint::Motion => (2, 28),
                VideoContentHint::Film => (2, 26),
                VideoContentHint::Default => (4, 30),
            }
        }

        fn tune_content(config: &EncoderConfig) -> i32 {
            match config.content_hint {
                VideoContentHint::Detail => vp9e_tune_content::VP9E_CONTENT_SCREEN as i32,
                VideoContentHint::Film => vp9e_tune_content::VP9E_CONTENT_FILM as i32,
                VideoContentHint::Motion | VideoContentHint::Default => {
                    vp9e_tune_content::VP9E_CONTENT_DEFAULT as i32
                }
            }
        }

        /// Create a new VP9 encoder with the given configuration.
        pub fn new(config: EncoderConfig) -> Result<Self, VideoError> {
            config.validate()?;

            if config.pixel_format != PixelFormat::I420 {
                return Err(VideoError::UnsupportedPixelFormat(config.pixel_format));
            }

            unsafe {
                let iface = vpx_codec_vp9_cx();
                if iface.is_null() {
                    return Err(VideoError::EncoderInit(
                        "vpx_codec_vp9_cx returned null".into(),
                    ));
                }

                let mut cfg: vpx_codec_enc_cfg_t = MaybeUninit::zeroed().assume_init();
                let ret = vpx_codec_enc_config_default(iface, &mut cfg, 0);
                if ret != VPX_CODEC_OK {
                    return Err(VideoError::EncoderInit(format!(
                        "vpx_codec_enc_config_default failed: {ret:?}"
                    )));
                }

                cfg.g_w = config.width;
                cfg.g_h = config.height;
                cfg.g_timebase.num = 1;
                cfg.g_timebase.den = config.fps as c_int;
                cfg.rc_target_bitrate = config.bitrate_kbps;
                cfg.g_threads = Self::thread_count_for_config(&config);
                cfg.g_error_resilient = VPX_ERROR_RESILIENT_DEFAULT;
                cfg.g_lag_in_frames = 0; // zero-latency for real-time
                cfg.rc_end_usage = vpx_rc_mode::VPX_CBR; // constant bitrate for real-time
                cfg.rc_buf_sz = 2_000;
                cfg.rc_buf_initial_sz = 1_000;
                cfg.rc_buf_optimal_sz = 1_200;
                cfg.rc_undershoot_pct = 50;
                cfg.rc_overshoot_pct = 50;
                cfg.rc_dropframe_thresh = 0;
                let (min_q, max_q) = Self::quantizer_bounds(&config);
                cfg.rc_min_quantizer = min_q;
                cfg.rc_max_quantizer = max_q;

                if config.keyframe_interval > 0 {
                    cfg.kf_max_dist = config.keyframe_interval;
                    cfg.kf_min_dist = 0;
                }

                let mut ctx: vpx_codec_ctx_t = MaybeUninit::zeroed().assume_init();
                let ret = vpx_codec_enc_init_ver(
                    &mut ctx,
                    iface,
                    &cfg,
                    0,
                    VPX_ENCODER_ABI_VERSION as i32,
                );
                if ret != VPX_CODEC_OK {
                    return Err(VideoError::EncoderInit(format!(
                        "vpx_codec_enc_init_ver failed: {ret:?}"
                    )));
                }

                // Real-time speed setting (higher = faster, lower quality)
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP8E_SET_CPUUSED as _,
                    Self::cpu_used_for_config(&config) as c_int,
                );

                // Enable row-level multi-threading for VP9
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_ROW_MT as _,
                    1 as c_int,
                );

                // Screen-content tuning materially improves text/desktop clarity.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_TUNE_CONTENT as _,
                    Self::tune_content(&config) as c_int,
                );

                // Allow the encoder to split the frame across tiles for better parallelism.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_TILE_COLUMNS as _,
                    Self::tile_columns_for_width(config.width),
                );

                // Adaptive quantization helps preserve detail in screen content.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_AQ_MODE as _,
                    3 as c_int,
                );

                // Signal BT.709 limited range (contract C1): the CPU RGB→I420
                // conversion feeding this encoder now uses 709 coefficients, so
                // the bitstream must carry the matching matrix or receivers
                // dequantize with the wrong one.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_COLOR_SPACE as _,
                    vpx_color_space::VPX_CS_BT_709 as c_int,
                );
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP9E_SET_COLOR_RANGE as _,
                    vpx_color_range::VPX_CR_STUDIO_RANGE as c_int,
                );

                // VP8E_SET_CQ_LEVEL was a no-op here: it only affects the VPX_CQ
                // /constrained-quality end-usage, and this encoder runs VPX_CBR.
                // Removed rather than left as dead configuration.

                // Keep the encoder from suppressing low-motion screen detail too aggressively.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP8E_SET_STATIC_THRESHOLD as _,
                    0 as c_int,
                );

                // Permit larger intra bursts so keyframes stay crisp for text and UI.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP8E_SET_MAX_INTRA_BITRATE_PCT as _,
                    300 as c_int,
                );

                Ok(Self {
                    ctx,
                    config,
                    vpx_cfg: cfg,
                    frame_count: 0,
                })
            }
        }

        fn collect_packets(&mut self) -> Vec<EncodedFrame> {
            let mut frames = Vec::new();
            let mut iter = ptr::null();
            loop {
                let pkt = unsafe { vpx_codec_get_cx_data(&mut self.ctx, &mut iter) };
                if pkt.is_null() {
                    break;
                }
                unsafe {
                    if (*pkt).kind == vpx_codec_cx_pkt_kind::VPX_CODEC_CX_FRAME_PKT {
                        let f = &(*pkt).data.frame;
                        let data =
                            std::slice::from_raw_parts(f.buf as *const u8, f.sz as usize).to_vec();
                        let is_keyframe = (f.flags & VPX_FRAME_IS_KEY) != 0;
                        frames.push(EncodedFrame {
                            data,
                            codec: VideoCodec::Vp9,
                            pts: f.pts,
                            is_keyframe,
                            layer: None,
                            width: self.config.width,
                            height: self.config.height,
                            // Signaled to the encoder via VP9E_SET_COLOR_SPACE.
                            colorspace: ColorSpace::Bt709,
                        });
                    }
                }
            }
            frames
        }
    }

    impl VideoEncoder for Vp9Encoder {
        fn encode(
            &mut self,
            pts: i64,
            data: &[u8],
            force_keyframe: bool,
        ) -> Result<Vec<EncodedFrame>, VideoError> {
            let expected = PixelFormat::I420.frame_size(self.config.width, self.config.height);
            if data.len() != expected {
                return Err(VideoError::FrameSizeMismatch {
                    expected,
                    actual: data.len(),
                });
            }

            let flags = if force_keyframe {
                VPX_EFLAG_FORCE_KF
            } else {
                0
            };

            unsafe {
                let mut image: vpx_image_t = MaybeUninit::zeroed().assume_init();
                let ret = vpx_img_wrap(
                    &mut image,
                    vpx_img_fmt::VPX_IMG_FMT_I420,
                    self.config.width,
                    self.config.height,
                    1,
                    data.as_ptr() as *mut _,
                );
                if ret.is_null() {
                    return Err(VideoError::EncodeFailed("vpx_img_wrap failed".into()));
                }

                let ret = vpx_codec_encode(
                    &mut self.ctx,
                    &image,
                    pts,
                    1,
                    // vpx_enc_frame_flags_t is C `long`: 32-bit on Windows, 64-bit on
                    // Linux/macOS — cast must stay width-agnostic.
                    flags as vpx_enc_frame_flags_t,
                    VPX_DL_REALTIME as _,
                );
                if ret != VPX_CODEC_OK {
                    return Err(VideoError::EncodeFailed(format!(
                        "vpx_codec_encode failed: {ret:?}"
                    )));
                }
            }

            self.frame_count += 1;
            Ok(self.collect_packets())
        }

        fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
            unsafe {
                let ret = vpx_codec_encode(
                    &mut self.ctx,
                    ptr::null(),
                    -1,
                    1,
                    0,
                    VPX_DL_REALTIME as c_ulong,
                );
                if ret != VPX_CODEC_OK {
                    return Err(VideoError::EncodeFailed(format!(
                        "vpx_codec_encode flush failed: {ret:?}"
                    )));
                }
            }
            Ok(self.collect_packets())
        }

        fn config(&self) -> &EncoderConfig {
            &self.config
        }

        fn codec(&self) -> VideoCodec {
            VideoCodec::Vp9
        }

        fn backend_name(&self) -> &'static str {
            "libvpx"
        }

        fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
            let bitrate_kbps = bitrate_kbps.max(1);
            if self.config.bitrate_kbps == bitrate_kbps {
                return Ok(true);
            }

            self.vpx_cfg.rc_target_bitrate = bitrate_kbps;
            let ret = unsafe { vpx_codec_enc_config_set(&mut self.ctx, &self.vpx_cfg) };
            if ret != VPX_CODEC_OK {
                return Err(VideoError::EncodeFailed(format!(
                    "vpx_codec_enc_config_set failed while updating bitrate: {ret:?}"
                )));
            }
            self.config.bitrate_kbps = bitrate_kbps;
            Ok(true)
        }
    }

    impl Drop for Vp9Encoder {
        fn drop(&mut self) {
            unsafe {
                let _ = vpx_codec_destroy(&mut self.ctx);
            }
        }
    }
}

#[cfg(feature = "vpx")]
pub use vpx_impl::Vp9Encoder;

// ── Null Encoder (always available) ──────────────────────────────────

/// A no-op encoder that wraps raw I420 data as "encoded" frames.
///
/// This is useful for:
/// - Testing the pipeline without requiring libvpx.
/// - Development on platforms where libvpx is not installed.
/// - Benchmarking the transport layer without codec overhead.
///
/// The "encoded" data is simply the raw I420 bytes, so it is not actually
/// compressed. The keyframe flag is set on the first frame and at the
/// configured keyframe interval.
pub struct NullEncoder {
    config: EncoderConfig,
    frame_count: u64,
}

impl NullEncoder {
    /// Create a new null encoder.
    pub fn new(config: EncoderConfig) -> Result<Self, VideoError> {
        config.validate()?;
        Ok(Self {
            config,
            frame_count: 0,
        })
    }
}

impl VideoEncoder for NullEncoder {
    fn encode(
        &mut self,
        pts: i64,
        data: &[u8],
        force_keyframe: bool,
    ) -> Result<Vec<EncodedFrame>, VideoError> {
        let expected = self
            .config
            .pixel_format
            .frame_size(self.config.width, self.config.height);
        if data.len() != expected {
            return Err(VideoError::FrameSizeMismatch {
                expected,
                actual: data.len(),
            });
        }

        let kf_interval = if self.config.keyframe_interval > 0 {
            self.config.keyframe_interval as u64
        } else {
            300
        };
        let is_keyframe =
            force_keyframe || self.frame_count == 0 || self.frame_count.is_multiple_of(kf_interval);

        self.frame_count += 1;

        Ok(vec![EncodedFrame {
            data: data.to_vec(),
            codec: VideoCodec::Vp9,
            pts,
            is_keyframe,
            layer: None,
            width: self.config.width,
            height: self.config.height,
            colorspace: ColorSpace::Bt709,
        }])
    }

    fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        // The null encoder does not buffer, so flush is a no-op.
        Ok(Vec::new())
    }

    fn config(&self) -> &EncoderConfig {
        &self.config
    }

    fn codec(&self) -> VideoCodec {
        VideoCodec::Vp9
    }

    fn backend_name(&self) -> &'static str {
        "null"
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::VideoContentHint;

    fn make_test_config(layer: SimulcastLayer) -> EncoderConfig {
        EncoderConfig::for_layer(layer, PixelFormat::I420)
    }

    fn make_i420_frame(width: u32, height: u32, luma: u8) -> Vec<u8> {
        let y_size = (width * height) as usize;
        let uv_size = ((width / 2) * (height / 2)) as usize;
        let mut frame = vec![luma; y_size];
        frame.extend(vec![128u8; uv_size]); // U
        frame.extend(vec![128u8; uv_size]); // V
        frame
    }

    #[test]
    fn null_encoder_basic() {
        let config = make_test_config(SimulcastLayer::Low);
        let (w, h) = (config.width, config.height);
        let mut enc = NullEncoder::new(config).unwrap();

        let frame = make_i420_frame(w, h, 128);
        let encoded = enc.encode(0, &frame, false).unwrap();
        assert_eq!(encoded.len(), 1);
        assert!(encoded[0].is_keyframe, "first frame should be keyframe");
        assert_eq!(encoded[0].data, frame, "null encoder passes data through");
        assert_eq!(encoded[0].width, w);
        assert_eq!(encoded[0].height, h);
    }

    #[test]
    fn null_encoder_keyframe_interval() {
        let config = EncoderConfig {
            keyframe_interval: 5,
            ..make_test_config(SimulcastLayer::Low)
        };
        let (w, h) = (config.width, config.height);
        let mut enc = NullEncoder::new(config).unwrap();
        let frame = make_i420_frame(w, h, 64);

        for i in 0..15 {
            let encoded = enc.encode(i, &frame, false).unwrap();
            let expected_kf = i == 0 || i % 5 == 0;
            assert_eq!(
                encoded[0].is_keyframe, expected_kf,
                "frame {i}: keyframe expected={expected_kf}"
            );
        }
    }

    #[test]
    fn null_encoder_force_keyframe() {
        let config = make_test_config(SimulcastLayer::Medium);
        let (w, h) = (config.width, config.height);
        let mut enc = NullEncoder::new(config).unwrap();
        let frame = make_i420_frame(w, h, 100);

        // First frame is always keyframe
        let _ = enc.encode(0, &frame, false).unwrap();

        // Second frame without force is not a keyframe
        let encoded = enc.encode(1, &frame, false).unwrap();
        assert!(!encoded[0].is_keyframe);

        // Third frame with force is a keyframe
        let encoded = enc.encode(2, &frame, true).unwrap();
        assert!(encoded[0].is_keyframe);
    }

    #[test]
    fn null_encoder_wrong_frame_size() {
        let config = make_test_config(SimulcastLayer::Low);
        let mut enc = NullEncoder::new(config).unwrap();

        let bad_frame = vec![0u8; 100];
        let result = enc.encode(0, &bad_frame, false);
        assert!(result.is_err());
    }

    #[test]
    fn null_encoder_flush() {
        let config = make_test_config(SimulcastLayer::Low);
        let mut enc = NullEncoder::new(config).unwrap();

        let flushed = enc.flush().unwrap();
        assert!(flushed.is_empty(), "null encoder has nothing to flush");
    }

    #[test]
    fn null_encoder_invalid_config() {
        let config = EncoderConfig {
            width: 321, // odd width
            height: 180,
            fps: 30,
            bitrate_kbps: 500,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        };
        assert!(NullEncoder::new(config).is_err());
    }

    #[test]
    fn simulcast_encoder_basic() {
        let layers = [SimulcastLayer::Low, SimulcastLayer::Medium];
        let input_w = 640u32;
        let input_h = 360u32;

        let mut sim = SimulcastEncoder::new(input_w, input_h, PixelFormat::I420, &layers, |cfg| {
            Ok(Box::new(NullEncoder::new(cfg)?))
        })
        .unwrap();

        let frame = make_i420_frame(input_w, input_h, 128);
        let encoded = sim.encode(0, &frame, false).unwrap();

        // Should get one frame per layer
        assert_eq!(encoded.len(), 2);
        assert_eq!(encoded[0].layer, Some(SimulcastLayer::Low));
        assert_eq!(encoded[1].layer, Some(SimulcastLayer::Medium));
        assert_eq!(encoded[0].width, 320);
        assert_eq!(encoded[0].height, 180);
        assert_eq!(encoded[1].width, 640);
        assert_eq!(encoded[1].height, 360);
    }

    #[test]
    fn simulcast_layers_use_config_dimensions_not_presets() {
        // Regression: layer configs are aspect-fitted to the real capture
        // (here 2:1, e.g. an ultrawide/portal window), so they differ from
        // SimulcastLayer::resolution() presets. Downscaling must target the
        // config dimensions or the per-layer encoders reject the frame.
        let input_w = 960u32;
        let input_h = 480u32;
        let configs = [
            (
                SimulcastLayer::Low,
                EncoderConfig {
                    width: 240, // fitted 2:1, not the 320x180 preset
                    height: 120,
                    fps: 15,
                    bitrate_kbps: 300,
                    pixel_format: PixelFormat::I420,
                    keyframe_interval: 15,
                    content_hint: VideoContentHint::Default,
                },
            ),
            (
                SimulcastLayer::High,
                EncoderConfig {
                    width: input_w,
                    height: input_h,
                    fps: 30,
                    bitrate_kbps: 2_000,
                    pixel_format: PixelFormat::I420,
                    keyframe_interval: 30,
                    content_hint: VideoContentHint::Default,
                },
            ),
        ];

        let mut sim = SimulcastEncoder::new_with_configs(
            input_w,
            input_h,
            PixelFormat::I420,
            &configs,
            |cfg| Ok(Box::new(NullEncoder::new(cfg)?)),
        )
        .unwrap();

        let frame = make_i420_frame(input_w, input_h, 128);
        let encoded = sim.encode(0, &frame, false).unwrap();

        assert_eq!(encoded.len(), 2);
        assert_eq!(encoded[0].layer, Some(SimulcastLayer::Low));
        assert_eq!(encoded[0].width, 240);
        assert_eq!(encoded[0].height, 120);
        assert_eq!(encoded[1].layer, Some(SimulcastLayer::High));
        assert_eq!(encoded[1].width, input_w);
        assert_eq!(encoded[1].height, input_h);
    }

    #[test]
    fn simulcast_encoder_rgba_input() {
        let layers = [SimulcastLayer::Low];
        let input_w = 320u32;
        let input_h = 180u32;

        let mut sim = SimulcastEncoder::new(input_w, input_h, PixelFormat::Rgba, &layers, |cfg| {
            Ok(Box::new(NullEncoder::new(cfg)?))
        })
        .unwrap();

        // Create an RGBA frame
        let frame = vec![128u8; (input_w * input_h * 4) as usize];
        let encoded = sim.encode(0, &frame, false).unwrap();

        assert_eq!(encoded.len(), 1);
        assert_eq!(encoded[0].layer, Some(SimulcastLayer::Low));
        // The output should be I420 sized, not RGBA sized
        let expected_i420_size = PixelFormat::I420.frame_size(input_w, input_h);
        assert_eq!(encoded[0].data.len(), expected_i420_size);
    }

    #[test]
    fn simulcast_encoder_wrong_input_size() {
        let layers = [SimulcastLayer::Low];
        let input_w = 320u32;
        let input_h = 180u32;

        let mut sim = SimulcastEncoder::new(input_w, input_h, PixelFormat::I420, &layers, |cfg| {
            Ok(Box::new(NullEncoder::new(cfg)?))
        })
        .unwrap();

        let bad = vec![0u8; 100];
        assert!(sim.encode(0, &bad, false).is_err());
    }

    #[test]
    fn simulcast_encoder_flush() {
        let layers = [SimulcastLayer::Low, SimulcastLayer::High];
        let input_w = 1280u32;
        let input_h = 720u32;

        let mut sim = SimulcastEncoder::new(input_w, input_h, PixelFormat::I420, &layers, |cfg| {
            Ok(Box::new(NullEncoder::new(cfg)?))
        })
        .unwrap();

        let flushed = sim.flush().unwrap();
        assert!(flushed.is_empty());
    }

    #[test]
    fn simulcast_all_layers() {
        let layers = SimulcastLayer::all();
        let input_w = 1280u32;
        let input_h = 720u32;

        let mut sim = SimulcastEncoder::new(input_w, input_h, PixelFormat::I420, layers, |cfg| {
            Ok(Box::new(NullEncoder::new(cfg)?))
        })
        .unwrap();

        let frame = make_i420_frame(input_w, input_h, 100);
        let encoded = sim.encode(0, &frame, true).unwrap();

        assert_eq!(encoded.len(), 3);
        assert_eq!(encoded[0].layer, Some(SimulcastLayer::Low));
        assert_eq!(encoded[1].layer, Some(SimulcastLayer::Medium));
        assert_eq!(encoded[2].layer, Some(SimulcastLayer::High));

        // All should be keyframes because we passed force_keyframe=true
        for f in &encoded {
            assert!(f.is_keyframe, "force_keyframe should propagate");
        }
    }

    // ── Packed-mode (hardware simulcast) tests ───────────────────────

    use std::sync::{Arc, Mutex};

    /// What a [`MockEncoder`] recorded, shared so a test can inspect each layer
    /// encoder after construction moved it into the `SimulcastEncoder`.
    #[derive(Debug, Default)]
    struct MockLog {
        /// One entry per `encode` call: `(pts, input_len, force_keyframe)`.
        encodes: Vec<(i64, usize, bool)>,
        /// Bitrates passed to `set_bitrate`.
        set_bitrate: Vec<u32>,
    }

    /// A configurable in-memory encoder that records how the `SimulcastEncoder`
    /// drives it. `input_w`/`input_h` are the dims it *accepts* (the capture
    /// dims in packed mode); it validates each frame against them so a wrong
    /// downscale/conversion would surface as a size mismatch.
    struct MockEncoder {
        config: EncoderConfig,
        input_w: u32,
        input_h: u32,
        hardware: bool,
        log: Arc<Mutex<MockLog>>,
    }

    impl VideoEncoder for MockEncoder {
        fn encode(
            &mut self,
            pts: i64,
            data: &[u8],
            force_keyframe: bool,
        ) -> Result<Vec<EncodedFrame>, VideoError> {
            let expected = self
                .config
                .pixel_format
                .frame_size(self.input_w, self.input_h);
            if data.len() != expected {
                return Err(VideoError::FrameSizeMismatch {
                    expected,
                    actual: data.len(),
                });
            }
            self.log
                .lock()
                .unwrap()
                .encodes
                .push((pts, data.len(), force_keyframe));
            Ok(vec![EncodedFrame {
                data: Vec::new(),
                codec: VideoCodec::H264,
                pts,
                is_keyframe: force_keyframe,
                layer: None,
                width: self.config.width,
                height: self.config.height,
                colorspace: ColorSpace::Bt709,
            }])
        }

        fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
            Ok(Vec::new())
        }

        fn config(&self) -> &EncoderConfig {
            &self.config
        }

        fn codec(&self) -> VideoCodec {
            VideoCodec::H264
        }

        fn backend_name(&self) -> &'static str {
            "mock-hw"
        }

        fn is_hardware_accelerated(&self) -> bool {
            self.hardware
        }

        fn input_dimensions(&self) -> (u32, u32) {
            (self.input_w, self.input_h)
        }

        fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<bool, VideoError> {
            self.log.lock().unwrap().set_bitrate.push(bitrate_kbps);
            Ok(true)
        }
    }

    fn packed_config(width: u32, height: u32) -> EncoderConfig {
        EncoderConfig {
            width,
            height,
            fps: 30,
            bitrate_kbps: 1_000,
            pixel_format: PixelFormat::Bgra,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        }
    }

    /// A built mock simulcast encoder plus each layer's shared log, in order.
    type MockSimulcast = (SimulcastEncoder, Vec<Arc<Mutex<MockLog>>>);

    /// Build an all-hardware packed simulcast encoder over the given layer
    /// output configs, returning the encoder plus each layer's shared log (in
    /// layer order). `hw_pattern` sets each layer's `is_hardware_accelerated`.
    fn build_mock_simulcast(
        input_w: u32,
        input_h: u32,
        input_format: PixelFormat,
        configs: &[(SimulcastLayer, EncoderConfig)],
        hw_pattern: &[bool],
    ) -> Result<MockSimulcast, VideoError> {
        let logs: Arc<Mutex<Vec<Arc<Mutex<MockLog>>>>> = Arc::new(Mutex::new(Vec::new()));
        let hw_pattern = hw_pattern.to_vec();
        let logs_factory = logs.clone();
        let mut index = 0usize;
        let enc =
            SimulcastEncoder::new_with_configs(input_w, input_h, input_format, configs, |cfg| {
                let hardware = hw_pattern[index];
                index += 1;
                let log = Arc::new(Mutex::new(MockLog::default()));
                logs_factory.lock().unwrap().push(log.clone());
                Ok(Box::new(MockEncoder {
                    config: cfg,
                    input_w,
                    input_h,
                    hardware,
                    log,
                }))
            })?;
        // Clone the per-layer log handles out (cheap Arc clones); the factory
        // closure still borrows its own clone of the outer Vec at this point.
        let logs = logs.lock().unwrap().clone();
        Ok((enc, logs))
    }

    #[test]
    fn packed_mode_routes_full_buffer_to_every_layer() {
        let (input_w, input_h) = (1920u32, 1080u32);
        let configs = [
            (SimulcastLayer::Low, packed_config(640, 360)),
            (SimulcastLayer::Medium, packed_config(1280, 720)),
            (SimulcastLayer::High, packed_config(1920, 1080)),
        ];
        let (mut sim, logs) = build_mock_simulcast(
            input_w,
            input_h,
            PixelFormat::Bgra,
            &configs,
            &[true, true, true],
        )
        .unwrap();
        assert!(sim.is_hardware_accelerated());

        let full = PixelFormat::Bgra.frame_size(input_w, input_h);
        let packed = vec![7u8; full];
        let encoded = sim.encode(42, &packed, true).unwrap();

        // One tagged frame per layer, in order.
        assert_eq!(encoded.len(), 3);
        assert_eq!(encoded[0].layer, Some(SimulcastLayer::Low));
        assert_eq!(encoded[1].layer, Some(SimulcastLayer::Medium));
        assert_eq!(encoded[2].layer, Some(SimulcastLayer::High));

        // Every layer received the FULL packed capture buffer — no downscale,
        // no CPU conversion — at the same pts.
        assert_eq!(logs.len(), 3);
        for log in &logs {
            let l = log.lock().unwrap();
            assert_eq!(l.encodes, vec![(42, full, true)]);
        }
    }

    #[test]
    fn packed_mode_mixed_hardware_software_is_construction_error() {
        let configs = [
            (SimulcastLayer::Low, packed_config(640, 360)),
            (SimulcastLayer::High, packed_config(1280, 720)),
        ];
        // First layer hardware, second software → no correct route.
        let result = build_mock_simulcast(1280, 720, PixelFormat::Bgra, &configs, &[true, false]);
        assert!(
            matches!(result, Err(VideoError::EncoderInit(_))),
            "mixed hw/sw layer set must be a construction error"
        );
    }

    #[test]
    fn packed_mode_force_keyframe_flags_reach_each_layer_independently() {
        let (input_w, input_h) = (1280u32, 720u32);
        let configs = [
            (SimulcastLayer::Low, packed_config(640, 360)),
            (SimulcastLayer::High, packed_config(1280, 720)),
        ];
        let (mut sim, logs) =
            build_mock_simulcast(input_w, input_h, PixelFormat::Bgra, &configs, &[true, true])
                .unwrap();

        let full = PixelFormat::Bgra.frame_size(input_w, input_h);
        let packed = vec![0u8; full];
        sim.encode(0, &packed, true).unwrap();
        sim.encode(1, &packed, false).unwrap();
        sim.encode(2, &packed, true).unwrap();

        // Each layer independently saw the exact force flags per frame.
        for log in &logs {
            let l = log.lock().unwrap();
            assert_eq!(
                l.encodes,
                vec![(0, full, true), (1, full, false), (2, full, true)]
            );
        }
    }

    #[test]
    fn packed_mode_set_top_layer_bitrate_retargets_only_source_layer() {
        let configs = [
            (SimulcastLayer::Low, packed_config(640, 360)),
            (SimulcastLayer::Medium, packed_config(1280, 720)),
            (SimulcastLayer::High, packed_config(1920, 1080)),
        ];
        let (mut sim, logs) =
            build_mock_simulcast(1920, 1080, PixelFormat::Bgra, &configs, &[true, true, true])
                .unwrap();

        let applied = sim.set_top_layer_bitrate(4_321).unwrap();
        assert!(applied);

        // Only the top (last = source) layer was retargeted.
        assert!(logs[0].lock().unwrap().set_bitrate.is_empty());
        assert!(logs[1].lock().unwrap().set_bitrate.is_empty());
        assert_eq!(logs[2].lock().unwrap().set_bitrate, vec![4_321]);
    }

    #[test]
    fn packed_input_with_software_layer_stays_on_i420_floor() {
        // Packed input but a software encoder → NOT packed mode; the CPU floor
        // converts RGBA→I420 as before (route fixed at construction).
        let (input_w, input_h) = (320u32, 180u32);
        let mut sim = SimulcastEncoder::new(
            input_w,
            input_h,
            PixelFormat::Rgba,
            &[SimulcastLayer::Low],
            |cfg| Ok(Box::new(NullEncoder::new(cfg)?)),
        )
        .unwrap();
        assert!(!sim.is_hardware_accelerated());
        let frame = vec![128u8; (input_w * input_h * 4) as usize];
        let encoded = sim.encode(0, &frame, false).unwrap();
        assert_eq!(encoded.len(), 1);
        // Output is I420-sized (converted), proving the packed route was NOT taken.
        assert_eq!(
            encoded[0].data.len(),
            PixelFormat::I420.frame_size(input_w, input_h)
        );
    }
}
