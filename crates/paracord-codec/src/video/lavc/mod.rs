//! In-process GPU video codec engine backed by system libavcodec (`lavc`).
//!
//! This is the in-process replacement for the ffmpeg *subprocess* H.264/AV1
//! encoders that previously backed the Linux media path. Instead of piping raw
//! frames to a child `ffmpeg` and parsing its stdout, we drive libavcodec,
//! libavfilter and libswscale directly through [`ffmpeg_sys_next`]. The payoff
//! that motivates the whole engine: **per-frame keyframe control**. A
//! subprocess cannot be told "make *this* frame an IDR"; it could only fake it
//! with a ≤1-second GOP. In-process we set `AV_PICTURE_TYPE_I` +
//! `AV_FRAME_FLAG_KEY` (and `forced-idr` on NVENC) on the exact frame a
//! keyframe was requested for, so requests are answered instantly.
//!
//! # Scope and constraints
//!
//! - **Encoders**: hardware only — `h264_nvenc`, `av1_nvenc`, `h264_vaapi`,
//!   `av1_vaapi`, `h264_qsv`, `av1_qsv`. Software H.264/AV1 encode is
//!   deliberately absent: software encode stays with the existing libvpx VP9
//!   path. This keeps us LGPL-clean — we never require or enable a GPL encoder
//!   (no libx264, no `--enable-gpl` assumptions).
//! - **Decoders**: H.264 (Annex-B), AV1 (OBU temporal units) and VP9, with
//!   hardware decode (NVDEC/VAAPI) preferred and libavcodec's own LGPL native
//!   decoders as the software floor (LGPL native *decoders* are fine).
//! - **Backend selection is decided once, up front** (project philosophy: no
//!   runtime backend switching, no silent fallback to a worse path mid-stream).
//!   A backend is chosen only after it actually opens a context and produces a
//!   real packet/frame; if the chosen backend fails later we return errors
//!   rather than substituting another.
//! - **Dynamic linking via pkg-config only.** No bundled ffmpeg.
//!
//! The module is gated behind the non-default `lavc` cargo feature so the
//! default build never links ffmpeg.

use crate::video::{PixelFormat, VideoCodec, VideoError};
use ffmpeg_sys_next as ff;
use std::ffi::{c_char, c_int, CStr, CString};

mod decoder;
pub mod dmabuf;
mod encoder;

pub use decoder::LavcDecoder;
pub use dmabuf::{
    probe_dmabuf_vaapi_import, DmaBufDescriptor, DmaBufObject, DmaBufPlane, DmaBufVaapiEncoder,
};
pub use encoder::LavcEncoder;

// ── Backend identity ─────────────────────────────────────────────────

/// A concrete libavcodec hardware backend. Chosen once at construction and
/// fixed thereafter — this enum is never re-evaluated per frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LavcBackend {
    /// NVIDIA NVENC via the CUDA hwcontext (`*_nvenc`).
    Nvenc,
    /// VAAPI via a DRM render node (`*_vaapi`) — AMD, Intel, and NVIDIA-via-nvidia-vaapi.
    Vaapi,
    /// Intel Quick Sync via the QSV hwcontext (`*_qsv`).
    Qsv,
}

/// Result of probing which libavcodec backend can encode a given codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LavcBackendInfo {
    /// The selected backend kind.
    pub backend: LavcBackend,
    /// Always `true` for this engine — every allowed backend is hardware.
    pub hardware_accelerated: bool,
}

/// Backend probe order per codec: NVENC first (best quality/latency on this
/// project's target hardware), then VAAPI, then QSV. The *same* order is used
/// for encoder construction and for the standalone probe helpers so that what
/// a probe reports is exactly what a constructor would pick.
pub(crate) const BACKEND_ORDER: [LavcBackend; 3] =
    [LavcBackend::Nvenc, LavcBackend::Vaapi, LavcBackend::Qsv];

