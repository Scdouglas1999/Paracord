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

pub fn detect_media_stream_capabilities() -> MediaStreamCapabilities {
    let mut video = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let av1_probe = paracord_codec::video::encoder::MfAv1Encoder::probe_backend(None).ok();
        video.push(VideoCodecCapability {
            codec: VideoCodec::Av1,
            backend: VideoBackendKind::MediaFoundation,
            encode: av1_probe.is_some(),
            decode: av1_probe.is_some(),
            hardware_accelerated: av1_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
        });
        let h264_probe = paracord_codec::video::encoder::MfH264Encoder::probe_backend(None).ok();
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::MediaFoundation,
            encode: h264_probe.is_some(),
            decode: true,
            hardware_accelerated: h264_probe
                .map(|probe| probe.hardware_accelerated)
                .unwrap_or(false),
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: cfg!(feature = "vpx"),
            hardware_accelerated: false,
        });
    }

    #[cfg(target_os = "macos")]
    {
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::VideoToolbox,
            encode: false,
            decode: false,
            hardware_accelerated: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: cfg!(feature = "vpx"),
            hardware_accelerated: false,
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        video.push(VideoCodecCapability {
            codec: VideoCodec::H264,
            backend: VideoBackendKind::Vaapi,
            encode: false,
            decode: false,
            hardware_accelerated: false,
        });
        video.push(VideoCodecCapability {
            codec: VideoCodec::Vp9,
            backend: VideoBackendKind::LibVpx,
            encode: cfg!(feature = "vpx"),
            decode: cfg!(feature = "vpx"),
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
