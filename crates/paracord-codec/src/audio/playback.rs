// cpal speaker output with per-source mixing.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate as CpalSampleRate, Stream, StreamConfig};
use rubato::{FftFixedIn, Resampler};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::opus::{FRAME_SIZE, SAMPLE_RATE};

#[derive(Debug, Error)]
pub enum PlaybackError {
    #[error("no output device available")]
    NoOutputDevice,
    #[error("cpal device error: {0}")]
    Device(#[from] cpal::DevicesError),
    #[error("cpal default stream config error: {0}")]
    DefaultStreamConfig(#[from] cpal::DefaultStreamConfigError),
    #[error("cpal build stream error: {0}")]
    BuildStream(#[from] cpal::BuildStreamError),
    #[error("cpal play stream error: {0}")]
    PlayStream(#[from] cpal::PlayStreamError),
    #[error("resampler error: {0}")]
    Resampler(String),
}

/// Enumerate available audio output devices as `(index, name, is_default)`.
///
/// The `index` is the device's position in cpal's `output_devices()` iterator
/// and is exactly what [`AudioPlayback::start_device`] consumes via `.nth(index)`.
/// These indices are enumeration-order only: they are assigned by iterating the
/// host's device list at call time and can shift if devices are added or removed
/// between calls (e.g. a USB headset plugged in). Callers must therefore treat an
/// enumeration result and a subsequent switch as a paired operation — never cache
/// an index across device topology changes.
pub fn list_output_devices() -> Result<Vec<(usize, String, bool)>, PlaybackError> {
    let host = cpal::default_host();
    // The default device name is used to flag the default entry. cpal exposes no
    // stable device identity, so name comparison is the only portable signal.
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());

    let mut devices = Vec::new();
    for (index, device) in host.output_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Device {index}"));
        let is_default = default_name.as_deref() == Some(name.as_str());
        devices.push((index, name, is_default));
    }
    Ok(devices)
}

/// Internal buffer for a single audio source.
struct SourceBuffer {
    /// Ring buffer of PCM samples ready for playback (at device sample rate).
    samples: Vec<f32>,
    /// Read position in the ring buffer.
    read_pos: usize,
    /// Write position in the ring buffer.
    write_pos: usize,
    /// Total capacity.
    capacity: usize,
}

impl SourceBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            samples: vec![0.0; capacity],
            read_pos: 0,
            write_pos: 0,
            capacity,
        }
    }

    fn available(&self) -> usize {
        if self.write_pos >= self.read_pos {
            self.write_pos - self.read_pos
        } else {
            self.capacity - self.read_pos + self.write_pos
        }
    }

    fn write(&mut self, data: &[f32]) {
        for &sample in data {
            self.samples[self.write_pos] = sample;
            self.write_pos = (self.write_pos + 1) % self.capacity;
            // If we overflow, advance read_pos (discard oldest)
            if self.write_pos == self.read_pos {
                self.read_pos = (self.read_pos + 1) % self.capacity;
            }
        }
    }

    fn read(&mut self) -> f32 {
        if self.read_pos == self.write_pos {
            return 0.0; // underrun: silence
        }
        let sample = self.samples[self.read_pos];
        self.read_pos = (self.read_pos + 1) % self.capacity;
        sample
    }
}

/// Shared mixer state accessed by the audio output callback and the control API.
struct MixerState {
    sources: HashMap<u32, SourceBuffer>,
    /// Optional resampler from 48kHz to device rate (if device is not 48kHz).
    resampler: Option<FftFixedIn<f32>>,
}

/// Audio playback engine that mixes multiple participant streams.
pub struct AudioPlayback {
    _stream: Stream,
    mixer: Arc<Mutex<MixerState>>,
    stop_flag: Arc<AtomicBool>,
    device_sample_rate: u32,
}

// SAFETY: `cpal::Stream` is `!Send` as a cross-platform precaution. On Windows
// (WASAPI) and Linux (PulseAudio) the underlying handles are thread-safe. The
// `_stream` field is only held for RAII lifetime management; we never call
// methods on it from another thread.
unsafe impl Send for AudioPlayback {}
unsafe impl Sync for AudioPlayback {}