impl LavcBackend {
    /// The libavcodec encoder name for `(self, codec)`, e.g. `h264_nvenc`.
    pub(crate) fn encoder_name(self, codec: VideoCodec) -> Option<&'static str> {
        Some(match (self, codec) {
            (LavcBackend::Nvenc, VideoCodec::H264) => "h264_nvenc",
            (LavcBackend::Nvenc, VideoCodec::Av1) => "av1_nvenc",
            (LavcBackend::Vaapi, VideoCodec::H264) => "h264_vaapi",
            (LavcBackend::Vaapi, VideoCodec::Av1) => "av1_vaapi",
            (LavcBackend::Qsv, VideoCodec::H264) => "h264_qsv",
            (LavcBackend::Qsv, VideoCodec::Av1) => "av1_qsv",
            // VP9 (and anything else) has no hardware encoder here; encode
            // stays on the libvpx path.
            _ => return None,
        })
    }

    /// Stable diagnostic name surfaced through
    /// [`VideoEncoder::backend_name`](crate::video::encoder::VideoEncoder::backend_name),
    /// e.g. `lavc-nvenc-h264`.
    pub(crate) fn display_name(self, codec: VideoCodec) -> &'static str {
        match (self, codec) {
            (LavcBackend::Nvenc, VideoCodec::H264) => "lavc-nvenc-h264",
            (LavcBackend::Nvenc, VideoCodec::Av1) => "lavc-nvenc-av1",
            (LavcBackend::Vaapi, VideoCodec::H264) => "lavc-vaapi-h264",
            (LavcBackend::Vaapi, VideoCodec::Av1) => "lavc-vaapi-av1",
            (LavcBackend::Qsv, VideoCodec::H264) => "lavc-qsv-h264",
            (LavcBackend::Qsv, VideoCodec::Av1) => "lavc-qsv-av1",
            _ => "lavc-unknown",
        }
    }

    /// The `AVHWDeviceType` used to create this backend's device context.
    pub(crate) fn hwdevice_type(self) -> ff::AVHWDeviceType {
        match self {
            LavcBackend::Nvenc => ff::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
            LavcBackend::Vaapi => ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            LavcBackend::Qsv => ff::AVHWDeviceType::AV_HWDEVICE_TYPE_QSV,
        }
    }

    /// The hardware `AVPixelFormat` frames of this backend live in — the format
    /// the encoder's `pix_fmt` is set to and the filter graph's buffersink
    /// emits.
    pub(crate) fn hw_pix_fmt(self) -> ff::AVPixelFormat {
        match self {
            LavcBackend::Nvenc => ff::AVPixelFormat::AV_PIX_FMT_CUDA,
            LavcBackend::Vaapi => ff::AVPixelFormat::AV_PIX_FMT_VAAPI,
            LavcBackend::Qsv => ff::AVPixelFormat::AV_PIX_FMT_QSV,
        }
    }
}

// ── Pixel-format mapping ─────────────────────────────────────────────

/// Map our [`PixelFormat`] to the libavcodec `AVPixelFormat` used for the
/// *software* input frame handed to the filter graph.
pub(crate) fn av_input_pix_fmt(pf: PixelFormat) -> ff::AVPixelFormat {
    match pf {
        PixelFormat::Bgra => ff::AVPixelFormat::AV_PIX_FMT_BGRA,
        PixelFormat::Rgba => ff::AVPixelFormat::AV_PIX_FMT_RGBA,
        PixelFormat::I420 => ff::AVPixelFormat::AV_PIX_FMT_YUV420P,
    }
}

/// The libavfilter format name for our input pixel format. Used inside the
/// GPU filter chain (e.g. `scale_cuda=...:format=bgra`) where the format is
/// *preserved* through the upload/scale and the encoder does the final
/// conversion to NV12 on the GPU — the reason there is zero CPU pixel
/// conversion on the NVENC path.
pub(crate) fn av_input_format_name(pf: PixelFormat) -> &'static str {
    match pf {
        PixelFormat::Bgra => "bgra",
        PixelFormat::Rgba => "rgba",
        PixelFormat::I420 => "yuv420p",
    }
}

// ── FFI helpers ──────────────────────────────────────────────────────

/// Render an `AVERROR` code as its human-readable `av_strerror` text.
///
/// Being in-process, ffmpeg errors are direct negative return codes rather
/// than a subprocess exit + stderr scrape, so we map them straight to
/// [`VideoError`] with the real message.
pub(crate) fn av_error_text(code: c_int) -> String {
    let mut buf = [0 as c_char; 256];
    unsafe {
        ff::av_strerror(code, buf.as_mut_ptr(), buf.len());
        CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
    }
}

