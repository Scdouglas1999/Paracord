// cpal microphone capture (extends pattern from audio_capture.rs).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate as CpalSampleRate, Stream, StreamConfig};
use rubato::{FftFixedOut, Resampler};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::opus::SAMPLE_RATE;

/// Frame size: 20 ms at 48 kHz = 960 samples.
const TARGET_FRAME_SIZE: usize = 960;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("no input device available")]
    NoInputDevice,
    #[error("cpal device error: {0}")]
    Device(#[from] cpal::DevicesError),
    #[error("cpal default stream config error: {0}")]
    DefaultStreamConfig(#[from] cpal::DefaultStreamConfigError),
    #[error("cpal build stream error: {0}")]
    BuildStream(#[from] cpal::BuildStreamError),
    #[error("cpal play stream error: {0}")]
    PlayStream(#[from] cpal::PlayStreamError),
    #[error("no supported config for 48kHz mono")]
    NoSupportedConfig,
    #[error("resampler error: {0}")]
    Resampler(String),
}

/// Enumerate available audio input devices as `(index, name, is_default)`.
///
/// The `index` is the device's position in cpal's `input_devices()` iterator
/// and is exactly what [`AudioCapture::start_device`] consumes via `.nth(index)`.
/// These indices are enumeration-order only: they are assigned by iterating the
/// host's device list at call time and can shift if devices are added or removed
/// between calls (e.g. a USB microphone plugged in). Callers must therefore treat
/// an enumeration result and a subsequent switch as a paired operation — never
/// cache an index across device topology changes.
pub fn list_input_devices() -> Result<Vec<(usize, String, bool)>, CaptureError> {
    let host = cpal::default_host();
    // The default device name is used to flag the default entry. cpal exposes no
    // stable device identity, so name comparison is the only portable signal.
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());

    let mut devices = Vec::new();
    for (index, device) in host.input_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Device {index}"));
        let is_default = default_name.as_deref() == Some(name.as_str());
        devices.push((index, name, is_default));
    }
    Ok(devices)
}

/// Handle to a running audio capture session.
/// Dropping this stops the capture.
pub struct AudioCapture {
    _stream: Stream,
    stop_flag: Arc<AtomicBool>,
}

// SAFETY: `cpal::Stream` is `!Send` as a cross-platform precaution. On Windows
// (WASAPI) and Linux (PulseAudio) the underlying handles are thread-safe. The
// `_stream` field is only held for RAII lifetime management; we never call
// methods on it from another thread.
unsafe impl Send for AudioCapture {}
unsafe impl Sync for AudioCapture {}

impl AudioCapture {
    /// Start capturing audio from the default input device.
    ///
    /// Returns a receiver that yields 960-sample (20 ms) PCM f32 mono frames
    /// at 48 kHz, suitable for direct Opus encoding.
    ///
    /// The channel buffer holds up to 50 frames (~1 second) before backpressure.
    pub fn start() -> Result<(Self, mpsc::Receiver<Vec<f32>>), CaptureError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(CaptureError::NoInputDevice)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %device_name, "opening audio input device");

        Self::start_from_device(device)
    }

    /// Start capturing from a specific device (by index from `list_input_devices`).
    pub fn start_device(index: usize) -> Result<(Self, mpsc::Receiver<Vec<f32>>), CaptureError> {
        let host = cpal::default_host();
        let device = host
            .input_devices()?
            .nth(index)
            .ok_or(CaptureError::NoInputDevice)?;

        Self::start_from_device(device)
    }

    fn start_from_device(device: Device) -> Result<(Self, mpsc::Receiver<Vec<f32>>), CaptureError> {
        let config = device.default_input_config()?;
        let device_sample_rate = config.sample_rate().0;
        let device_channels = config.channels() as usize;
        let sample_format = config.sample_format();

        info!(
            sample_rate = device_sample_rate,
            channels = device_channels,
            format = ?sample_format,
            "device native config"
        );

        // Build stream config: use device native rate, mono if possible, else take what we get
        let stream_config = StreamConfig {
            channels: config.channels(),
            sample_rate: CpalSampleRate(device_sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let (tx, rx) = mpsc::channel::<Vec<f32>>(50);
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Calculate how many device samples correspond to one 20ms frame
        let device_frame_samples = (device_sample_rate as usize * 20) / 1000;

        // Set up resampler if device rate != 48 kHz
        let resampler = if device_sample_rate != SAMPLE_RATE {
            info!(
                from = device_sample_rate,
                to = SAMPLE_RATE,
                "will resample audio"
            );
            let resampler = FftFixedOut::<f32>::new(
                device_sample_rate as usize,
                SAMPLE_RATE as usize,
                TARGET_FRAME_SIZE,
                1, // sub_chunks
                1, // channels (mono after downmix)
            )
            .map_err(|e| CaptureError::Resampler(e.to_string()))?;
            Some(Arc::new(Mutex::new(resampler)))
        } else {
            None
        };

        // Accumulation buffer for incoming samples (mono, device rate)
        let accumulator = Arc::new(Mutex::new(Vec::<f32>::with_capacity(
            device_frame_samples * 2,
        )));

        let stop = stop_flag.clone();
        let acc = accumulator.clone();
        let resamp = resampler.clone();

        let error_callback = {
            let stop = stop_flag.clone();
            move |err: cpal::StreamError| {
                error!(%err, "audio capture stream error");
                if matches!(err, cpal::StreamError::DeviceNotAvailable) {
                    stop.store(true, Ordering::SeqCst);
                }
            }
        };

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                build_data_callback::<f32>(
                    acc,
                    resamp,
                    tx.clone(),
                    stop,
                    device_channels,
                    device_sample_rate,
                ),
                error_callback,
                None,
            )?,
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                build_data_callback::<i16>(
                    acc,
                    resamp,
                    tx.clone(),
                    stop,
                    device_channels,
                    device_sample_rate,
                ),
                error_callback,
                None,
            )?,
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                build_data_callback::<u16>(
                    acc,
                    resamp,
                    tx.clone(),
                    stop,
                    device_channels,
                    device_sample_rate,
                ),
                error_callback,
                None,
            )?,
            _ => {
                warn!(format = ?sample_format, "unsupported sample format, trying f32");
                device.build_input_stream(
                    &stream_config,
                    build_data_callback::<f32>(
                        acc,
                        resamp,
                        tx.clone(),
                        stop,
                        device_channels,
                        device_sample_rate,
                    ),
                    error_callback,
                    None,
                )?
            }
        };

        stream.play()?;
        info!("audio capture started");

        Ok((
            Self {
                _stream: stream,
                stop_flag,
            },
            rx,
        ))
    }

    /// Check if the capture is still running.
    pub fn is_running(&self) -> bool {
        !self.stop_flag.load(Ordering::SeqCst)
    }

    /// Stop capturing (also happens on drop).
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        debug!("audio capture dropped");
    }
}

