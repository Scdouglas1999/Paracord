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
    pub hardware_accelerated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamCapabilities {
    pub video: Vec<VideoCodecCapability>,
    pub native_desktop_renderer: bool,
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
            hardware_accelerated: self.hardware_accelerated,
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
            hardware_accelerated: av1_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
        });
        let h264_probe = paracord_codec::video::encoder::MfH264Encoder::probe_backend(None).ok();
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::MediaFoundation,
            encode: h264_probe.is_some(),
            decode: native_decode_supported(VideoCodec::H264),
            hardware_accelerated: h264_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            hardware_accelerated: false,
        });
    }

    #[cfg(target_os = "macos")]
    {
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::VideoToolbox,
            encode: false,
            decode: native_decode_supported(VideoCodec::H264),
            hardware_accelerated: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            hardware_accelerated: false,
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::Vaapi,
            encode: false,
            decode: native_decode_supported(VideoCodec::H264),
            hardware_accelerated: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: native_decode_supported(VideoCodec::Vp9),
            hardware_accelerated: false,
        });
    }

    MediaStreamCapabilities {
        video,
        native_desktop_renderer: false,
        browser_interop_protocol_v1: true,
        real_media_e2ee: true,
        simulcast_v1: true,
    }
}