/// Build a `CString` from a string we control (filter descriptions, option
/// names/values). These never contain interior NULs.
pub(crate) fn cstr(s: &str) -> CString {
    CString::new(s).expect("lavc: option/filter string contains an interior NUL")
}

/// `AVERROR(EAGAIN)` — the codec wants more input / has no output yet. Computed
/// the way ffmpeg's macro does (`-errno`).
pub(crate) const AVERROR_EAGAIN: c_int = -(ff::EAGAIN as c_int);

// ── AV1 OBU keyframe detection ───────────────────────────────────────

// The AV1 temporal-unit keyframe parser now lives in the feature-independent
// parent module (`crate::video`) so the Windows Media Foundation AV1 path can
// use it without pulling in `lavc`. Re-exported here so existing lavc callers
// and the smoke tests keep referring to it through `super`.
pub use crate::video::av1_temporal_unit_is_keyframe;

/// Whether `data` begins with an H.264 Annex-B start code (`00 00 01` or
/// `00 00 00 01`). Used to *verify* that the NVENC/VAAPI H.264 packets we emit
/// are Annex-B, not to reshape them.
pub fn is_annex_b(data: &[u8]) -> bool {
    data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1])
}

// ── Capability probing / inventory ───────────────────────────────────

/// Representative probe resolution — a real stream size, so a backend that
/// only survives a toy frame does not pass.
pub(crate) const PROBE_WIDTH: u32 = 1280;
pub(crate) const PROBE_HEIGHT: u32 = 720;

/// Probe which libavcodec backend can encode `codec`, in the fixed backend
/// order, by actually opening an encoder and encoding one black frame.
///
/// Returns the first backend that produces a real packet, or `None` if none
/// do (or `codec` has no hardware encoder here, e.g. VP9). This is the
/// inventory call that integration uses to decide whether the in-process
/// engine is available before wiring it into the media pipeline.
pub fn probe_lavc_encoder(codec: VideoCodec) -> Option<LavcBackendInfo> {
    if codec.encoder_backends_supported() {
        for backend in BACKEND_ORDER {
            if encoder::encode_probe_frame(codec, backend, PROBE_WIDTH, PROBE_HEIGHT).is_ok() {
                return Some(LavcBackendInfo {
                    backend,
                    hardware_accelerated: true,
                });
            }
        }
    }
    None
}

/// Produce one real encoded keyframe for `codec` at representative settings
/// (1280x720), using the first working backend.
///
/// H.264 → Annex-B bytes; AV1 → a raw OBU temporal unit. The bytes are a
/// genuine hardware-encoded bitstream suitable for functionally verifying a
/// remote decoder's support claim.
pub fn generate_probe_frame(codec: VideoCodec) -> Option<Vec<u8>> {
    if !codec.encoder_backends_supported() {
        return None;
    }
    for backend in BACKEND_ORDER {
        if let Ok(bytes) = encoder::encode_probe_frame(codec, backend, PROBE_WIDTH, PROBE_HEIGHT) {
            return Some(bytes);
        }
    }
    None
}

impl VideoCodec {
    /// Whether this codec has a hardware encoder in this engine (H.264/AV1).
    /// VP9 does not — its encode path stays on libvpx.
    fn encoder_backends_supported(self) -> bool {
        matches!(self, VideoCodec::H264 | VideoCodec::Av1)
    }
}

