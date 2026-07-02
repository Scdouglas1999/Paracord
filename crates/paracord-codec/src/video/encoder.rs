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
    downscale_i420, rgba_to_i420, EncodedFrame, EncoderConfig, PixelFormat, SimulcastLayer,
    VideoCodec, VideoError,
};

#[cfg(target_os = "windows")]
mod windows_h264;
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
        #[cfg(not(target_os = "windows"))]
        VideoCodec::Av1 => Err(VideoError::CodecUnavailable(
            "av1 encoder backend not implemented on this platform yet".into(),
        )),
        #[cfg(target_os = "windows")]
        VideoCodec::H264 => Ok(Box::new(MfH264Encoder::new(config)?)),
        #[cfg(not(target_os = "windows"))]
        VideoCodec::H264 => Err(VideoError::CodecUnavailable(
            "h264 encoder backend not implemented on this platform yet".into(),
        )),
    }
}

// ── SimulcastEncoder ─────────────────────────────────────────────────

/// Manages multiple [`VideoEncoder`] instances, one per simulcast layer.
///
/// Accepts a full-resolution frame, downscales it to each layer's resolution,
/// and encodes all layers in parallel (sequentially for now; parallel encoding
/// can be added later with `rayon` or `tokio::task::spawn_blocking`).
pub struct SimulcastEncoder {
    /// (layer, encoder) pairs ordered from lowest to highest quality.
    layers: Vec<(SimulcastLayer, Box<dyn VideoEncoder>)>,
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
        let mut hardware_accelerated = false;
        for (layer, config) in layers {
            let config = EncoderConfig {
                pixel_format: PixelFormat::I420,
                ..config.clone()
            };
            config.validate()?;
            let enc = factory(config)?;
            if layer_encoders.is_empty() {
                backend_name = enc.backend_name();
                hardware_accelerated = enc.is_hardware_accelerated();
            }
            layer_encoders.push((*layer, enc));
        }

        let i420_size = PixelFormat::I420.frame_size(input_width, input_height);

        Ok(Self {
            layers: layer_encoders,
            input_format,
            input_width,
            input_height,
            i420_buf: vec![0u8; i420_size],
            backend_name,
            hardware_accelerated,
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
        // Step 1: Ensure we have I420 data at the input resolution.
        let i420_full = match self.input_format {
            PixelFormat::I420 => {
                let expected = PixelFormat::I420.frame_size(self.input_width, self.input_height);
                if data.len() != expected {
                    return Err(VideoError::FrameSizeMismatch {
                        expected,
                        actual: data.len(),
                    });
                }
                data
            }
            PixelFormat::Rgba => {
                let expected = PixelFormat::Rgba.frame_size(self.input_width, self.input_height);
                if data.len() != expected {
                    return Err(VideoError::FrameSizeMismatch {
                        expected,
                        actual: data.len(),
                    });
                }
                rgba_to_i420(
                    data,
                    self.input_width,
                    self.input_height,
                    &mut self.i420_buf,
                );
                &self.i420_buf
            }
        };

        // Step 2: For each layer, downscale and encode.
        let mut results = Vec::new();
        for (layer, encoder) in &mut self.layers {
            let (lw, lh) = layer.resolution();

            let frame_data = if lw == self.input_width && lh == self.input_height {
                // No downscaling needed.
                i420_full.to_vec()
            } else {
                downscale_i420(i420_full, self.input_width, self.input_height, lw, lh)
            };

            let mut encoded = encoder.encode(pts, &frame_data, force_keyframe)?;
            // Tag each frame with the layer.
            for frame in &mut encoded {
                frame.layer = Some(*layer);
            }
            results.extend(encoded);
        }

        Ok(results)
    }

    /// Flush all layer encoders.
    pub fn flush(&mut self) -> Result<Vec<EncodedFrame>, VideoError> {
        let mut results = Vec::new();
        for (layer, encoder) in &mut self.layers {
            let mut flushed = encoder.flush()?;
            for frame in &mut flushed {
                frame.layer = Some(*layer);
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
                pixels if pixels >= 1920 * 1080 => 8,
                pixels if pixels >= 1280 * 720 => 6,
                _ => 4,
            };
            available.min(recommended).max(2)
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

        fn cpu_used_for_config(config: &EncoderConfig) -> i32 {
            match config.content_hint {
                VideoContentHint::Motion | VideoContentHint::Film => {
                    match config.width.saturating_mul(config.height) {
                        pixels if pixels >= 3840 * 2160 => 8,
                        pixels if pixels >= 2560 * 1440 => 7,
                        pixels if pixels >= 1920 * 1080 => 6,
                        _ => 5,
                    }
                }
                VideoContentHint::Detail => match config.width.saturating_mul(config.height) {
                    pixels if pixels >= 2560 * 1440 => 7,
                    pixels if pixels >= 1920 * 1080 => 6,
                    _ => 5,
                },
                VideoContentHint::Default => match config.width.saturating_mul(config.height) {
                    pixels if pixels >= 3840 * 2160 => 8,
                    pixels if pixels >= 1920 * 1080 => 7,
                    _ => 6,
                },
            }
        }

        fn quantizer_bounds(config: &EncoderConfig) -> (u32, u32) {
            match config.content_hint {
                VideoContentHint::Detail => (4, 28),
                VideoContentHint::Motion => (4, 32),
                VideoContentHint::Film => (4, 36),
                VideoContentHint::Default => (4, 34),
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

                // Constrained quality helps retain more detail within the bitrate budget.
                let _ = vpx_codec_control_(
                    &mut ctx,
                    vp8e_enc_control_id::VP8E_SET_CQ_LEVEL as _,
                    Self::quantizer_bounds(&config).1 as c_int,
                );

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
}