impl AudioPlayback {
    /// Start playback on the default output device.
    pub fn start() -> Result<Self, PlaybackError> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or(PlaybackError::NoOutputDevice)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %device_name, "opening audio output device");

        Self::start_from_device(device)
    }

    /// Start playback on an output device by host index.
    pub fn start_device(index: usize) -> Result<Self, PlaybackError> {
        let host = cpal::default_host();
        let mut devices = host.output_devices()?;
        let device = devices.nth(index).ok_or(PlaybackError::NoOutputDevice)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device_index = index, device = %device_name, "opening selected audio output device");
        Self::start_from_device(device)
    }

    pub fn start_from_device(device: Device) -> Result<Self, PlaybackError> {
        let config = device.default_output_config()?;
        let device_sample_rate = config.sample_rate().0;
        let device_channels = config.channels() as usize;
        let sample_format = config.sample_format();

        info!(
            sample_rate = device_sample_rate,
            channels = device_channels,
            format = ?sample_format,
            "output device config"
        );

        let stream_config = StreamConfig {
            channels: config.channels(),
            sample_rate: CpalSampleRate(device_sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        // Set up resampler if device rate != 48 kHz
        let resampler = if device_sample_rate != SAMPLE_RATE {
            info!(
                from = SAMPLE_RATE,
                to = device_sample_rate,
                "will resample output"
            );
            let r = FftFixedIn::<f32>::new(
                SAMPLE_RATE as usize,
                device_sample_rate as usize,
                FRAME_SIZE,
                1,
                1,
            )
            .map_err(|e| PlaybackError::Resampler(e.to_string()))?;
            Some(r)
        } else {
            None
        };

        let mixer = Arc::new(Mutex::new(MixerState {
            sources: HashMap::new(),
            resampler,
        }));

        let stop_flag = Arc::new(AtomicBool::new(false));

        let mixer_ref = mixer.clone();
        let stop = stop_flag.clone();

        let error_callback = {
            let stop = stop_flag.clone();
            move |err: cpal::StreamError| {
                error!(%err, "audio playback stream error");
                if matches!(err, cpal::StreamError::DeviceNotAvailable) {
                    stop.store(true, Ordering::SeqCst);
                }
            }
        };

        let stream = match sample_format {
            SampleFormat::F32 => device.build_output_stream(
                &stream_config,
                build_output_callback::<f32>(mixer_ref, stop, device_channels),
                error_callback,
                None,
            )?,
            SampleFormat::I16 => device.build_output_stream(
                &stream_config,
                build_output_callback::<i16>(mixer_ref, stop, device_channels),
                error_callback,
                None,
            )?,
            _ => device.build_output_stream(
                &stream_config,
                build_output_callback::<f32>(mixer_ref, stop, device_channels),
                error_callback,
                None,
            )?,
        };

        stream.play()?;
        info!("audio playback started");

        Ok(Self {
            _stream: stream,
            mixer,
            stop_flag,
            device_sample_rate,
        })
    }

    /// Add a new audio source (remote participant).
    ///
    /// Returns a sender that accepts 960-sample PCM f32 mono frames at 48 kHz.
    /// The source is identified by `source_id` (typically the participant's SSRC).
    pub fn add_source(&self, source_id: u32) -> mpsc::Sender<Vec<f32>> {
        let (tx, mut rx) = mpsc::channel::<Vec<f32>>(50);

        // Buffer capacity: ~500ms at device sample rate
        let buf_capacity = (self.device_sample_rate as usize / 2).max(FRAME_SIZE * 10);

        {
            let mut mixer = self.mixer.lock().unwrap();
            mixer
                .sources
                .entry(source_id)
                .or_insert_with(|| SourceBuffer::new(buf_capacity));
        }

        let mixer = self.mixer.clone();
        let device_rate = self.device_sample_rate;

        // Spawn a task to move frames from the channel into the source buffer
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let mut state = match mixer.lock() {
                    Ok(s) => s,
                    Err(_) => break,
                };

                // Resample if needed
                let output_samples = if device_rate != SAMPLE_RATE {
                    if let Some(ref mut resampler) = state.resampler {
                        let input = vec![frame];
                        match resampler.process(&input, None) {
                            Ok(resampled) => {
                                if !resampled.is_empty() {
                                    resampled.into_iter().next().unwrap()
                                } else {
                                    continue;
                                }
                            }
                            Err(e) => {
                                warn!("output resampler error: {e}");
                                continue;
                            }
                        }
                    } else {
                        frame
                    }
                } else {
                    frame
                };

                if let Some(buf) = state.sources.get_mut(&source_id) {
                    buf.write(&output_samples);
                }
            }

            // Source channel closed: remove from mixer
            if let Ok(mut state) = mixer.lock() {
                state.sources.remove(&source_id);
                debug!(source_id, "removed audio source");
            }
        });

        tx
    }

    /// Remove a source by ID.
    pub fn remove_source(&self, source_id: u32) {
        if let Ok(mut mixer) = self.mixer.lock() {
            mixer.sources.remove(&source_id);
            debug!(source_id, "removed audio source");
        }
    }

    /// Check if playback is running.
    pub fn is_running(&self) -> bool {
        !self.stop_flag.load(Ordering::SeqCst)
    }

    /// Stop playback.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

