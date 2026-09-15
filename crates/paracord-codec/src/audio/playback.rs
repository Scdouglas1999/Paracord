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

use super::aec::{ReferenceProducer, ReferenceRing};
use super::devices::{self, DeviceList, DeviceTarget, Direction};
use super::opus::{FRAME_SIZE, SAMPLE_RATE};

#[derive(Debug, Error)]
pub enum PlaybackError {
    #[error("no output device available")]
    NoOutputDevice,
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
    #[error("resampler error: {0}")]
    Resampler(String),
}

/// Enumerate speakers/headphones the way a person recognises them.
///
/// Delegates to [`devices::list_devices`], which asks the sound server for real
/// device names and stable node ids and only falls back to raw cpal PCM names
/// when no sound server answers (and says so when it does).
pub fn list_output_devices() -> Result<DeviceList, PlaybackError> {
    devices::list_devices(Direction::Output).map_err(PlaybackError::Device)
}

/// The raw, uncollapsed cpal enumeration: `(index, name, is_default)`.
///
/// On Linux these are ALSA PCM routes (`hdmi:CARD=NVidia,DEV=3`), not devices.
/// Kept for the naming fallback and for the before/after device-name proof;
/// user-facing code must use [`list_output_devices`].
pub fn list_output_devices_raw() -> Result<Vec<(usize, String, bool)>, PlaybackError> {
    devices::raw_cpal_devices(Direction::Output).map_err(PlaybackError::Device)
}

/// Watermark band for playout-depth drift control (contract AU14). Kept small so
/// end-to-end latency stays tight; the jitter buffer upstream absorbs network
/// jitter, this only trims the accumulated drift between the sender's and this
/// device's clocks. Expressed in milliseconds of device-rate audio.
const DRIFT_LOW_WATERMARK_MS: usize = 40;
const DRIFT_HIGH_WATERMARK_MS: usize = 60;

/// Internal buffer for a single audio source.
///
/// Samples are stored **interleaved stereo** at the device sample rate. Mono
/// voice sources are up-mixed to stereo by their forwarding task before they
/// reach here, so the output callback has a single uniform layout to mix.
struct SourceBuffer {
    /// Ring buffer of interleaved-stereo PCM samples at the device sample rate.
    samples: Vec<f32>,
    /// Read position in the ring buffer (sample index; always frame-aligned).
    read_pos: usize,
    /// Write position in the ring buffer (sample index; always frame-aligned).
    write_pos: usize,
    /// Total capacity in samples (even: two per stereo frame).
    capacity: usize,
    /// Per-source playback gain (contract AU4). 1.0 = unity.
    gain: f32,
    /// Low/high watermark in *frames* for drift control (contract AU14).
    low_watermark_frames: usize,
    high_watermark_frames: usize,
}

impl SourceBuffer {
    fn new(capacity: usize, device_sample_rate: u32) -> Self {
        // Round capacity down to an even number so it holds whole stereo frames.
        let capacity = capacity & !1;
        let low = (device_sample_rate as usize * DRIFT_LOW_WATERMARK_MS) / 1000;
        let high = (device_sample_rate as usize * DRIFT_HIGH_WATERMARK_MS) / 1000;
        Self {
            samples: vec![0.0; capacity],
            read_pos: 0,
            write_pos: 0,
            capacity,
            gain: 1.0,
            low_watermark_frames: low,
            high_watermark_frames: high,
        }
    }

    /// Available interleaved samples (two per stereo frame).
    fn available(&self) -> usize {
        if self.write_pos >= self.read_pos {
            self.write_pos - self.read_pos
        } else {
            self.capacity - self.read_pos + self.write_pos
        }
    }

    fn available_frames(&self) -> usize {
        self.available() / 2
    }

