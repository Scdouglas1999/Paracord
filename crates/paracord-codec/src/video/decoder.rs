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

use super::handle::DecodedFrameHandle;
use super::{DecodedFrame, DecoderConfig, EncodedFrame, VideoCodec, VideoError};

#[cfg(feature = "vpx")]
use super::PixelFormat;

// ── Decode output mode ───────────────────────────────────────────────

/// Where a decoder places its output, chosen once at construction (spec §3.2).
///
/// This is fixed for the decoder's life — there is no per-frame or runtime
/// switching. A [`Gpu`](DecodeOutput::Gpu)-mode decoder that cannot keep a
/// frame on the GPU returns a decode error rather than silently falling back to
/// a CPU download (spec §0, §3.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeOutput {
    /// Decode to CPU I420 ([`DecodedFrameHandle::CpuI420`]). Software decoders,
    /// the WebCodecs probe path, and the §3.4 tier-2 floor use this.
    Cpu,
    /// Keep the decoded frame GPU-resident (CUDA `AVFrame` / VAAPI DRM-PRIME
    /// dma-bufs). Requires a hardware decode backend; construction fails loudly
    /// otherwise.
    Gpu,
}

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

    /// Decode into [`DecodedFrameHandle`]s — the single type a native video
    /// surface consumes (spec §3.2). The default implementation decodes to CPU
    /// I420 and wraps each frame as [`DecodedFrameHandle::CpuI420`], which is
    /// exactly what the software floor (libvpx VP9 — task G4) needs. Hardware
    /// decoders that keep frames GPU-resident override this.
    ///
    /// The CPU [`decode`](Self::decode) API is unchanged and still used by the
    /// WebCodecs probe path and existing tests (task G5).
    fn decode_to_handles(
        &mut self,
        frame: &EncodedFrame,
    ) -> Result<Vec<DecodedFrameHandle>, VideoError> {
        Ok(self
            .decode(frame)?
            .into_iter()
            .map(DecodedFrameHandle::cpu_i420_from)
            .collect())
    }

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
        // VP9 can decode on the GPU too: LavcDecoder supports vp9 via
        // NVDEC/VAAPI. On Linux with lavc, prefer hardware VP9 decode and fall
        // back to libvpx as the software floor — a deterministic choice made
        // once at construction, logged loudly (K5). Elsewhere, libvpx only.
        #[cfg(all(unix, not(target_os = "macos"), feature = "lavc", feature = "vpx"))]
        VideoCodec::Vp9 => {
            match crate::video::lavc::LavcDecoder::new(VideoCodec::Vp9, _config.clone()) {
                Ok(dec) if dec.is_hardware_accelerated() => {
                    tracing::info!(
                        backend = dec.backend_name(),
                        "vp9 decode: using lavc hardware path"
                    );
                    Ok(Box::new(dec))
                }
                // The lavc VP9 decoder opened but only as software; libvpx is the
                // tuned software floor for VP9, so use it instead.
                Ok(_) => {
                    tracing::info!("vp9 decode: lavc offered only software; using libvpx floor");
                    Ok(Box::new(Vp9Decoder::new(_config)?))
                }
                Err(err) => {
                    tracing::info!(error = %err, "vp9 decode: lavc unavailable; using libvpx floor");
                    Ok(Box::new(Vp9Decoder::new(_config)?))
                }
            }
        }
        #[cfg(all(
            feature = "vpx",
            not(all(unix, not(target_os = "macos"), feature = "lavc"))
        ))]
        VideoCodec::Vp9 => Ok(Box::new(Vp9Decoder::new(_config)?)),
        #[cfg(not(feature = "vpx"))]
        VideoCodec::Vp9 => Err(VideoError::CodecUnavailable(
            "vp9 decoder unavailable without 'vpx' feature".into(),
        )),
        // H.264/AV1 decode is native in-process via the lavc engine (hardware
        // NVDEC → VAAPI, libavcodec software floor). VP9 stays on libvpx above.
        #[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
        VideoCodec::Av1 => Ok(Box::new(crate::video::lavc::LavcDecoder::new(
            VideoCodec::Av1,
            _config,
        )?)),
        #[cfg(not(all(unix, not(target_os = "macos"), feature = "lavc")))]
        VideoCodec::Av1 => Err(VideoError::CodecUnavailable(
            "av1 decoder backend requires the 'lavc' feature on this platform".into(),
        )),
        #[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
        VideoCodec::H264 => Ok(Box::new(crate::video::lavc::LavcDecoder::new(
            VideoCodec::H264,
            _config,
        )?)),
        // macOS: VideoToolbox hardware H.264 decode → I420. The session is built
        // lazily from the SPS/PPS in the first keyframe, so construction only
        // needs to succeed here to advertise native decode support.
        #[cfg(target_os = "macos")]
        VideoCodec::H264 => Ok(Box::new(
            crate::video::encoder::videotoolbox::VideoToolboxH264Decoder::new(_config)?,
        )),
        #[cfg(all(
            not(target_os = "macos"),
            not(all(unix, not(target_os = "macos"), feature = "lavc"))
        ))]
        VideoCodec::H264 => Err(VideoError::CodecUnavailable(
            "h264 decoder backend requires the 'lavc' feature on this platform".into(),
        )),
    }
}