impl Drop for AudioPlayback {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        debug!("audio playback dropped");
    }
}

/// Soft clipping function using tanh-like curve.
/// Maps any input to the range (-1.0, 1.0) while preserving small signals linearly.
#[inline]
fn soft_clip(sample: f32) -> f32 {
    if sample.abs() <= 0.75 {
        sample
    } else {
        // Rational saturation curve: approaches ±1.0 asymptotically
        let s = sample.signum();
        let x = (sample.abs() - 0.75) * 4.0;
        s * (0.75 + 0.25 * x / (1.0 + x))
    }
}

trait FromF32Sample: cpal::SizedSample {
    fn from_f32_sample(s: f32) -> Self;
}

impl FromF32Sample for f32 {
    #[inline]
    fn from_f32_sample(s: f32) -> Self {
        s
    }
}

impl FromF32Sample for i16 {
    #[inline]
    fn from_f32_sample(s: f32) -> Self {
        (s * 32767.0).clamp(-32768.0, 32767.0) as i16
    }
}

/// Build the cpal output callback.
fn build_output_callback<S: FromF32Sample>(
    mixer: Arc<Mutex<MixerState>>,
    stop_flag: Arc<AtomicBool>,
    device_channels: usize,
) -> impl FnMut(&mut [S], &cpal::OutputCallbackInfo) + Send + 'static {
    move |output: &mut [S], _info: &cpal::OutputCallbackInfo| {
        if stop_flag.load(Ordering::Relaxed) {
            // Fill with silence
            for s in output.iter_mut() {
                *s = S::from_f32_sample(0.0);
            }
            return;
        }

        let mut state = match mixer.lock() {
            Ok(s) => s,
            Err(_) => {
                for s in output.iter_mut() {
                    *s = S::from_f32_sample(0.0);
                }
                return;
            }
        };

        let num_frames = output.len() / device_channels;

        for frame_idx in 0..num_frames {
            // Mix all sources
            let mut mixed = 0.0f32;
            for source in state.sources.values_mut() {
                if source.available() > 0 {
                    mixed += source.read();
                }
            }

            // Apply soft clipping
            let clipped = soft_clip(mixed);

            // Write to all output channels (mono -> duplicate to all channels)
            for ch in 0..device_channels {
                output[frame_idx * device_channels + ch] = S::from_f32_sample(clipped);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_clip_preserves_small_signals() {
        // Small signals should pass through nearly unchanged
        assert!((soft_clip(0.0) - 0.0).abs() < 1e-6);
        assert!((soft_clip(0.5) - 0.5).abs() < 1e-6);
        assert!((soft_clip(-0.5) - (-0.5)).abs() < 1e-6);
        assert!((soft_clip(0.75) - 0.75).abs() < 1e-6);
    }

    #[test]
    fn soft_clip_limits_large_signals() {
        // Large signals should be clipped below +-1.0
        assert!(soft_clip(2.0).abs() < 1.0);
        assert!(soft_clip(-2.0).abs() < 1.0);
        assert!(soft_clip(10.0).abs() < 1.0);
    }

    #[test]
    fn soft_clip_is_monotonic() {
        // Should be monotonically increasing
        let mut prev = soft_clip(-5.0);
        for i in -49..50 {
            let x = i as f32 / 10.0;
            let y = soft_clip(x);
            assert!(y >= prev, "soft_clip not monotonic at {x}: {y} < {prev}");
            prev = y;
        }
    }

    #[test]
    fn source_buffer_basic() {
        let mut buf = SourceBuffer::new(1024);
        assert_eq!(buf.available(), 0);
        assert_eq!(buf.read(), 0.0); // underrun

        buf.write(&[1.0, 2.0, 3.0]);
        assert_eq!(buf.available(), 3);
        assert_eq!(buf.read(), 1.0);
        assert_eq!(buf.read(), 2.0);
        assert_eq!(buf.read(), 3.0);
        assert_eq!(buf.available(), 0);
    }

    #[test]
    fn source_buffer_overflow() {
        let mut buf = SourceBuffer::new(4);
        // Write more than capacity: oldest samples should be dropped
        buf.write(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        // Buffer should contain the most recent samples that fit
        assert!(buf.available() <= 4);
    }
}
