use serde::{Deserialize, Serialize};

use paracord_transport::stream::{
    VideoCodec, VideoCodecCapability as TransportVideoCodecCapability,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoBackendKind {
    MediaFoundation,
    VideoToolbox,
    Vaapi,
    LibVpx,
    WebCodecs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecCapability {
    pub codec: VideoCodec,
    pub backend: VideoBackendKind,
    pub encode: bool,
    pub decode: bool,
    /// Encode is hardware-accelerated. Codec negotiation's hardware-first pass
    /// keys ONLY on this (contract C3).
    #[serde(default)]
    pub encode_hardware: bool,
    /// Decode is hardware-accelerated. "unknown is not hardware": native
    /// software decoders and webview-contributed decode both report false.
    #[serde(default)]
    pub decode_hardware: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamCapabilities {
    pub video: Vec<VideoCodecCapability>,
    pub native_desktop_renderer: bool,
    /// True when the platform surface composites BELOW the webview (Linux GTK
    /// underlay): DOM chrome renders over the video, so the tile must punch a
    /// transparent hole and skip DOM occlusion sampling. False for overlay
    /// backends (macOS AVSampleBufferDisplayLayer floats above the webview).
    #[serde(default)]
    pub native_render_underlay: bool,
    pub browser_interop_protocol_v1: bool,
    pub real_media_e2ee: bool,
    pub simulcast_v1: bool,
}

impl VideoCodecCapability {
    pub fn to_transport(&self) -> TransportVideoCodecCapability {
        TransportVideoCodecCapability {
            codec: self.codec,
            encode: self.encode,
            decode: self.decode,
            encode_hardware: self.encode_hardware,
            decode_hardware: self.decode_hardware,
        }
    }
}

/// Parse a wire codec label (`vp9` / `h264` / `av1`, whitespace- and
/// case-insensitive) into a transport [`VideoCodec`]. Returns `None` for empty
/// or unrecognized labels. Single source of truth for the string → codec
/// mapping shared by the key-announce command and screen-share encoder setup.
pub fn video_codec_from_label(label: &str) -> Option<VideoCodec> {
    match label.trim().to_ascii_lowercase().as_str() {
        "vp9" => Some(VideoCodec::Vp9),
        "h264" => Some(VideoCodec::H264),
        "av1" => Some(VideoCodec::Av1),
        _ => None,
    }
}

/// Whether the native (Rust) pipeline can decode `codec` in-process.
///
/// This probes [`paracord_codec::video::decoder::create_decoder`] — the single
/// source of truth for which codecs have a working native decoder backend —
/// rather than inferring decode support from an *encoder* probe (a
/// MediaFoundation H.264/AV1 encoder says nothing about decode). Codecs without
/// a native decoder are still delivered to the JS renderer as an encoded
/// passthrough; that renderer-side (WebCodecs) decode support is advertised by
/// the frontend via the session's `advertised_capabilities`, not inferred here.
fn native_decode_supported(codec: VideoCodec) -> bool {
    let native_codec = match codec {
        VideoCodec::Vp9 => paracord_codec::video::VideoCodec::Vp9,
        VideoCodec::Av1 => paracord_codec::video::VideoCodec::Av1,
        VideoCodec::H264 => paracord_codec::video::VideoCodec::H264,
    };
    paracord_codec::video::decoder::create_decoder(
        native_codec,
        paracord_codec::video::DecoderConfig::default(),
    )
    .is_ok()
}

pub fn detect_media_stream_capabilities() -> MediaStreamCapabilities {
    let mut video = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let av1_probe = paracord_codec::video::encoder::MfAv1Encoder::probe_backend(None).ok();
        video.push(VideoCodecCapability {
            codec: VideoCodec::Av1,
            backend: VideoBackendKind::MediaFoundation,
            encode: av1_probe.is_some(),
            decode: native_decode_supported(VideoCodec::Av1),
            encode_hardware: av1_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
            decode_hardware: false,
        });
        let h264_probe = paracord_codec::video::encoder::MfH264Encoder::probe_backend(None).ok();
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::MediaFoundation,
            encode: h264_probe.is_some(),
            decode: native_decode_supported(VideoCodec::H264),
            encode_hardware: h264_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
            decode_hardware: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            encode_hardware: false,
            decode_hardware: false,
        });
    }

    #[cfg(target_os = "macos")]
    {
        // Probe the real VideoToolbox encoder (constructs a session and encodes
        // one black keyframe), so `encode: true` means it genuinely works here.
        let h264_probe = paracord_codec::video::encoder::videotoolbox::probe_h264_encoder();
        // Native H.264 decode is VideoToolbox on macOS. `decode` means a native
        // decoder exists; `decode_hardware` is asserted ONLY when VideoToolbox
        // confirms a hardware decoder via `VTIsHardwareDecodeSupported` (spec M3:
        // "unknown is not hardware"), never merely because a session can be built.
        let h264_native_decode = native_decode_supported(VideoCodec::H264);
        let h264_hw_decode = h264_native_decode
            && paracord_codec::video::encoder::videotoolbox::supports_h264_hardware_decode();
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::VideoToolbox,
            encode: h264_probe.is_some(),
            decode: h264_native_decode,
            encode_hardware: h264_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
            decode_hardware: h264_hw_decode,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            encode_hardware: false,
            decode_hardware: false,
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // AV1 first: better quality per bit than H.264 and hardware-encoded
        // in-process on RTX 40+ (NVENC) / RDNA3+ and Arc (VAAPI). The probe
        // actually opens a hardware encoder and encodes a frame, so `encode:
        // true` means it genuinely works here. The backend kind stays `Vaapi`
        // for wire compatibility regardless of which lavc backend was chosen.
        let av1_probe =
            paracord_codec::video::lavc::probe_lavc_encoder(paracord_codec::video::VideoCodec::Av1);
        video.push(VideoCodecCapability {
            codec: VideoCodec::Av1,
            backend: VideoBackendKind::Vaapi,
            encode: av1_probe.is_some(),
            decode: native_decode_supported(VideoCodec::Av1),
            encode_hardware: av1_probe
                .map(|info| info.hardware_accelerated)
                .unwrap_or(false),
            decode_hardware: false,
        });
        let h264_probe = paracord_codec::video::lavc::probe_lavc_encoder(
            paracord_codec::video::VideoCodec::H264,
        );
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::Vaapi,
            encode: h264_probe.is_some(),
            decode: native_decode_supported(VideoCodec::H264),
            encode_hardware: h264_probe
                .map(|info| info.hardware_accelerated)
                .unwrap_or(false),
            decode_hardware: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            encode_hardware: false,
            decode_hardware: false,
        });
    }

    MediaStreamCapabilities {
        video,
        native_desktop_renderer: cfg!(any(target_os = "linux", target_os = "macos")),
        native_render_underlay: cfg!(target_os = "linux"),
        browser_interop_protocol_v1: true,
        real_media_e2ee: true,
        simulcast_v1: true,
    }
}

