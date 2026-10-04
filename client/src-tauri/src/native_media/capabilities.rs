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
    /// This window can draw remote video: its native host installed (see
    /// `native_render::renderer_status`). Remote video in the desktop app has no
    /// other route, so when this is false every codec's `decode` is false too and
    /// [`Self::native_renderer_error`] says why.
    pub native_desktop_renderer: bool,
    /// The surface composites BELOW the webview, which is true of every backend
    /// (Linux, macOS, Windows): DOM chrome renders over the video, and a tile
    /// punches a transparent hole where its video shows.
    #[serde(default)]
    pub native_render_underlay: bool,
    /// Why this window cannot draw video, when it cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_renderer_error: Option<String>,
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
/// MediaFoundation H.264/AV1 encoder says nothing about decode). The desktop
/// app shows remote video only through a native decoder and its native
/// surface, so this is all of "can this client display the codec".
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

    gate_on_renderer(video, super::native_render::renderer_status())
}

/// `decode` is advertised to the relay and drives codec negotiation, so it
/// means "this client can display the codec", not merely "Rust can decode it".
/// With no native renderer nothing can be displayed: every `decode` is false
/// and the reason travels with the capabilities.
fn gate_on_renderer(
    mut video: Vec<VideoCodecCapability>,
    renderer: Result<&'static str, String>,
) -> MediaStreamCapabilities {
    let error = renderer.err();
    if error.is_some() {
        for capability in &mut video {
            capability.decode = false;
            capability.decode_hardware = false;
        }
    }
    MediaStreamCapabilities {
        video,
        native_desktop_renderer: error.is_none(),
        native_render_underlay: error.is_none(),
        native_renderer_error: error,
        browser_interop_protocol_v1: true,
        real_media_e2ee: true,
        simulcast_v1: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vp9(decode: bool) -> VideoCodecCapability {
        VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: true,
            decode,
            encode_hardware: false,
            decode_hardware: decode,
        }
    }

    #[test]
    fn a_window_without_a_renderer_displays_nothing_and_says_why() {
        let caps = gate_on_renderer(vec![vp9(true)], Err("no GL".to_string()));
        assert!(!caps.native_desktop_renderer);
        assert!(!caps.native_render_underlay);
        assert_eq!(caps.native_renderer_error.as_deref(), Some("no GL"));
        assert!(!caps.video[0].decode && !caps.video[0].decode_hardware);
        assert!(caps.video[0].encode, "it can still stream");
    }

    #[test]
    fn a_window_with_a_renderer_keeps_its_native_decoders() {
        let caps = gate_on_renderer(vec![vp9(true)], Ok("test"));
        assert!(caps.native_desktop_renderer && caps.native_render_underlay);
        assert!(caps.native_renderer_error.is_none());
        assert!(caps.video[0].decode);
        let json = serde_json::to_value(&caps).unwrap();
        assert!(json.get("nativeRendererError").is_none());
    }
}