/// Guard used by encoder/decoder construction to reject unsupported codecs
/// with a precise message rather than a generic failure.
pub(crate) fn require_encodable(codec: VideoCodec) -> Result<(), VideoError> {
    if codec.encoder_backends_supported() {
        Ok(())
    } else {
        Err(VideoError::CodecUnavailable(format!(
            "lavc engine has no hardware encoder for {codec:?}; software encode stays on libvpx VP9"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_names_are_stable() {
        assert_eq!(
            LavcBackend::Nvenc.display_name(VideoCodec::H264),
            "lavc-nvenc-h264"
        );
        assert_eq!(
            LavcBackend::Vaapi.display_name(VideoCodec::Av1),
            "lavc-vaapi-av1"
        );
        assert_eq!(
            LavcBackend::Nvenc.encoder_name(VideoCodec::Av1),
            Some("av1_nvenc")
        );
        assert_eq!(LavcBackend::Nvenc.encoder_name(VideoCodec::Vp9), None);
    }

    #[test]
    fn averror_eagain_is_negative_errno() {
        // ffmpeg's AVERROR(EAGAIN) is -EAGAIN on POSIX.
        assert_eq!(AVERROR_EAGAIN, -11);
    }

    #[test]
    fn annex_b_detection() {
        assert!(is_annex_b(&[0, 0, 0, 1, 0x67]));
        assert!(is_annex_b(&[0, 0, 1, 0x67]));
        assert!(!is_annex_b(&[0x00, 0x01, 0x02]));
    }

    #[test]
    fn input_format_mapping() {
        assert_eq!(av_input_format_name(PixelFormat::Bgra), "bgra");
        assert_eq!(av_input_format_name(PixelFormat::I420), "yuv420p");
        assert_eq!(
            av_input_pix_fmt(PixelFormat::Rgba),
            ff::AVPixelFormat::AV_PIX_FMT_RGBA
        );
    }

    #[test]
    fn av_error_text_is_nonempty() {
        // A well-known code should stringify to something.
        let text = av_error_text(AVERROR_EAGAIN);
        assert!(!text.is_empty());
    }
}

// ── Hardware smoke tests ─────────────────────────────────────────────
//
// These drive real GPU encode+decode and are `#[ignore]` so CI (which has no
// GPU) skips them. Run locally with:
//   cargo test -p paracord-codec --features lavc -- --ignored --nocapture
#[cfg(test)]
mod hw_smoke {
    use super::*;
    use crate::video::decoder::VideoDecoder;
    use crate::video::encoder::VideoEncoder;
    use crate::video::{DecoderConfig, EncoderConfig, VideoContentHint};
    use std::time::Instant;

    const W: u32 = 1870;
    const H: u32 = 1078;
    const FRAMES: i64 = 120;
    const KEYFRAME_AT: i64 = 60;

    /// Deterministic moving BGRA content so the encoder does real work each
    /// frame (a flat frame compresses to nearly nothing and hides timing).
    fn synthetic_bgra(width: u32, height: u32, frame: i64) -> Vec<u8> {
        let w = width as usize;
        let h = height as usize;
        let mut buf = vec![0u8; w * h * 4];
        let f = frame as usize;
        for (y, row) in buf.chunks_exact_mut(w * 4).enumerate().take(h) {
            for (x, px) in row.chunks_exact_mut(4).enumerate().take(w) {
                px[0] = (x + f * 3) as u8; // B
                px[1] = (y + f * 2) as u8; // G
                px[2] = ((x ^ y) as u8).wrapping_add(f as u8); // R
                px[3] = 255; // A
            }
        }
        buf
    }

    fn encoder_config() -> EncoderConfig {
        EncoderConfig {
            width: W,
            height: H,
            fps: 60,
            bitrate_kbps: 6_000,
            pixel_format: PixelFormat::Bgra,
            keyframe_interval: 0, // on-demand keyframes only
            content_hint: VideoContentHint::Default,
        }
    }

    /// Encode 120 frames (forced keyframes at 0 and 60), assert packet cadence
    /// and keyframe placement, then decode the stream back to I420. Returns the
    /// mean per-frame encode time in milliseconds.
    fn encode_decode_roundtrip(codec: VideoCodec) -> f64 {
        let mut enc = LavcEncoder::new_with_input(codec, encoder_config(), W, H)
            .expect("construct LavcEncoder");
        println!(
            "[lavc-smoke] {codec:?} encoder backend = {} (hw={})",
            enc.backend_name(),
            enc.is_hardware_accelerated()
        );

        let mut all_packets = Vec::new();
        let mut per_frame_packets = vec![0usize; FRAMES as usize];
        let mut total_encode = std::time::Duration::ZERO;

        for pts in 0..FRAMES {
            let frame = synthetic_bgra(W, H, pts);
            let force = pts == 0 || pts == KEYFRAME_AT;
            let start = Instant::now();
            let packets = enc.encode(pts, &frame, force).expect("encode frame");
            total_encode += start.elapsed();
            per_frame_packets[pts as usize] = packets.len();
            for p in &packets {
                assert_eq!(p.width, W);
                assert_eq!(p.height, H);
                assert!(!p.data.is_empty(), "empty packet at pts {}", p.pts);
                assert!(
                    p.data.len() < (W * H * 4) as usize,
                    "packet larger than a raw frame at pts {}",
                    p.pts
                );
            }
            all_packets.extend(packets);
        }
        all_packets.extend(enc.flush().expect("flush"));

        let mean_ms = total_encode.as_secs_f64() * 1000.0 / FRAMES as f64;
        println!(
            "[lavc-smoke] {codec:?} encoded {} packets from {FRAMES} frames; mean {:.3} ms/frame",
            all_packets.len(),
            mean_ms
        );

        // ≥1 packet per frame after a small warmup (a low-delay encoder should
        // emit immediately, but allow the pipeline to fill).
        const WARMUP: usize = 5;
        for (i, &n) in per_frame_packets.iter().enumerate().skip(WARMUP) {
            assert!(n >= 1, "no packet produced for frame {i} after warmup");
        }

        // The forced keyframe at pts 60 must be a keyframe on the wire.
        let kf = all_packets
            .iter()
            .find(|p| p.pts == KEYFRAME_AT)
            .expect("a packet with pts 60");
        assert!(kf.is_keyframe, "forced frame 60 must be a keyframe");

        // Codec-specific bitstream verification.
        let first_kf = all_packets
            .iter()
            .find(|p| p.is_keyframe)
            .expect("at least one keyframe");
        match codec {
            VideoCodec::H264 => {
                assert!(is_annex_b(&first_kf.data), "H.264 keyframe must be Annex-B")
            }
            VideoCodec::Av1 => assert!(
                av1_temporal_unit_is_keyframe(&first_kf.data),
                "AV1 keyframe must be a raw OBU temporal unit with a sequence header"
            ),
            VideoCodec::Vp9 => unreachable!(),
        }

        // Decode the encoder's own output back to I420.
        let mut dec = LavcDecoder::new(codec, DecoderConfig::default()).expect("construct decoder");
        println!(
            "[lavc-smoke] {codec:?} decoder backend = {} (hw={})",
            dec.backend_name(),
            dec.is_hardware_accelerated()
        );
        let mut decoded_count = 0usize;
        for pkt in &all_packets {
            let frames = dec.decode(pkt).expect("decode packet");
            for f in frames {
                assert_eq!(f.width, W, "decoded width");
                assert_eq!(f.height, H, "decoded height");
                assert_eq!(f.pixel_format, PixelFormat::I420);
                assert_eq!(
                    f.data.len(),
                    PixelFormat::I420.frame_size(W, H),
                    "decoded I420 size"
                );
                decoded_count += 1;
            }
        }
        println!("[lavc-smoke] {codec:?} decoded {decoded_count} frames back to I420");
        assert!(
            decoded_count >= (FRAMES as usize) - WARMUP,
            "expected most frames to decode, got {decoded_count}"
        );

        mean_ms
    }

    #[test]
    #[ignore = "requires GPU hardware encode/decode"]
    fn h264_encode_decode_1870x1078() {
        let ms = encode_decode_roundtrip(VideoCodec::H264);
        assert!(ms < 1000.0, "implausible per-frame encode time");
    }

    #[test]
    #[ignore = "requires GPU hardware encode/decode"]
    fn av1_encode_decode_1870x1078() {
        let ms = encode_decode_roundtrip(VideoCodec::Av1);
        assert!(ms < 1000.0, "implausible per-frame encode time");
    }

    #[test]
    #[ignore = "requires GPU hardware encode"]
    fn probe_and_generate_probe_frames() {
        for codec in [VideoCodec::H264, VideoCodec::Av1] {
            let info = probe_lavc_encoder(codec)
                .unwrap_or_else(|| panic!("no lavc encoder backend for {codec:?}"));
            println!("[lavc-smoke] probe {codec:?} -> {info:?}");
            assert!(info.hardware_accelerated);

            let bytes = generate_probe_frame(codec)
                .unwrap_or_else(|| panic!("no probe frame for {codec:?}"));
            assert!(!bytes.is_empty());
            match codec {
                VideoCodec::H264 => assert!(is_annex_b(&bytes), "probe H.264 must be Annex-B"),
                VideoCodec::Av1 => assert!(
                    av1_temporal_unit_is_keyframe(&bytes),
                    "probe AV1 must be a keyframe OBU TU"
                ),
                VideoCodec::Vp9 => unreachable!(),
            }
            println!("[lavc-smoke] {codec:?} probe frame = {} bytes", bytes.len());
        }
    }
}
