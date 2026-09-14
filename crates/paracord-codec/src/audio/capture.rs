// cpal microphone capture (extends pattern from audio_capture.rs).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate as CpalSampleRate, Stream, StreamConfig};
use rubato::{FftFixedOut, Resampler};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::devices::{self, DeviceList, DeviceTarget, Direction};
use super::opus::SAMPLE_RATE;

/// Frame size: 20 ms at 48 kHz = 960 samples.
const TARGET_FRAME_SIZE: usize = 960;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("no input device available")]
    NoInputDevice,
    #[error("cpal device error: {0}")]
    Cpal(#[from] cpal::DevicesError),
    #[error("{0}")]
    Device(devices::DeviceError),
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

/// Enumerate microphones the way a person recognises them.
///
/// Delegates to [`devices::list_devices`], which asks the sound server for real
/// device names and stable node ids and only falls back to raw cpal PCM names
/// when no sound server answers (and says so when it does).
pub fn list_input_devices() -> Result<DeviceList, CaptureError> {
    devices::list_devices(Direction::Input).map_err(CaptureError::Device)
}

/// The raw, uncollapsed cpal enumeration: `(index, name, is_default)`.
///
/// On Linux these are ALSA PCM routes (`front:CARD=USB,DEV=0`), not devices —
/// several per card, and frequently missing the device the user wants. Kept for
/// the naming fallback and for the before/after device-name proof; user-facing
/// code must use [`list_input_devices`].
pub fn list_input_devices_raw() -> Result<Vec<(usize, String, bool)>, CaptureError> {
    devices::raw_cpal_devices(Direction::Input).map_err(CaptureError::Device)
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

    /// Start capturing from a specific device, named by the stable id from
    /// [`list_input_devices`] (a sound-server node name, or a cpal PCM name on a
    /// machine with no sound server). A legacy cpal index string is still
    /// accepted so a selection saved by an older build keeps working.
    ///
    /// Returns the resolved [`DeviceTarget`] alongside the stream so the caller
    /// can tell the user when the device they asked for was gone and the system
    /// default was opened instead.
    pub fn start_device_id(
        id: &str,
    ) -> Result<(Self, mpsc::Receiver<Vec<f32>>, DeviceTarget), CaptureError> {
        let target = devices::resolve_target(Direction::Input, id).map_err(CaptureError::Device)?;
        if target.fell_back_to_default {
            warn!(
                requested = %id,
                opened = %target.display_name,
                "selected microphone is gone; opening the system default instead"
            );
        }
        let host = cpal::default_host();
        let device = host
            .input_devices()?
            .nth(target.cpal_index)
            .ok_or(CaptureError::NoInputDevice)?;

        info!(device = %target.display_name, node = ?target.node, "opening audio input device");
        let (capture, rx) =
            devices::with_target_node(Direction::Input, target.node.as_deref(), || {
                Self::start_from_device(device)
            })?;
        Ok((capture, rx, target))
    }

    /// Start capturing from a cpal enumeration index.
    ///
    /// Retained for callers that already hold a raw index; prefer
    /// [`AudioCapture::start_device_id`], whose identity survives a re-plug.
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

        // Set up resampler if device rate != 48 kHz. It is owned by the capture
        // callback (below) — nothing else touches it — so it needs no Mutex; the
        // real-time audio thread must never lock (AU8).
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
            Some(resampler)
        } else {
            None
        };

        let stop = stop_flag.clone();

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
                    resampler,
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
                    resampler,
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
                    resampler,
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
                        resampler,
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
///
/// The accumulator and resampler are owned by the returned closure — no `Mutex`
/// is taken on the real-time audio thread (AU8). The resampler's fixed-input
/// scratch buffer is preallocated once and reused every frame.
fn build_data_callback<S: ToF32Sample + cpal::SizedSample>(
    mut resampler: Option<FftFixedOut<f32>>,
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

    // Owned callback state (no shared Mutex): accumulation buffer at device
    // rate, plus a preallocated single-channel input scratch for the resampler.
    let mut accumulator: Vec<f32> = Vec::with_capacity(target_frame * 2);
    let mut resample_in: Vec<f32> = vec![0.0; target_frame];

    move |data: &[S], _info: &cpal::InputCallbackInfo| {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }

        // Downmix to mono in place into the accumulator.
        if device_channels == 1 {
            accumulator.extend(data.iter().map(|s| s.to_f32_sample()));
        } else {
            accumulator.extend(data.chunks(device_channels).map(|frame| {
                let sum: f32 = frame.iter().map(|s| s.to_f32_sample()).sum();
                sum / device_channels as f32
            }));
        }

        // Emit complete frames
        while accumulator.len() >= target_frame {
            let output = if let Some(resampler) = resampler.as_mut() {
                // Resample to 48 kHz using the preallocated input scratch.
                resample_in.copy_from_slice(&accumulator[..target_frame]);
                accumulator.drain(..target_frame);
                let input = [&resample_in[..]];
                match resampler.process(&input, None) {
                    Ok(mut resampled)
                        if !resampled.is_empty() && resampled[0].len() == TARGET_FRAME_SIZE =>
                    {
                        resampled.swap_remove(0)
                    }
                    Ok(_) => continue,
                    Err(e) => {
                        warn!("resampler error: {e}");
                        continue;
                    }
                }
            } else {
                accumulator.drain(..target_frame).collect()
            };

            // Non-blocking send; drop frame if consumer is too slow
            if tx.try_send(output).is_err() {
                debug!("audio capture channel full, dropping frame");
            }
        }
    }
}
