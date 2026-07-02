//! Video decoder for received VP9 streams.
//!
//! This module defines the [`VideoDecoder`] trait and provides two
//! implementations:
//!
//! - [`Vp9Decoder`] (requires the `vpx` feature) — decodes VP9 bitstream
//!   via libvpx into raw I420 frames.
//! - [`NullDecoder`] — a zero-dependency stub that treats incoming bytes as
//!   raw I420 data. Useful for testing or platforms without libvpx.
//!
//! Each remote video stream gets its own decoder instance to maintain
//! independent codec state.

use super::{DecodedFrame, DecoderConfig, EncodedFrame, VideoCodec, VideoError};

#[cfg(feature = "vpx")]
use super::PixelFormat;

// ── VideoDecoder trait ───────────────────────────────────────────────

/// Trait for video decoders.
///
/// One decoder instance should be created per remote video stream, since VP9
/// decoder state is per-stream (reference frames, etc.).
pub trait VideoDecoder: Send {
    /// Decode an encoded frame into raw pixel data.
    ///
    /// Returns zero or more decoded frames. Some codecs may internally
    /// buffer frames and return them out of order or in batches.
    fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError>;

    /// Signal that a keyframe is needed from the remote sender.
    ///
    /// The decoder itself cannot force a keyframe — this flag should be
    /// checked by the transport layer and forwarded as a keyframe request
    /// to the remote encoder.
    fn needs_keyframe(&self) -> bool;

    /// Clear the keyframe-needed flag after a request has been sent.
    fn clear_keyframe_request(&mut self);

    /// Reset the decoder state.
    ///
    /// Call this when switching streams or recovering from severe corruption.
    fn reset(&mut self) -> Result<(), VideoError>;

    /// Return the decoder configuration.
    fn config(&self) -> &DecoderConfig;
}

pub fn create_decoder(
    codec: VideoCodec,
    _config: DecoderConfig,
) -> Result<Box<dyn VideoDecoder>, VideoError> {
    match codec {
        #[cfg(feature = "vpx")]
        VideoCodec::Vp9 => Ok(Box::new(Vp9Decoder::new(_config)?)),
        #[cfg(not(feature = "vpx"))]
        VideoCodec::Vp9 => Err(VideoError::CodecUnavailable(
            "vp9 decoder unavailable without 'vpx' feature".into(),
        )),
        VideoCodec::Av1 => Err(VideoError::CodecUnavailable(
            "av1 decoder backend not implemented yet".into(),
        )),
        VideoCodec::H264 => Err(VideoError::CodecUnavailable(
            "h264 decoder backend not implemented yet".into(),
        )),
    }
}

// ── VP9 Decoder (feature-gated) ──────────────────────────────────────

#[cfg(feature = "vpx")]
mod vpx_impl {
    use super::*;
    use std::mem::MaybeUninit;
    use std::ptr;
    use vpx_sys::*;

    /// VP9 video decoder backed by libvpx.
    ///
    /// Decodes compressed VP9 packets into raw I420 frames.
    pub struct Vp9Decoder {
        ctx: vpx_codec_ctx_t,
        config: DecoderConfig,
        needs_keyframe: bool,
        initialized: bool,
    }

    // Safety: vpx_codec_ctx_t is only accessed via &mut self.
    unsafe impl Send for Vp9Decoder {}

    impl Vp9Decoder {
        /// Create a new VP9 decoder.
        pub fn new(config: DecoderConfig) -> Result<Self, VideoError> {
            let mut dec = Self {
                ctx: unsafe { MaybeUninit::zeroed().assume_init() },
                config,
                needs_keyframe: true, // need a keyframe to start
                initialized: false,
            };
            dec.init_context()?;
            Ok(dec)
        }

        fn init_context(&mut self) -> Result<(), VideoError> {
            unsafe {
                let iface = vpx_codec_vp9_dx();
                if iface.is_null() {
                    return Err(VideoError::DecoderInit(
                        "vpx_codec_vp9_dx returned null".into(),
                    ));
                }

                let mut cfg: vpx_codec_dec_cfg_t = MaybeUninit::zeroed().assume_init();
                cfg.threads = 4;

                let ret = vpx_codec_dec_init_ver(
                    &mut self.ctx,
                    iface,
                    &cfg,
                    0,
                    VPX_DECODER_ABI_VERSION as i32,
                );
                if ret != VPX_CODEC_OK {
                    return Err(VideoError::DecoderInit(format!(
                        "vpx_codec_dec_init_ver failed: {ret:?}"
                    )));
                }

                self.initialized = true;
            }
            Ok(())
        }
    }