    /// Write interleaved-stereo data into the ring, discarding oldest frames on
    /// overflow (the 500 ms hard cap; the watermark below trims normal drift).
    fn write(&mut self, data: &[f32]) {
        for &sample in data {
            self.samples[self.write_pos] = sample;
            self.write_pos = (self.write_pos + 1) % self.capacity;
            // On overflow, discard a whole stereo frame (two samples) so the read
            // cursor stays frame-aligned. Advancing by one would flip read_pos
            // parity and permanently swap L/R for this source.
            if self.write_pos == self.read_pos {
                self.read_pos = (self.read_pos + 2) % self.capacity;
            }
        }
    }

    /// Read one interleaved-stereo frame, or `(0.0, 0.0)` on underrun.
    fn read_frame(&mut self) -> (f32, f32) {
        if self.read_pos == self.write_pos {
            return (0.0, 0.0); // underrun: silence
        }
        let l = self.samples[self.read_pos];
        let r = self.samples[(self.read_pos + 1) % self.capacity];
        self.read_pos = (self.read_pos + 2) % self.capacity;
        (l, r)
    }

    /// Drift correction (contract AU14): once per output block, nudge the read
    /// pointer by a single frame to keep the buffered depth inside the watermark
    /// band. Above the high watermark we drop one already-buffered frame; below
    /// the low watermark (but non-empty) we rewind one frame to replay it. The
    /// ring never zeroes read data, so the rewound frame is still valid.
    fn apply_drift(&mut self) {
        let avail = self.available_frames();
        if avail > self.high_watermark_frames {
            // Drop one frame.
            self.read_pos = (self.read_pos + 2) % self.capacity;
        } else if avail > 0 && avail < self.low_watermark_frames {
            // Duplicate one frame by rewinding the read cursor.
            self.read_pos = (self.read_pos + self.capacity - 2) % self.capacity;
        }
    }
}

