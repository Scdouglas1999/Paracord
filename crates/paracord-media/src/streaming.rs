use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamConfig {
    pub max_bitrate_kbps: u32,
    pub max_framerate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamQualityPreset {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub framerate: u32,
    pub bitrate_kbps: u32,
}

pub fn quality_presets() -> Vec<StreamQualityPreset> {
    vec![
        StreamQualityPreset {
            name: "720p30".to_string(),
            width: 1280,
            height: 720,
            framerate: 30,
            bitrate_kbps: 2500,
        },
        StreamQualityPreset {
            name: "1080p60".to_string(),
            width: 1920,
            height: 1080,
            framerate: 60,
            bitrate_kbps: 6000,
        },
        StreamQualityPreset {
            name: "1440p60".to_string(),
            width: 2560,
            height: 1440,
            framerate: 60,
            bitrate_kbps: 10000,
        },
        StreamQualityPreset {
            name: "4k60".to_string(),
            width: 3840,
            height: 2160,
            framerate: 60,
            bitrate_kbps: 20000,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulcastLayer {
    pub rid: String,
    pub scale_resolution_down_by: f64,
    pub max_bitrate_kbps: u32,
}

/// Simulcast layers for adaptive quality.
pub fn simulcast_layers() -> Vec<SimulcastLayer> {
    vec![
        SimulcastLayer {
            rid: "q".to_string(),
            scale_resolution_down_by: 4.0,
            max_bitrate_kbps: 300,
        },
        SimulcastLayer {
            rid: "h".to_string(),
            scale_resolution_down_by: 2.0,
            max_bitrate_kbps: 1000,
        },
        SimulcastLayer {
            rid: "f".to_string(),
            scale_resolution_down_by: 1.0,
            max_bitrate_kbps: 6000,
        },
    ]
}

/// Metadata attached to a live stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub streamer_id: i64,
    pub title: String,
    pub application: Option<String>,
    pub started_at: i64,
    pub quality_preset: String,
}

/// Quality preference a viewer can select when watching a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ViewerQuality {
    #[default]
    Auto,
    Low,
    Medium,
    High,
    Source,
}

impl ViewerQuality {
    /// Map viewer quality preference to a simulcast layer RID.
    /// `Auto` returns None (let LiveKit decide based on bandwidth).
    pub fn to_simulcast_rid(self) -> Option<&'static str> {
        match self {
            ViewerQuality::Auto => None,
            ViewerQuality::Low => Some("q"),
            ViewerQuality::Medium => Some("h"),
            ViewerQuality::High | ViewerQuality::Source => Some("f"),
        }
    }
}

/// Video track configuration for screen capture publishing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenCaptureConfig {
    pub width: u32,
    pub height: u32,
    pub framerate: u32,
    pub bitrate_kbps: u32,
    pub simulcast: bool,
}

impl ScreenCaptureConfig {
    /// Create a config from a named quality preset.
    pub fn from_preset(preset_name: &str) -> Option<Self> {
        quality_presets().into_iter().find(|p| p.name == preset_name).map(|p| Self {
            width: p.width,
            height: p.height,
            framerate: p.framerate,
            bitrate_kbps: p.bitrate_kbps,
            simulcast: true,
        })
    }

    /// Default 1080p60 config.
    pub fn default_config() -> Self {
        Self {
            width: 1920,
            height: 1080,
            framerate: 60,
            bitrate_kbps: 6000,
            simulcast: true,
        }
    }
}