/// Create a decoder that places its output where `output` selects (spec §3.2).
///
/// This is the constructor the native-surface route uses: a platform surface
/// that can only present GPU-resident handles (macOS `AVSampleBufferDisplayLayer`
/// consumes `CVPixelBuffer`; Linux CUDA/VAAPI interop consumes device memory /
/// dma-bufs) must be fed a [`DecodeOutput::Gpu`] decoder. [`DecodeOutput::Cpu`]
/// keeps the existing behaviour (software floor / tier-2), so it delegates to
/// [`create_decoder`] unchanged.
///
/// A [`DecodeOutput::Gpu`] request on a platform/codec with no GPU decode backend
/// is a loud error (never a silent CPU substitution): the route selector must
/// choose the CPU floor up front instead (spec §0, §3.4, §3.7).
pub fn create_decoder_with_output(
    codec: VideoCodec,
    config: DecoderConfig,
    output: DecodeOutput,
) -> Result<Box<dyn VideoDecoder>, VideoError> {
    match output {
        DecodeOutput::Cpu => create_decoder(codec, config),
        DecodeOutput::Gpu => {
            // macOS: VideoToolbox decodes H.264 to a GPU-resident CVPixelBuffer
            // that the AVSampleBufferDisplayLayer surface enqueues directly
            // (spec §3.5). VP9/AV1 have no VideoToolbox GPU decoder here, so a
            // GPU request for them fails loudly and the route selector takes the
            // passthrough/CPU path instead.
            #[cfg(target_os = "macos")]
            {
                match codec {
                    VideoCodec::H264 => Ok(Box::new(
                        crate::video::encoder::videotoolbox::VideoToolboxH264Decoder::new_with_output(
                            config,
                            DecodeOutput::Gpu,
                        )?,
                    )),
                    other => Err(VideoError::CodecUnavailable(format!(
                        "no macOS GPU decode backend for {other:?} (native surface requires CVPixelBuffer output)"
                    ))),
                }
            }
            // Linux: lavc keeps the frame GPU-resident (CUDA AVFrame / VAAPI
            // DRM-PRIME dma-bufs) for the zero-copy surface import (spec §3.3).
            #[cfg(all(unix, not(target_os = "macos"), feature = "lavc"))]
            {
                Ok(Box::new(crate::video::lavc::LavcDecoder::new_with_output(
                    codec,
                    config,
                    DecodeOutput::Gpu,
                )?))
            }
            #[cfg(not(any(
                target_os = "macos",
                all(unix, not(target_os = "macos"), feature = "lavc")
            )))]
            {
                let _ = (codec, config);
                Err(VideoError::CodecUnavailable(
                    "GPU decode output has no backend on this platform/build".into(),
                ))
            }
        }
    }
}

// ── VP9 Decoder (feature-gated) ──────────────────────────────────────

/// Largest decoded frame dimension (width or height) we will accept.
#[cfg(feature = "vpx")]
const MAX_DECODE_DIMENSION: u32 = 8192;

/// Largest decoded pixel count we will accept — an 8K UHD budget
/// (7680 × 4320 ≈ 33.2M pixels). Comfortably above any real call resolution.
#[cfg(feature = "vpx")]
const MAX_DECODE_PIXELS: u32 = 7680 * 4320;