/// Convert a sample from any cpal-supported type to f32.
trait ToF32Sample {
    fn to_f32_sample(self) -> f32;
}

impl ToF32Sample for f32 {
    #[inline]
    fn to_f32_sample(self) -> f32 {
        self
    }
}

impl ToF32Sample for i16 {
    #[inline]
    fn to_f32_sample(self) -> f32 {
        self as f32 / 32768.0
    }
}

impl ToF32Sample for u16 {
    #[inline]
    fn to_f32_sample(self) -> f32 {
        (self as f32 / 32768.0) - 1.0
    }
}

/// Build the cpal data callback for a given sample type.
fn build_data_callback<S: ToF32Sample + cpal::SizedSample>(
    accumulator: Arc<Mutex<Vec<f32>>>,
    resampler: Option<Arc<Mutex<FftFixedOut<f32>>>>,
    tx: mpsc::Sender<Vec<f32>>,
    stop_flag: Arc<AtomicBool>,
    device_channels: usize,
    device_sample_rate: u32,
) -> impl FnMut(&[S], &cpal::InputCallbackInfo) + Send + 'static {
    let target_frame = if resampler.is_some() {
        // For resampler: we need to know how many input samples produce TARGET_FRAME_SIZE output
        // FftFixedOut takes variable input, produces fixed output
        // We accumulate and let the resampler pull what it needs
        (device_sample_rate as usize * 20) / 1000 // device samples per 20ms
    } else {
        TARGET_FRAME_SIZE // 960 at 48kHz
    };

    move |data: &[S], _info: &cpal::InputCallbackInfo| {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }

        // Downmix to mono
        let mono: Vec<f32> = if device_channels == 1 {
            data.iter().map(|s| s.to_f32_sample()).collect()
        } else {
            data.chunks(device_channels)
                .map(|frame| {
                    let sum: f32 = frame.iter().map(|s| s.to_f32_sample()).sum();
                    sum / device_channels as f32
                })
                .collect()
        };

        let mut acc = match accumulator.lock() {
            Ok(acc) => acc,
            Err(_) => return,
        };

        acc.extend_from_slice(&mono);

        // Emit complete frames
        while acc.len() >= target_frame {
            let frame_data: Vec<f32> = acc.drain(..target_frame).collect();

            let output = if let Some(ref resampler) = resampler {
                // Resample to 48 kHz
                if let Ok(mut r) = resampler.lock() {
                    let input = vec![frame_data];
                    match r.process(&input, None) {
                        Ok(resampled) => {
                            if !resampled.is_empty() && resampled[0].len() == TARGET_FRAME_SIZE {
                                resampled.into_iter().next().unwrap()
                            } else {
                                continue;
                            }
                        }
                        Err(e) => {
                            warn!("resampler error: {e}");
                            continue;
                        }
                    }
                } else {
                    continue;
                }
            } else {
                frame_data
            };

            // Non-blocking send; drop frame if consumer is too slow
            if tx.try_send(output).is_err() {
                debug!("audio capture channel full, dropping frame");
            }
        }
    }
}