    impl VideoDecoder for Vp9Decoder {
        fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError> {
            if !self.initialized {
                return Err(VideoError::DecoderInit("decoder not initialized".into()));
            }

            // If we need a keyframe and this isn't one, skip it.
            if self.needs_keyframe && !frame.is_keyframe {
                return Err(VideoError::KeyframeRequired);
            }

            // We got a keyframe (or didn't need one), clear the flag.
            if frame.is_keyframe {
                self.needs_keyframe = false;
            }

            unsafe {
                let ret = vpx_codec_decode(
                    &mut self.ctx,
                    frame.data.as_ptr(),
                    frame.data.len() as u32,
                    ptr::null_mut(),
                    0,
                );
                if ret != VPX_CODEC_OK {
                    // Decode failure — request a keyframe to recover.
                    self.needs_keyframe = true;
                    return Err(VideoError::DecodeFailed(format!(
                        "vpx_codec_decode failed: {ret:?}"
                    )));
                }

                let mut iter = ptr::null();
                let mut decoded_frames = Vec::new();

                loop {
                    let img = vpx_codec_get_frame(&mut self.ctx, &mut iter);
                    if img.is_null() {
                        break;
                    }

                    let img = &*img;
                    let w = img.d_w;
                    let h = img.d_h;

                    // Extract I420 planes
                    let y_stride = img.stride[0] as usize;
                    let u_stride = img.stride[1] as usize;
                    let v_stride = img.stride[2] as usize;
                    let y_ptr = img.planes[0];
                    let u_ptr = img.planes[1];
                    let v_ptr = img.planes[2];

                    let y_size = (w * h) as usize;
                    let uv_w = (w / 2) as usize;
                    let uv_h = (h / 2) as usize;
                    let uv_size = uv_w * uv_h;

                    let mut data = Vec::with_capacity(y_size + 2 * uv_size);

                    // Copy Y plane (handle stride != width)
                    for row in 0..h as usize {
                        let src = std::slice::from_raw_parts(y_ptr.add(row * y_stride), w as usize);
                        data.extend_from_slice(src);
                    }

                    // Copy U plane
                    for row in 0..uv_h {
                        let src = std::slice::from_raw_parts(u_ptr.add(row * u_stride), uv_w);
                        data.extend_from_slice(src);
                    }

                    // Copy V plane
                    for row in 0..uv_h {
                        let src = std::slice::from_raw_parts(v_ptr.add(row * v_stride), uv_w);
                        data.extend_from_slice(src);
                    }

                    decoded_frames.push(DecodedFrame {
                        data,
                        pixel_format: PixelFormat::I420,
                        width: w,
                        height: h,
                        pts: frame.pts,
                    });
                }

                Ok(decoded_frames)
            }
        }

        fn needs_keyframe(&self) -> bool {
            self.needs_keyframe
        }

        fn clear_keyframe_request(&mut self) {
            self.needs_keyframe = false;
        }

        fn reset(&mut self) -> Result<(), VideoError> {
            if self.initialized {
                unsafe {
                    let _ = vpx_codec_destroy(&mut self.ctx);
                }
                self.initialized = false;
            }
            self.needs_keyframe = true;
            self.init_context()
        }

        fn config(&self) -> &DecoderConfig {
            &self.config
        }
    }

    impl Drop for Vp9Decoder {
        fn drop(&mut self) {
            if self.initialized {
                unsafe {
                    let _ = vpx_codec_destroy(&mut self.ctx);
                }
            }
        }
    }
}

#[cfg(feature = "vpx")]
pub use vpx_impl::Vp9Decoder;

// ── Null Decoder (always available) ──────────────────────────────────

/// A no-op decoder that treats encoded data as raw I420 frames.
///
/// Pairs with [`NullEncoder`](super::encoder::NullEncoder) for testing.
/// The "decoding" is simply passing the bytes through.
pub struct NullDecoder {
    config: DecoderConfig,
    needs_keyframe: bool,
    received_keyframe: bool,
}

impl NullDecoder {
    /// Create a new null decoder.
    pub fn new(config: DecoderConfig) -> Result<Self, VideoError> {
        Ok(Self {
            config,
            needs_keyframe: true,
            received_keyframe: false,
        })
    }
}

impl VideoDecoder for NullDecoder {
    fn decode(&mut self, frame: &EncodedFrame) -> Result<Vec<DecodedFrame>, VideoError> {
        // Require the first frame to be a keyframe, just like a real decoder.
        if self.needs_keyframe && !frame.is_keyframe {
            return Err(VideoError::KeyframeRequired);
        }

        if frame.is_keyframe {
            self.needs_keyframe = false;
            self.received_keyframe = true;
        }

        Ok(vec![DecodedFrame {
            data: frame.data.clone(),
            pixel_format: self.config.pixel_format,
            width: frame.width,
            height: frame.height,
            pts: frame.pts,
        }])
    }

    fn needs_keyframe(&self) -> bool {
        self.needs_keyframe
    }

    fn clear_keyframe_request(&mut self) {
        self.needs_keyframe = false;
    }

    fn reset(&mut self) -> Result<(), VideoError> {
        self.needs_keyframe = true;
        self.received_keyframe = false;
        Ok(())
    }