/// Reject implausibly large decoded resolutions before any plane buffer is
/// allocated.
///
/// libvpx reports the display dimensions (`d_w`/`d_h`) straight from the
/// compressed bitstream header, which is remote, untrusted input. Without a
/// bound, a crafted header could drive an enormous `Vec::with_capacity` (a
/// denial-of-service allocation) and out-of-bounds plane reads in the copy
/// loops below. This caps each dimension and the total pixel budget, using
/// checked arithmetic so the `w * h` product cannot overflow before it is
/// range-checked. Callers must treat a rejection as a decode failure and
/// request a fresh keyframe.
/// `negotiated` is the resolution the peer advertised for this track in
/// `TrackPublish`; when present it caps the decode far below the global 8K
/// ceiling (see [`DecoderConfig::max_dimensions`]).
#[cfg(feature = "vpx")]
fn check_decode_resolution(
    w: u32,
    h: u32,
    negotiated: Option<(u32, u32)>,
) -> Result<(), VideoError> {
    let (max_w, max_h, max_px) = crate::video::negotiated_decode_ceiling(
        negotiated,
        MAX_DECODE_DIMENSION,
        MAX_DECODE_PIXELS,
    );
    let within_bounds = w > 0
        && h > 0
        && w <= max_w
        && h <= max_h
        && w.checked_mul(h).is_some_and(|px| px <= max_px);
    if within_bounds {
        Ok(())
    } else {
        Err(VideoError::DecodeFailed(format!(
            "decoded frame resolution out of bounds: {w}x{h} (max {max_w}x{max_h})"
        )))
    }
}

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
        /// Decode thread count, sized once from the first frame's resolution.
        threads: u32,
    }

    /// Decoder thread budget for a decoded resolution. VP9 tile/row threading
    /// only helps at larger sizes, and every extra thread costs memory and
    /// scheduling; a fixed 4 over-threads SD calls and under-threads 4K. Capped
    /// to the machine's parallelism minus headroom for audio/UI.
    fn decode_threads_for_pixels(pixels: u32) -> u32 {
        let available = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4);
        let recommended = match pixels {
            p if p >= 3840 * 2160 => 16,
            p if p >= 2560 * 1440 => 8,
            p if p >= 1280 * 720 => 4,
            _ => 2,
        };
        available.clamp(1, recommended)
    }

    // Safety: vpx_codec_ctx_t is only accessed via &mut self.
    unsafe impl Send for Vp9Decoder {}

    impl Vp9Decoder {
        /// Create a new VP9 decoder.
        pub fn new(config: DecoderConfig) -> Result<Self, VideoError> {
            // The libvpx context is initialized lazily on the first frame, once
            // its resolution is known via vpx_codec_peek_stream_info, so the
            // decode thread count can be sized to the frame instead of a fixed
            // guess. A fresh decoder always requires a keyframe first, so the
            // first decoded frame carries a stream header to peek.
            Ok(Self {
                ctx: unsafe { MaybeUninit::zeroed().assume_init() },
                config,
                needs_keyframe: true, // need a keyframe to start
                initialized: false,
                threads: 4,
            })
        }

        /// Peek the first frame's resolution to size the decode thread count,
        /// then initialize the context. Called lazily on the first decode.
        fn ensure_initialized(&mut self, first_frame: &[u8]) -> Result<(), VideoError> {
            unsafe {
                let iface = vpx_codec_vp9_dx();
                if iface.is_null() {
                    return Err(VideoError::DecoderInit(
                        "vpx_codec_vp9_dx returned null".into(),
                    ));
                }
                let mut si: vpx_codec_stream_info_t = MaybeUninit::zeroed().assume_init();
                si.sz = std::mem::size_of::<vpx_codec_stream_info_t>() as u32;
                let ret = vpx_codec_peek_stream_info(
                    iface,
                    first_frame.as_ptr(),
                    first_frame.len() as u32,
                    &mut si,
                );
                // Only used to size threads; the real resolution bound still
                // runs per decoded image. If peek fails, keep the default thread
                // count. The peeked header is untrusted, so clamp it to the
                // resolution the peer negotiated before it can buy a 16-thread
                // decoder off a crafted 4K/8K header on a 320x180 layer.
                if ret == VPX_CODEC_OK && si.w > 0 && si.h > 0 {
                    let (max_w, max_h, max_px) = crate::video::negotiated_decode_ceiling(
                        self.config.max_dimensions,
                        super::MAX_DECODE_DIMENSION,
                        super::MAX_DECODE_PIXELS,
                    );
                    let pixels = si.w.min(max_w).saturating_mul(si.h.min(max_h)).min(max_px);
                    self.threads = decode_threads_for_pixels(pixels);
                }
            }
            self.init_context()
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
                cfg.threads = self.threads;

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
            // If we need a keyframe and this isn't one, skip it.
            if self.needs_keyframe && !frame.is_keyframe {
                return Err(VideoError::KeyframeRequired);
            }

            // Lazily initialize on the first frame (always a keyframe), sizing
            // the decode thread count from its peeked resolution.
            if !self.initialized {
                self.ensure_initialized(&frame.data)?;
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

                    // The copy loops below treat the image as planar 8-bit
                    // I420. VP9 profiles 1/2/3 legitimately carry 4:2:2, 4:4:4,
                    // 4:4:0 and 10/12-bit content, and libvpx will happily hand
                    // us one — reinterpreting those planes as I420 produces
                    // garbled output (and, for the high-bit-depth formats, reads
                    // half the real plane). There is no silent reinterpretation:
                    // an unsupported format is a loud decode failure.
                    if img.fmt != vpx_img_fmt::VPX_IMG_FMT_I420 {
                        self.needs_keyframe = true;
                        return Err(VideoError::DecodeFailed(format!(
                            "unsupported VP9 image format {:?}; only 8-bit I420 (profile 0) is supported",
                            img.fmt
                        )));
                    }

                    // Bound the decoded resolution before computing plane sizes
                    // or allocating any buffer. `d_w`/`d_h` come from the remote
                    // bitstream header, so an unbounded value here is both a DoS
                    // allocation vector and an out-of-bounds risk in the copy
                    // loops below. On rejection, request a keyframe to recover.
                    if let Err(e) =
                        super::check_decode_resolution(img.d_w, img.d_h, self.config.max_dimensions)
                    {
                        self.needs_keyframe = true;
                        return Err(e);
                    }

                    // VP9's display size is arbitrary (`frame_width_minus_1` is
                    // a free 16-bit field), so an odd `d_w`/`d_h` is legal even
                    // though the 4:2:0 chroma planes are ceil(w/2) x ceil(h/2).
                    // The tightly-packed I420 buffer this produces is consumed
                    // by code that computes chroma as a truncating `w/2 * h/2`
                    // (`PixelFormat::frame_size`, the renderers, the IPC frame
                    // header), so an odd frame is emitted at the largest even
                    // size it contains rather than as a self-inconsistent
                    // buffer. `debug_assert!` used to "check" this and vanished
                    // in release.
                    let w = img.d_w & !1;
                    let h = img.d_h & !1;
                    if w == 0 || h == 0 {
                        self.needs_keyframe = true;
                        return Err(VideoError::DecodeFailed(format!(
                            "decoded VP9 frame is too small to represent as I420: {}x{}",
                            img.d_w, img.d_h
                        )));
                    }

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

                    // Safety: `w`/`h` are the display dimensions rounded DOWN to
                    // even, so `w <= img.d_w` and `h <= img.d_h`; libvpx
                    // allocates the luma plane with at least `d_h` rows of
                    // `stride[0] >= d_w` bytes and each chroma plane with at
                    // least ceil(d_h/2) rows of `stride[i] >= ceil(d_w/2)`
                    // bytes. `uv_w = w/2 <= ceil(d_w/2)` and
                    // `uv_h = h/2 <= ceil(d_h/2)`, so every row slice below is
                    // fully inside its plane. The format check above guarantees
                    // the planes are 8-bit I420, so one byte per sample.
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

                    // Map the bitstream's signaled matrix so the consumer picks
                    // the right YUV→RGB coefficients (contract C1). Unknown maps
                    // to the project default 709; the SD matrices map to 601.
                    let colorspace = match img.cs {
                        vpx_color_space::VPX_CS_BT_601 | vpx_color_space::VPX_CS_SMPTE_170 => {
                            crate::video::ColorSpace::Bt601
                        }
                        _ => crate::video::ColorSpace::Bt709,
                    };

                    decoded_frames.push(DecodedFrame {
                        data,
                        pixel_format: PixelFormat::I420,
                        width: w,
                        height: h,
                        pts: frame.pts,
                        colorspace,
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
            // Re-initialize lazily on the next keyframe so threads are re-sized
            // to the (possibly changed) resolution of the fresh stream.
            Ok(())
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
            colorspace: frame.colorspace,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
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
                colorspace: crate::video::ColorSpace::Bt709,
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
            colorspace: crate::video::ColorSpace::Bt709,
        };
        let decoded = dec.decode(&f).unwrap();
        assert_eq!(decoded[0].pts, 42);
    }
}

// ── VP9 decode tests (require libvpx via the `vpx` feature) ───────────

#[cfg(all(test, feature = "vpx"))]
mod vpx_tests {
    use super::*;
    use crate::video::encoder::{VideoEncoder, Vp9Encoder};
    use crate::video::{EncoderConfig, PixelFormat, VideoContentHint};

    const W: u32 = 320;
    const H: u32 = 240;

    /// Build a deterministic, non-uniform I420 frame so the encoder has real
    /// content to compress. A flat frame would still work, but a gradient
    /// exercises the DCT/quantization path more realistically.
    fn synthetic_i420(width: u32, height: u32, seed: u8) -> Vec<u8> {
        let w = width as usize;
        let h = height as usize;
        let uv_w = w / 2;
        let uv_h = h / 2;
        let mut frame = Vec::with_capacity(w * h + 2 * uv_w * uv_h);
        for y in 0..h {
            for x in 0..w {
                frame.push(((x + y) as u8).wrapping_add(seed));
            }
        }
        for _y in 0..uv_h {
            for x in 0..uv_w {
                frame.push(((x * 2) as u8).wrapping_add(seed));
            }
        }
        for y in 0..uv_h {
            for _x in 0..uv_w {
                frame.push(((y * 2) as u8).wrapping_add(seed).wrapping_add(64));
            }
        }
        debug_assert_eq!(frame.len(), PixelFormat::I420.frame_size(width, height));
        frame
    }

    fn encoder_config() -> EncoderConfig {
        EncoderConfig {
            width: W,
            height: H,
            fps: 30,
            bitrate_kbps: 500,
            pixel_format: PixelFormat::I420,
            keyframe_interval: 0,
            content_hint: VideoContentHint::Default,
        }
    }

    #[test]
    fn vp9_decodes_keyframe_to_i420() {
        let mut enc = Vp9Encoder::new(encoder_config()).unwrap();
        let mut dec = Vp9Decoder::new(DecoderConfig::default()).unwrap();
        assert!(dec.needs_keyframe(), "fresh decoder must want a keyframe");

        let src = synthetic_i420(W, H, 0);
        let encoded = enc.encode(0, &src, true).unwrap();
        let keyframe = encoded
            .iter()
            .find(|f| f.is_keyframe)
            .expect("encoder must emit a keyframe when forced");

        let decoded = dec.decode(keyframe).unwrap();
        assert_eq!(decoded.len(), 1, "one keyframe packet -> one decoded frame");
        let frame = &decoded[0];
        assert_eq!(frame.pixel_format, PixelFormat::I420);
        assert_eq!(frame.width, W);
        assert_eq!(frame.height, H);
        assert_eq!(frame.data.len(), (W * H * 3 / 2) as usize);
        assert!(
            !dec.needs_keyframe(),
            "decoder no longer needs a keyframe after decoding one"
        );
    }

    #[test]
    fn vp9_decodes_following_inter_frame() {
        let mut enc = Vp9Encoder::new(encoder_config()).unwrap();
        let mut dec = Vp9Decoder::new(DecoderConfig::default()).unwrap();

        // Keyframe first to prime both encoder and decoder reference state.
        let kf = enc.encode(0, &synthetic_i420(W, H, 0), true).unwrap();
        let kf = kf.into_iter().find(|f| f.is_keyframe).unwrap();
        dec.decode(&kf).unwrap();

        // A subsequent inter frame with different content.
        let inter = enc.encode(1, &synthetic_i420(W, H, 40), false).unwrap();
        let inter = inter
            .into_iter()
            .next()
            .expect("encoder must emit the inter frame");
        assert!(!inter.is_keyframe, "second frame should be an inter frame");

        let decoded = dec.decode(&inter).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].pixel_format, PixelFormat::I420);
        assert_eq!(decoded[0].width, W);
        assert_eq!(decoded[0].height, H);
        assert_eq!(decoded[0].data.len(), (W * H * 3 / 2) as usize);
    }

    #[test]
    fn check_decode_resolution_accepts_normal_sizes() {
        // Common call resolutions all pass.
        assert!(check_decode_resolution(320, 240, None).is_ok());
        assert!(check_decode_resolution(1920, 1080, None).is_ok());
        assert!(check_decode_resolution(3840, 2160, None).is_ok());
        // Exactly the pixel budget (8K UHD) is accepted.
        assert!(check_decode_resolution(7680, 4320, None).is_ok());
    }

    #[test]
    fn check_decode_resolution_rejects_oversize() {
        // A single dimension past the cap is rejected.
        assert!(matches!(
            check_decode_resolution(8193, 16, None),
            Err(VideoError::DecodeFailed(_))
        ));
        assert!(matches!(
            check_decode_resolution(16, 8193, None),
            Err(VideoError::DecodeFailed(_))
        ));
        // Both dimensions within the per-dimension cap but the pixel product
        // over budget is rejected.
        assert!(matches!(
            check_decode_resolution(8192, 8192, None),
            Err(VideoError::DecodeFailed(_))
        ));
        // Extreme values that would overflow a naive `w * h` are rejected via
        // checked arithmetic rather than wrapping.
        assert!(matches!(
            check_decode_resolution(u32::MAX, u32::MAX, None),
            Err(VideoError::DecodeFailed(_))
        ));
        // Zero is not a decodable frame either.
        assert!(matches!(
            check_decode_resolution(0, 0, None),
            Err(VideoError::DecodeFailed(_))
        ));
    }

    /// The peer's negotiated (`TrackPublish`) resolution — not the global 8K
    /// constant — is the real ceiling: a 320x180 layer publisher cannot make the
    /// decoder allocate 4K/8K planes off a crafted bitstream header.
    #[cfg(feature = "vpx")]
    #[test]
    fn negotiated_resolution_caps_vp9_decode() {
        let negotiated = Some((1280u32, 720u32));
        assert!(check_decode_resolution(1280, 720, negotiated).is_ok());
        assert!(check_decode_resolution(3840, 2160, negotiated).is_err());
        assert!(check_decode_resolution(7680, 4320, negotiated).is_err());
        // With no negotiated size the global ceiling still applies.
        assert!(check_decode_resolution(7680, 4320, None).is_ok());
    }

    #[test]
    fn vp9_rejects_non_keyframe_first() {
        let mut dec = Vp9Decoder::new(DecoderConfig::default()).unwrap();

        let non_kf = EncodedFrame {
            data: vec![0u8; 64],
            codec: VideoCodec::Vp9,
            pts: 0,
            is_keyframe: false,
            layer: None,
            width: W,
            height: H,
            colorspace: crate::video::ColorSpace::Bt709,
        };
        assert!(
            matches!(dec.decode(&non_kf), Err(VideoError::KeyframeRequired)),
            "a fresh decoder must reject a non-keyframe"
        );
        assert!(dec.needs_keyframe());
    }

    #[test]
    fn vp9_reset_requires_keyframe_again() {
        let mut enc = Vp9Encoder::new(encoder_config()).unwrap();
        let mut dec = Vp9Decoder::new(DecoderConfig::default()).unwrap();

        let kf = enc.encode(0, &synthetic_i420(W, H, 0), true).unwrap();
        let kf = kf.into_iter().find(|f| f.is_keyframe).unwrap();
        dec.decode(&kf).unwrap();
        assert!(!dec.needs_keyframe());

        dec.reset().unwrap();
        assert!(
            dec.needs_keyframe(),
            "reset must restore the keyframe requirement"
        );
    }
}