/// Shared mixer state accessed by the audio output callback and the control API.
///
/// Note: the output resampler is intentionally **not** here. Each source owns
/// its own resampler on its forwarding task (contract AU7 — a single shared
/// `FftFixedIn` is stateful and corrupts audio when more than one source feeds
/// it), and resampling happens off the mixer lock (contract AU8).
struct MixerState {
    sources: HashMap<u32, SourceBuffer>,
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
    ///
    /// `reference` taps the mixer's rendered (post-mix) output into the AEC
    /// far-end ring; pass `None` to disable the tap (e.g. tests).
    pub fn start(reference: Option<Arc<ReferenceRing>>) -> Result<Self, PlaybackError> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or(PlaybackError::NoOutputDevice)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device = %device_name, "opening audio output device");

        Self::start_from_device(device, reference)
    }

    /// Start playback on a specific device, named by the stable id from
    /// [`list_output_devices`] (a sound-server node name, or a cpal PCM name on
    /// a machine with no sound server). A legacy cpal index string is still
    /// accepted so a selection saved by an older build keeps working.
    ///
    /// Returns the resolved [`DeviceTarget`] alongside the stream so the caller
    /// can tell the user when the device they asked for was gone and the system
    /// default was opened instead.
    pub fn start_device_id(
        id: &str,
        reference: Option<Arc<ReferenceRing>>,
    ) -> Result<(Self, DeviceTarget), PlaybackError> {
        let target =
            devices::resolve_target(Direction::Output, id).map_err(PlaybackError::Device)?;
        if target.fell_back_to_default {
            warn!(
                requested = %id,
                opened = %target.display_name,
                "selected speaker is gone; opening the system default instead"
            );
        }
        info!(device = %target.display_name, node = ?target.node, "opening audio output device");
        // Enumerate inside the targeting window: cpal's ALSA device iterator
        // opens (and caches) each PCM as it yields it, so a `Device` obtained
        // before the environment was set is a PCM that was already open with no
        // target. See the matching note in `capture::start_device_id`.
        let playback = devices::with_target_node(
            Direction::Output,
            target.node.as_deref(),
            || -> Result<_, PlaybackError> {
                let host = cpal::default_host();
                let device = host
                    .output_devices()?
                    .nth(target.cpal_index)
                    .ok_or(PlaybackError::NoOutputDevice)?;
                Self::start_from_device(device, reference)
            },
        )?;
        Ok((playback, target))
    }

    /// Start playback on an output device by cpal enumeration index.
    ///
    /// Retained for callers that already hold a raw index; prefer
    /// [`AudioPlayback::start_device_id`], whose identity survives a re-plug.
    pub fn start_device(
        index: usize,
        reference: Option<Arc<ReferenceRing>>,
    ) -> Result<Self, PlaybackError> {
        let host = cpal::default_host();
        let mut devices = host.output_devices()?;
        let device = devices.nth(index).ok_or(PlaybackError::NoOutputDevice)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());
        info!(device_index = index, device = %device_name, "opening selected audio output device");
        Self::start_from_device(device, reference)
    }

    pub fn start_from_device(
        device: Device,
        reference: Option<Arc<ReferenceRing>>,
    ) -> Result<Self, PlaybackError> {
        devices::silence_alsa_probe_errors();
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

        if device_sample_rate != SAMPLE_RATE {
            info!(
                from = SAMPLE_RATE,
                to = device_sample_rate,
                "output device is not 48kHz; sources will resample per-source"
            );
        }

        let mixer = Arc::new(Mutex::new(MixerState {
            sources: HashMap::new(),
        }));

        let stop_flag = Arc::new(AtomicBool::new(false));

        let mixer_ref = mixer.clone();
        let stop = stop_flag.clone();

        // Attach a far-end reference producer for this device (contract AEC4).
        // The producer carries the device rate so the AEC consumer resamples to
        // 48 kHz, and is epoch-gated so a prior device's callback stops writing.
        let reference_producer = reference.map(|ring| ring.attach_producer(device_sample_rate));

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
                build_output_callback::<f32>(mixer_ref, stop, device_channels, reference_producer),
                error_callback,
                None,
            )?,
            SampleFormat::I16 => device.build_output_stream(
                &stream_config,
                build_output_callback::<i16>(mixer_ref, stop, device_channels, reference_producer),
                error_callback,
                None,
            )?,
            _ => device.build_output_stream(
                &stream_config,
                build_output_callback::<f32>(mixer_ref, stop, device_channels, reference_producer),
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

    /// Add a new **mono** audio source (remote voice participant).
    ///
    /// Returns a sender that accepts 960-sample PCM f32 mono frames at 48 kHz.
    /// The source is identified by `source_id` (typically the participant's SSRC).
    pub fn add_source(&self, source_id: u32) -> mpsc::Sender<Vec<f32>> {
        self.add_source_channels(source_id, 1)
    }

    /// Add a new **stereo** audio source (screen / system audio, contract C4).
    ///
    /// Returns a sender that accepts 1920-sample interleaved-stereo f32 frames
    /// (960 frames × 2 channels) at 48 kHz.
    pub fn add_stream_source(&self, source_id: u32) -> mpsc::Sender<Vec<f32>> {
        self.add_source_channels(source_id, 2)
    }

    fn add_source_channels(&self, source_id: u32, in_channels: usize) -> mpsc::Sender<Vec<f32>> {
        let (tx, mut rx) = mpsc::channel::<Vec<f32>>(50);

        // Buffer capacity: ~500ms of interleaved-stereo at device sample rate.
        let buf_capacity = (self.device_sample_rate as usize).max(FRAME_SIZE * 2 * 10);

        {
            let mut mixer = self.mixer.lock().unwrap();
            mixer
                .sources
                .entry(source_id)
                .or_insert_with(|| SourceBuffer::new(buf_capacity, self.device_sample_rate));
        }

        let mixer = self.mixer.clone();
        let device_rate = self.device_sample_rate;

        // Per-source resampler (contract AU7): a fresh, private `FftFixedIn` so
        // multiple sources never share one stateful resampler. Fixed 960-frame
        // input (one 20ms frame), 2 channels — mono voice is up-mixed to stereo
        // first so every source resamples identically. Resampling runs OFF the
        // mixer lock (contract AU8); the lock is taken only to write the result.
        tokio::spawn(async move {
            let mut resampler: Option<FftFixedIn<f32>> = if device_rate != SAMPLE_RATE {
                match FftFixedIn::<f32>::new(
                    SAMPLE_RATE as usize,
                    device_rate as usize,
                    FRAME_SIZE,
                    1,
                    2,
                ) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        error!("failed to build per-source output resampler: {e}");
                        return;
                    }
                }
            } else {
                None
            };
            // Preallocated planar I/O so the hot path allocates nothing.
            let mut planar_in: [Vec<f32>; 2] = [vec![0.0; FRAME_SIZE], vec![0.0; FRAME_SIZE]];
            let mut interleaved_out: Vec<f32> = Vec::with_capacity(FRAME_SIZE * 2);

            while let Some(frame) = rx.recv().await {
                // Normalize to interleaved stereo at 48kHz.
                let stereo_48k: Vec<f32> = if in_channels == 1 {
                    let mut out = Vec::with_capacity(frame.len() * 2);
                    for &s in &frame {
                        out.push(s);
                        out.push(s);
                    }
                    out
                } else {
                    frame
                };

                // Resample (off-lock) if the device is not 48kHz.
                let output_samples = if let Some(resampler) = resampler.as_mut() {
                    // Deinterleave a full 20ms frame into the planar scratch.
                    let frames = stereo_48k.len() / 2;
                    if frames != FRAME_SIZE {
                        // The fixed-input resampler needs exactly one 20ms frame.
                        warn!(frames, "unexpected output frame size; dropping");
                        continue;
                    }
                    for i in 0..FRAME_SIZE {
                        planar_in[0][i] = stereo_48k[i * 2];
                        planar_in[1][i] = stereo_48k[i * 2 + 1];
                    }
                    match resampler.process(&planar_in, None) {
                        Ok(resampled) if resampled.len() == 2 => {
                            interleaved_out.clear();
                            interleaved_out.reserve(resampled[0].len() * 2);
                            for (l, r) in resampled[0].iter().zip(resampled[1].iter()) {
                                interleaved_out.push(*l);
                                interleaved_out.push(*r);
                            }
                            interleaved_out.as_slice()
                        }
                        Ok(_) => continue,
                        Err(e) => {
                            warn!("output resampler error: {e}");
                            continue;
                        }
                    }
                } else {
                    stereo_48k.as_slice()
                };

                // Brief lock: write only.
                let mut state = match mixer.lock() {
                    Ok(s) => s,
                    Err(_) => break,
                };
                if let Some(buf) = state.sources.get_mut(&source_id) {
                    buf.write(output_samples);
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

    /// Set a source's playback gain (contract AU4). Values are clamped to
    /// `0.0..=2.0` by the caller; a missing source is a no-op.
    pub fn set_source_gain(&self, source_id: u32, gain: f32) {
        if let Ok(mut mixer) = self.mixer.lock() {
            if let Some(buf) = mixer.sources.get_mut(&source_id) {
                buf.gain = gain;
            }
        }
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
    reference: Option<ReferenceProducer>,
) -> impl FnMut(&mut [S], &cpal::OutputCallbackInfo) + Send + 'static {
    // Reused scratch for the mono far-end reference of one callback block. Held
    // across calls so the hot path allocates nothing; the ring push is lock-free
    // (contract AEC4: no locking added to the render callback).
    let mut ref_scratch: Vec<f32> = Vec::with_capacity(2048);
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

        // One drift correction per source per output block (contract AU14),
        // applied before mixing so the depth trend is nudged toward the band.
        for source in state.sources.values_mut() {
            source.apply_drift();
        }

        let tapping_reference = reference.is_some();
        if tapping_reference {
            ref_scratch.clear();
        }

        for frame_idx in 0..num_frames {
            // Mix all sources in stereo, applying per-source gain.
            let mut mixed_l = 0.0f32;
            let mut mixed_r = 0.0f32;
            for source in state.sources.values_mut() {
                let (l, r) = source.read_frame();
                mixed_l += l * source.gain;
                mixed_r += r * source.gain;
            }

            // Apply soft clipping per channel.
            let clipped_l = soft_clip(mixed_l);
            let clipped_r = soft_clip(mixed_r);

            // Far-end reference = exactly what the speakers emit, downmixed to
            // mono (contract AEC4). Captured post-clip so the AEC models the true
            // played signal.
            if tapping_reference {
                ref_scratch.push((clipped_l + clipped_r) * 0.5);
            }

            let base = frame_idx * device_channels;
            match device_channels {
                1 => {
                    output[base] = S::from_f32_sample((clipped_l + clipped_r) * 0.5);
                }
                _ => {
                    output[base] = S::from_f32_sample(clipped_l);
                    output[base + 1] = S::from_f32_sample(clipped_r);
                    // Any extra channels (surround) get the downmixed center.
                    let center = (clipped_l + clipped_r) * 0.5;
                    for ch in 2..device_channels {
                        output[base + ch] = S::from_f32_sample(center);
                    }
                }
            }
        }

        // Publish this block's reference to the AEC ring (lock-free).
        if let Some(producer) = &reference {
            producer.push(&ref_scratch);
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
        // 48kHz device: watermarks are large so drift never fires in this test.
        let mut buf = SourceBuffer::new(1024, 48_000);
        assert_eq!(buf.available(), 0);
        assert_eq!(buf.read_frame(), (0.0, 0.0)); // underrun

        // Interleaved L/R frames.
        buf.write(&[1.0, -1.0, 2.0, -2.0, 3.0, -3.0]);
        assert_eq!(buf.available(), 6);
        assert_eq!(buf.read_frame(), (1.0, -1.0));
        assert_eq!(buf.read_frame(), (2.0, -2.0));
        assert_eq!(buf.read_frame(), (3.0, -3.0));
        assert_eq!(buf.available(), 0);
    }

    #[test]
    fn source_buffer_overflow() {
        let mut buf = SourceBuffer::new(4, 48_000);
        // Write more than capacity: oldest frames should be dropped.
        buf.write(&[1.0, 1.0, 2.0, 2.0, 3.0, 3.0]);
        assert!(buf.available() <= 4);
    }

    #[test]
    fn drift_drops_a_frame_above_the_high_watermark() {
        // Low device rate makes the watermark band tiny and easy to exceed.
        let mut buf = SourceBuffer::new(4000, 1000);
        // 1000Hz → high watermark = 60 frames. Fill well past it.
        let data: Vec<f32> = (0..200).flat_map(|i| [i as f32, i as f32]).collect();
        buf.write(&data);
        let before = buf.available_frames();
        buf.apply_drift();
        assert_eq!(buf.available_frames(), before - 1, "one frame dropped");
    }

    #[test]
    fn drift_duplicates_a_frame_below_the_low_watermark() {
        let mut buf = SourceBuffer::new(4000, 1000);
        // Only 10 frames buffered — below the 40-frame low watermark.
        let data: Vec<f32> = (0..10).flat_map(|i| [i as f32, i as f32]).collect();
        buf.write(&data);
        let before = buf.available_frames();
        buf.apply_drift();
        assert_eq!(buf.available_frames(), before + 1, "one frame duplicated");
    }

    #[test]
    fn gain_scales_mixed_output() {
        let mut buf = SourceBuffer::new(1024, 48_000);
        buf.gain = 0.5;
        buf.write(&[1.0, 1.0]);
        let (l, r) = buf.read_frame();
        assert_eq!((l * buf.gain, r * buf.gain), (0.5, 0.5));
    }
}