/// Encode one real keyframe with the local encoder for `codec`, so the
/// webview can verify that its WebCodecs decoder actually decodes the codec
/// rather than merely claiming to (`isConfigSupported` has been observed to
/// approve configs the decoder then fails on with the first real frame).
/// Returns `None` when no local encoder exists for the codec — the claim is
/// then unverifiable and stands on its own.
pub fn generate_decode_probe_frame(codec: &str) -> Option<Vec<u8>> {
    match codec.trim().to_ascii_lowercase().as_str() {
        "vp9" => generate_vp9_probe_frame(),
        #[cfg(target_os = "macos")]
        "h264" => paracord_codec::video::encoder::videotoolbox::generate_h264_probe_frame(),
        #[cfg(all(unix, not(target_os = "macos")))]
        "h264" => paracord_codec::video::lavc::generate_probe_frame(
            paracord_codec::video::VideoCodec::H264,
        ),
        #[cfg(all(unix, not(target_os = "macos")))]
        "av1" => paracord_codec::video::lavc::generate_probe_frame(
            paracord_codec::video::VideoCodec::Av1,
        ),
        _ => None,
    }
}

#[cfg(feature = "vpx")]
fn generate_vp9_probe_frame() -> Option<Vec<u8>> {
    use paracord_codec::video::{
        encoder::create_encoder, EncoderConfig, PixelFormat, VideoContentHint,
    };

    let config = EncoderConfig {
        width: 320,
        height: 180,
        fps: 30,
        bitrate_kbps: 500,
        pixel_format: PixelFormat::I420,
        keyframe_interval: 0,
        content_hint: VideoContentHint::Default,
    };
    let frame = vec![128u8; PixelFormat::I420.frame_size(320, 180)];
    let mut encoder = create_encoder(paracord_codec::video::VideoCodec::Vp9, config).ok()?;
    encoder
        .encode(0, &frame, true)
        .ok()?
        .into_iter()
        .find(|frame| frame.is_keyframe)
        .map(|frame| frame.data)
}

#[cfg(not(feature = "vpx"))]
fn generate_vp9_probe_frame() -> Option<Vec<u8>> {
    None
}