    fn config(&self) -> &DecoderConfig {
        &self.config
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::encoder::{NullEncoder, VideoEncoder};
    use crate::video::{EncoderConfig, PixelFormat, SimulcastLayer, VideoCodec};

    fn make_i420_frame(width: u32, height: u32, luma: u8) -> Vec<u8> {
        let y_size = (width * height) as usize;
        let uv_size = ((width / 2) * (height / 2)) as usize;
        let mut frame = vec![luma; y_size];
        frame.extend(vec![128u8; uv_size]); // U
        frame.extend(vec![128u8; uv_size]); // V
        frame
    }

    #[test]
    fn null_decoder_requires_keyframe_first() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        // Non-keyframe should be rejected when we haven't received a keyframe yet.
        let non_kf = EncodedFrame {
            data: vec![0u8; 32],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: false,
            layer: None,
            width: 320,
            height: 180,
        };
        assert!(dec.decode(&non_kf).is_err());
        assert!(dec.needs_keyframe());
    }

    #[test]
    fn null_decoder_accepts_keyframe() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        let kf = EncodedFrame {
            data: vec![42u8; 64],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: true,
            layer: None,
            width: 4,
            height: 4,
        };
        let decoded = dec.decode(&kf).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].data, vec![42u8; 64]);
        assert_eq!(decoded[0].width, 4);
        assert_eq!(decoded[0].height, 4);
        assert!(!dec.needs_keyframe());
    }

    #[test]
    fn null_decoder_accepts_subsequent_non_keyframes() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        // First: keyframe
        let kf = EncodedFrame {
            data: vec![1u8; 16],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: true,
            layer: None,
            width: 4,
            height: 2,
        };
        dec.decode(&kf).unwrap();

        // Second: non-keyframe should now work
        let non_kf = EncodedFrame {
            data: vec![2u8; 16],
            codec: VideoCodec::Vp9,
            pts: 1,
            is_keyframe: false,
            layer: None,
            width: 4,
            height: 2,
        };
        let decoded = dec.decode(&non_kf).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].data, vec![2u8; 16]);
    }

    #[test]
    fn null_decoder_reset() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        // Feed a keyframe
        let kf = EncodedFrame {
            data: vec![0u8; 8],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: true,
            layer: None,
            width: 2,
            height: 2,
        };
        dec.decode(&kf).unwrap();
        assert!(!dec.needs_keyframe());

        // Reset
        dec.reset().unwrap();
        assert!(dec.needs_keyframe(), "reset should require keyframe again");

        // Non-keyframe should fail again
        let non_kf = EncodedFrame {
            data: vec![0u8; 8],
            codec: VideoCodec::Vp9,
            pts: 1,
            is_keyframe: false,
            layer: None,
            width: 2,
            height: 2,
        };
        assert!(dec.decode(&non_kf).is_err());
    }

    #[test]
    fn null_encoder_decoder_round_trip() {
        let layer = SimulcastLayer::Low;
        let config = EncoderConfig::for_layer(layer, PixelFormat::I420);
        let (w, h) = (config.width, config.height);

        let mut encoder = NullEncoder::new(config).unwrap();
        let mut decoder = NullDecoder::new(DecoderConfig::default()).unwrap();

        let original = make_i420_frame(w, h, 200);

        // Encode
        let encoded = encoder.encode(0, &original, false).unwrap();
        assert_eq!(encoded.len(), 1);

        // Decode
        let decoded = decoder.decode(&encoded[0]).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(
            decoded[0].data, original,
            "null round-trip should be lossless"
        );
        assert_eq!(decoded[0].width, w);
        assert_eq!(decoded[0].height, h);
        assert_eq!(decoded[0].pts, 0);
    }

    #[test]
    fn null_decoder_clear_keyframe_request() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        assert!(dec.needs_keyframe());
        dec.clear_keyframe_request();
        assert!(!dec.needs_keyframe());
    }

    #[test]
    fn null_decoder_multiple_frames_in_sequence() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        let (w, h) = (8u32, 4u32);
        let i420_size = PixelFormat::I420.frame_size(w, h);

        // Keyframe first
        let kf = EncodedFrame {
            data: vec![100u8; i420_size],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: true,
            layer: None,
            width: w,
            height: h,
        };
        let decoded = dec.decode(&kf).unwrap();
        assert_eq!(decoded.len(), 1);

        // Ten more non-keyframes
        for i in 1..=10 {
            let f = EncodedFrame {
                data: vec![(100 + i) as u8; i420_size],
                codec: VideoCodec::Vp9,
                pts: i as i64,
                is_keyframe: false,
                layer: None,
                width: w,
                height: h,
            };
            let decoded = dec.decode(&f).unwrap();
            assert_eq!(decoded.len(), 1);
            assert_eq!(decoded[0].pts, i as i64);
        }
    }

    #[test]
    fn null_decoder_preserves_layer_metadata() {
        let config = DecoderConfig::default();
        let mut dec = NullDecoder::new(config).unwrap();

        let f = EncodedFrame {
            data: vec![0u8; 16],
            codec: VideoCodec::Vp9,
            pts: 42,
            is_keyframe: true,
            layer: Some(SimulcastLayer::High),
            width: 4,
            height: 2,
        };
        let decoded = dec.decode(&f).unwrap();
        assert_eq!(decoded[0].pts, 42);
    }
}
