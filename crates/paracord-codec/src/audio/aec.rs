//! Acoustic echo cancellation (AEC) and automatic gain control (AGC) for the
//! microphone send path.
//!
//! # Why SpeexDSP
//! The preferred option, `webrtc-audio-processing` (AEC3), links the WebRTC
//! Audio Processing Module. Its bundled build needs meson + ninja + abseil and
//! a C++17 toolchain — meson is not even present on this build host, and
//! requiring it on Linux/macOS/Windows is not a sane cross-platform story. The
//! SpeexDSP MDF echo canceller + preprocessor, on the other hand, is vendored
//! and statically linked by `aec-rs-sys` via CMake (no system libspeexdsp), so
//! it builds everywhere a C toolchain + CMake exists. It ships the same class of
//! adaptive-filter AEC plus an AGC in one library, which is exactly what this
//! path needs. That is the deterministic choice made here.
//!
//! # Pipeline position (contract AEC4)
//! `capture -> AEC -> AGC -> RNNoise (if enabled) -> Opus`. The echo canceller
//! runs first (it needs the raw mic, not a denoised one — RNNoise would distort
//! the echo path and break filter convergence), then the SpeexDSP preprocessor
//! applies residual-echo suppression, then a conservative feed-forward AGC, then
//! RNNoise, then Opus.
//!
//! # AGC
//! SpeexDSP's own AGC is only compiled in the **floating-point** build; the
//! vendored libspeexdsp is fixed-point (`FIXED_POINT=1`, the only configuration
//! `aec-rs-sys` builds), so its `SPEEX_PREPROCESS_SET_AGC*` ctls are absent and
//! return "unknown request". Rather than fork the sys crate to force a
//! float build (speex's AGC is also widely considered to pump), the AGC here is
//! a small, deterministic Rust feed-forward gain stage targeting ~-18 dBFS with
//! a noise gate and conservative attack/release (contract AEC2).
//!
//! # Far-end reference
//! The reference signal is the native mixer's *rendered* output (what the
//! speakers actually emit). It is tapped in the audio output callback and handed
//! across a lock-free SPSC ring ([`ReferenceRing`]) so the real-time render
//! thread never blocks. The mic send task drains it, resamples the device-rate
//! reference to 48 kHz, and feeds it to the canceller alongside each mic frame.
//! The MDF adaptive filter absorbs the (positive) output-buffer + acoustic delay
//! within its tail; no manual sample-accurate alignment is required.

use std::os::raw::{c_int, c_void};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use rubato::{FftFixedOut, Resampler};

use super::opus::{FRAME_SIZE, SAMPLE_RATE};

use aec_rs_sys as sys;

/// Adaptive-filter tail length in samples at 48 kHz (~100 ms). Covers the round
/// trip of output buffering + the acoustic path for laptop/desktop speakers;
/// longer tails cost CPU without helping typical desktop echo geometry.
const FILTER_LENGTH: c_int = (SAMPLE_RATE as c_int) / 10;

/// AGC target level: RMS of ~-18 dBFS, i.e. `10^(-18/20)` (contract AEC2).
const AGC_TARGET_RMS: f32 = 0.125_892_54;
/// Conservative gain ceiling (+20 dB) so quiet noise is never boosted to full
/// scale, and floor (-12 dB) so loud input is tamed rather than clipped.
const AGC_MAX_GAIN: f32 = 10.0;
const AGC_MIN_GAIN: f32 = 0.251_188_64;
/// Noise gate (~-50 dBFS RMS): below this the frame is treated as silence/noise
/// and the gain is held, so the AGC never pumps up a quiet background.
const AGC_GATE_RMS: f32 = 0.003_162_278;
/// Per-frame smoothing toward the desired gain. Decreasing gain (signal got
/// louder) reacts faster to avoid clipping; increasing gain is slow to avoid
/// audible pumping. Both are gentle (contract AEC2: conservative).
const AGC_ATTACK: f32 = 0.10;
const AGC_RELEASE: f32 = 0.03;

/// Residual-echo attenuation applied by the preprocessor (negative dB), idle and
/// during near-end speech respectively.
const ECHO_SUPPRESS_DB: c_int = -40;
const ECHO_SUPPRESS_ACTIVE_DB: c_int = -15;

/// Capacity of the far-end reference ring in samples. ~0.5 s at 192 kHz / 2 s at
/// 48 kHz — the consumer drains it every 20 ms, so this is pure jitter margin.
pub const REFERENCE_RING_CAPACITY: usize = 96_000;

/// Upper bound on the consumer's 48 kHz reference backlog, in frames. Playback
/// and capture are both real-time so backlog normally stays near zero; this only
/// trims a pathological drift so the reference stays time-current with the mic
/// (a lagging reference would fall outside the filter tail and defeat the AEC).
const MAX_REFERENCE_BACKLOG_FRAMES: usize = 8;

// ---------------------------------------------------------------------------
// Echo canceller + AGC
// ---------------------------------------------------------------------------

/// SpeexDSP echo canceller + preprocessor bound to one mic stream.
///
/// Owns two Speex heap handles. Both toggles default ON (contract AEC3). The
/// canceller processes one 20 ms mono frame (`FRAME_SIZE` samples at 48 kHz) at
/// a time, matching the Opus frame the send task encodes.
pub struct EchoCanceller {
    echo: *mut sys::SpeexEchoState,
    preprocess: *mut sys::SpeexPreprocessState,
    frame_size: usize,
    aec_enabled: bool,
    agc_enabled: bool,
    /// Current smoothed AGC gain (1.0 = unity).
    agc_gain: f32,
    rec_i16: Vec<i16>,
    ref_i16: Vec<i16>,
    out_i16: Vec<i16>,
}

// SAFETY: the Speex states are heap handles reached only through this struct.
// An `EchoCanceller` is created inside, and never leaves, the single mic send
// task; it is `Send` so that task's future is `Send`, but it is never shared
// between threads, so no interior state is touched concurrently. (Mirrors the
// treatment of the audiopus `OpusEncoder` held in the same task.)
unsafe impl Send for EchoCanceller {}

impl EchoCanceller {
    /// Create a canceller for the standard 20 ms / 48 kHz voice frame.
    pub fn new() -> Self {
        Self::with_frame_size(FRAME_SIZE)
    }

    /// Create a canceller for a custom frame size (samples at 48 kHz). Used by
    /// tests; the send task always uses [`EchoCanceller::new`].
    pub fn with_frame_size(frame_size: usize) -> Self {
        // SAFETY: FFI init calls; the returned handles are non-null on success
        // and are only ever passed back to the matching Speex functions.
        let (echo, preprocess) = unsafe {
            let echo = sys::speex_echo_state_init(frame_size as c_int, FILTER_LENGTH);
            let mut rate: c_int = SAMPLE_RATE as c_int;
            sys::speex_echo_ctl(
                echo,
                sys::SPEEX_ECHO_SET_SAMPLING_RATE as c_int,
                &mut rate as *mut c_int as *mut c_void,
            );
            let preprocess =
                sys::speex_preprocess_state_init(frame_size as c_int, SAMPLE_RATE as c_int);
            (echo, preprocess)
        };

        let this = Self {
            echo,
            preprocess,
            frame_size,
            aec_enabled: true,
            agc_enabled: true,
            agc_gain: 1.0,
            rec_i16: vec![0; frame_size],
            ref_i16: vec![0; frame_size],
            out_i16: vec![0; frame_size],
        };
        this.configure_preprocess();
        this
    }

    fn ctl_i32(&self, request: u32, mut value: c_int) {
        // SAFETY: `preprocess` is a live handle; the ctl reads a single c_int.
        unsafe {
            sys::speex_preprocess_ctl(
                self.preprocess,
                request as c_int,
                &mut value as *mut c_int as *mut c_void,
            );
        }
    }

    /// (Re)apply all preprocessor settings. Cheap; called on construction and
    /// whenever the AEC toggle flips (it relinks the echo state).
    fn configure_preprocess(&self) {
        // RNNoise owns noise suppression downstream; keep Speex denoise OFF so
        // the two do not fight (contract AEC4).
        self.ctl_i32(sys::SPEEX_PREPROCESS_SET_DENOISE, 0);

        // Residual-echo suppression only makes sense while the canceller is
        // engaged. Speex reads this ctl's pointer *as* the echo state, so pass
        // the handle directly (null unlinks it).
        let echo_ptr: *mut c_void = if self.aec_enabled {
            self.echo as *mut c_void
        } else {
            std::ptr::null_mut()
        };
        // SAFETY: live preprocess handle; value is the echo handle by value.
        unsafe {
            sys::speex_preprocess_ctl(
                self.preprocess,
                sys::SPEEX_PREPROCESS_SET_ECHO_STATE as c_int,
                echo_ptr,
            );
        }
        self.ctl_i32(sys::SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, ECHO_SUPPRESS_DB);
        self.ctl_i32(
            sys::SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE,
            ECHO_SUPPRESS_ACTIVE_DB,
        );
        // NOTE: AGC is intentionally NOT configured through Speex here — it is
        // compiled out of the fixed-point libspeexdsp build (see module docs).
        // The AGC below is a self-contained Rust stage in `apply_agc`.
    }

    /// Conservative feed-forward AGC (contract AEC2). Adapts a smoothed gain so
    /// the frame RMS approaches ~-18 dBFS, gated so silence/noise is never
    /// boosted, and soft-clipped so gain changes never introduce hard clipping.
    fn apply_agc(&mut self, buf: &mut [f32]) {
        if buf.is_empty() {
            return;
        }
        let rms = (buf.iter().map(|s| s * s).sum::<f32>() / buf.len() as f32).sqrt();
        if rms > AGC_GATE_RMS {
            let desired = (AGC_TARGET_RMS / rms).clamp(AGC_MIN_GAIN, AGC_MAX_GAIN);
            // Faster when reducing gain (signal got loud) than when raising it.
            let step = if desired < self.agc_gain {
                AGC_ATTACK
            } else {
                AGC_RELEASE
            };
            self.agc_gain += (desired - self.agc_gain) * step;
        }
        for s in buf.iter_mut() {
            *s = soft_clip(*s * self.agc_gain);
        }
    }

    /// Enable/disable echo cancellation at runtime (contract AEC3). Relinks the
    /// residual-echo suppressor to match.
    pub fn set_echo_cancellation(&mut self, enabled: bool) {
        if self.aec_enabled != enabled {
            self.aec_enabled = enabled;
            self.configure_preprocess();
        }
    }

    /// Enable/disable AGC at runtime (contract AEC3). Resets the smoothed gain
    /// to unity on disable so a re-enable starts clean.
    pub fn set_agc(&mut self, enabled: bool) {
        if self.agc_enabled != enabled {
            self.agc_enabled = enabled;
            if !enabled {
                self.agc_gain = 1.0;
            }
        }
    }

    pub fn is_echo_cancellation_enabled(&self) -> bool {
        self.aec_enabled
    }

    pub fn is_agc_enabled(&self) -> bool {
        self.agc_enabled
    }

    /// Process one mic frame against the aligned far-end reference frame.
    ///
    /// `mic` must be exactly `frame_size` samples of 48 kHz mono f32 in [-1, 1].
    /// `reference` is the far-end (rendered playback) for the same instant; it is
    /// zero-filled if short (startup underrun => silent far-end => no echo to
    /// subtract). Returns the cleaned frame (echo removed + AGC applied).
    pub fn process(&mut self, mic: &[f32], reference: &[f32]) -> Vec<f32> {
        debug_assert_eq!(mic.len(), self.frame_size, "mic frame must be frame_size");

        // Both stages off => deterministic passthrough (no hidden processing).
        if !self.aec_enabled && !self.agc_enabled {
            return mic.to_vec();
        }

        f32_to_i16(mic, &mut self.rec_i16);

        if self.aec_enabled {
            fill_i16_from_f32(reference, &mut self.ref_i16);
            // SAFETY: all three buffers are `frame_size` long and the handle is
            // live; Speex reads rec/play and writes out in place.
            unsafe {
                sys::speex_echo_cancellation(
                    self.echo,
                    self.rec_i16.as_ptr(),
                    self.ref_i16.as_ptr(),
                    self.out_i16.as_mut_ptr(),
                );
            }
        } else {
            self.out_i16.copy_from_slice(&self.rec_i16);
        }

        // Residual-echo suppression (only meaningful when AEC is linked), in
        // place. SAFETY: live handle; `out_i16` is `frame_size` long.
        if self.aec_enabled {
            unsafe {
                sys::speex_preprocess_run(self.preprocess, self.out_i16.as_mut_ptr());
            }
        }

        let mut out = vec![0.0f32; self.frame_size];
        i16_to_f32(&self.out_i16, &mut out);

        // AGC last (contract AEC4: AEC -> AGC -> RNNoise).
        if self.agc_enabled {
            self.apply_agc(&mut out);
        }
        out
    }
}

impl Default for EchoCanceller {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for EchoCanceller {
    fn drop(&mut self) {
        // SAFETY: handles were created by the matching init calls and are only
        // destroyed once (this struct owns them uniquely).
        unsafe {
            sys::speex_preprocess_state_destroy(self.preprocess);
            sys::speex_echo_state_destroy(self.echo);
        }
    }
}

/// Rational soft-clip: linear below 0.75, saturating toward ±1.0 above. Keeps
/// AGC gain changes from ever introducing hard clipping.
#[inline]
fn soft_clip(sample: f32) -> f32 {
    if sample.abs() <= 0.75 {
        sample
    } else {
        let s = sample.signum();
        let x = (sample.abs() - 0.75) * 4.0;
        s * (0.75 + 0.25 * x / (1.0 + x))
    }
}

#[inline]
fn f32_to_i16(src: &[f32], dst: &mut [i16]) {
    for (d, &s) in dst.iter_mut().zip(src.iter()) {
        *d = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
    }
}

#[inline]
fn i16_to_f32(src: &[i16], dst: &mut [f32]) {
    for (d, &s) in dst.iter_mut().zip(src.iter()) {
        *d = s as f32 / 32767.0;
    }
}

/// Convert `src` into `dst`, zero-filling any tail `dst` beyond `src.len()`.
#[inline]
fn fill_i16_from_f32(src: &[f32], dst: &mut [i16]) {
    let n = src.len().min(dst.len());
    for i in 0..n {
        dst[i] = (src[i].clamp(-1.0, 1.0) * 32767.0) as i16;
    }
    for d in dst.iter_mut().skip(n) {
        *d = 0;
    }
}

// ---------------------------------------------------------------------------
// Far-end reference SPSC ring
// ---------------------------------------------------------------------------

/// Lock-free single-producer/single-consumer ring carrying the mixer's rendered
/// (device-rate, mono) output to the AEC. The producer is the real-time audio
/// output callback; it must never block, so the ring uses only atomics — no
/// mutex is added to the render path (contract AEC4).
///
/// Across an output-device switch two render callbacks can momentarily overlap.
/// Each [`ReferenceProducer`] carries the epoch it was minted with; only the
/// current epoch writes, so the single-producer invariant holds. A torn write at
/// the exact switch instant is bounded (indices are always modulo `capacity`, so
/// never out of range) and self-heals as the filter re-adapts.
pub struct ReferenceRing {
    buf: Box<[AtomicU32]>,
    capacity: usize,
    /// Producer-owned write cursor.
    write: AtomicUsize,
    /// Consumer-owned read cursor.
    read: AtomicUsize,
    /// Sample rate of samples currently being pushed (the output device rate).
    device_rate: AtomicU32,
    /// Bumped on every producer attach; only the newest producer writes.
    active_epoch: AtomicU64,
}

impl ReferenceRing {
    pub fn new(capacity: usize) -> Arc<Self> {
        let mut buf = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            buf.push(AtomicU32::new(0));
        }
        Arc::new(Self {
            buf: buf.into_boxed_slice(),
            capacity,
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
            device_rate: AtomicU32::new(SAMPLE_RATE),
            active_epoch: AtomicU64::new(0),
        })
    }

    /// Attach a producer for a newly opened output device running at
    /// `device_rate`. Supersedes any previous producer (epoch bump).
    pub fn attach_producer(self: &Arc<Self>, device_rate: u32) -> ReferenceProducer {
        self.device_rate.store(device_rate, Ordering::Release);
        let epoch = self.active_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        ReferenceProducer {
            ring: self.clone(),
            epoch,
        }
    }

    /// Create the (single) consumer.
    pub fn consumer(self: &Arc<Self>) -> ReferenceConsumer {
        ReferenceConsumer {
            ring: self.clone(),
            resampler: None,
            seen_rate: 0,
            acc48: Vec::with_capacity(FRAME_SIZE * 4),
            dev_scratch: Vec::new(),
        }
    }
}

/// Write side of [`ReferenceRing`], held inside the audio output callback.
pub struct ReferenceProducer {
    ring: Arc<ReferenceRing>,
    epoch: u64,
}

impl ReferenceProducer {
    /// Push a block of device-rate mono reference samples. Lock-free; drops the
    /// (tail of the) block if this producer has been superseded or the ring is
    /// full. Never blocks — safe to call from the real-time render callback.
    #[inline]
    pub fn push(&self, samples: &[f32]) {
        let ring = &self.ring;
        if ring.active_epoch.load(Ordering::Relaxed) != self.epoch {
            return;
        }
        let mut write = ring.write.load(Ordering::Relaxed);
        let read = ring.read.load(Ordering::Acquire);
        for &s in samples {
            let next = if write + 1 == ring.capacity {
                0
            } else {
                write + 1
            };
            if next == read {
                break; // full: consumer is behind; drop the rest of this block
            }
            ring.buf[write].store(s.to_bits(), Ordering::Relaxed);
            write = next;
        }
        ring.write.store(write, Ordering::Release);
    }
}

/// Read side of [`ReferenceRing`], held by the mic send task. Resamples the
/// device-rate reference to 48 kHz and yields exactly one 48 kHz frame per call.
pub struct ReferenceConsumer {
    ring: Arc<ReferenceRing>,
    resampler: Option<FftFixedOut<f32>>,
    seen_rate: u32,
    /// 48 kHz reference awaiting frame extraction.
    acc48: Vec<f32>,
    /// Device-rate scratch pulled from the ring for the resampler.
    dev_scratch: Vec<f32>,
}

impl ReferenceConsumer {
    /// Number of device-rate samples currently readable from the ring.
    fn available(&self) -> usize {
        let write = self.ring.write.load(Ordering::Acquire);
        let read = self.ring.read.load(Ordering::Relaxed);
        if write >= read {
            write - read
        } else {
            self.ring.capacity - read + write
        }
    }

    /// Pull up to `n` device-rate samples from the ring into `dev_scratch`
    /// (cleared first). Returns how many were pulled.
    fn pull(&mut self, n: usize) -> usize {
        self.dev_scratch.clear();
        let mut read = self.ring.read.load(Ordering::Relaxed);
        let write = self.ring.write.load(Ordering::Acquire);
        let avail = if write >= read {
            write - read
        } else {
            self.ring.capacity - read + write
        };
        let take = n.min(avail);
        for _ in 0..take {
            let bits = self.ring.buf[read].load(Ordering::Relaxed);
            self.dev_scratch.push(f32::from_bits(bits));
            read = if read + 1 == self.ring.capacity {
                0
            } else {
                read + 1
            };
        }
        self.ring.read.store(read, Ordering::Release);
        take
    }

    /// Discard every sample currently in the ring (used when the device rate
    /// changes so mixed-rate samples at the boundary are not resampled together).
    fn drain_ring(&mut self) {
        let write = self.ring.write.load(Ordering::Acquire);
        self.ring.read.store(write, Ordering::Release);
    }

    fn ensure_resampler(&mut self, rate: u32) {
        if rate == SAMPLE_RATE {
            self.resampler = None;
        } else {
            self.resampler =
                FftFixedOut::<f32>::new(rate as usize, SAMPLE_RATE as usize, FRAME_SIZE, 1, 1).ok();
        }
    }

    /// Refill `acc48` from whatever is readable in the ring, converting to
    /// 48 kHz. Then trim any pathological backlog so the reference stays current.
    fn refill(&mut self) {
        let rate = self.ring.device_rate.load(Ordering::Acquire);
        if rate != self.seen_rate {
            // On a genuine device *switch* (a previous real rate was seen),
            // discard the mixed-rate boundary so two rates are never resampled
            // together. On first-ever setup (seen_rate == 0) keep the buffered
            // reference — there is no boundary to discard.
            if self.seen_rate != 0 {
                self.drain_ring();
                self.acc48.clear();
            }
            self.ensure_resampler(rate);
            self.seen_rate = rate;
        }

        match self.resampler.as_mut() {
            None => {
                // Device already at 48 kHz: 1:1 copy.
                let avail = self.available();
                if avail > 0 {
                    self.pull(avail);
                    let pulled = std::mem::take(&mut self.dev_scratch);
                    self.acc48.extend_from_slice(&pulled);
                    self.dev_scratch = pulled;
                    self.dev_scratch.clear();
                }
            }
            Some(_) => {
                // Pull exactly the resampler's required input, one chunk at a
                // time, while the ring holds enough for the next chunk.
                loop {
                    let needed = self.resampler.as_ref().unwrap().input_frames_next();
                    if self.available() < needed {
                        break;
                    }
                    self.pull(needed);
                    let input = [self.dev_scratch.as_slice()];
                    match self.resampler.as_mut().unwrap().process(&input, None) {
                        Ok(mut out) if !out.is_empty() => {
                            let frame = out.swap_remove(0);
                            self.acc48.extend_from_slice(&frame);
                        }
                        Ok(_) => break,
                        Err(_) => break,
                    }
                }
            }
        }

        let max_backlog = FRAME_SIZE * MAX_REFERENCE_BACKLOG_FRAMES;
        if self.acc48.len() > max_backlog {
            // Drop oldest so the reference tracks live playback (a lagging
            // reference falls outside the AEC filter tail).
            let drop = self.acc48.len() - max_backlog;
            self.acc48.drain(..drop);
        }
    }

    /// Yield exactly `frame_size` samples of 48 kHz mono reference aligned to
    /// live playback. Returns silence on underrun (no far-end playing yet), which
    /// the canceller treats as "no echo to subtract".
    pub fn next_frame(&mut self, frame_size: usize) -> Vec<f32> {
        self.refill();
        if self.acc48.len() >= frame_size {
            self.acc48.drain(..frame_size).collect()
        } else {
            vec![0.0; frame_size]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_when_both_disabled() {
        let mut aec = EchoCanceller::new();
        aec.set_echo_cancellation(false);
        aec.set_agc(false);
        let mic: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| (i as f32 * 0.01).sin() * 0.3)
            .collect();
        let out = aec.process(&mic, &vec![0.0; FRAME_SIZE]);
        assert_eq!(out, mic, "both stages off must be a bit-exact passthrough");
    }

    #[test]
    fn process_returns_full_frame() {
        let mut aec = EchoCanceller::new();
        let mic = vec![0.2f32; FRAME_SIZE];
        let reference = vec![0.2f32; FRAME_SIZE];
        let out = aec.process(&mic, &reference);
        assert_eq!(out.len(), FRAME_SIZE);
    }

    #[test]
    fn short_reference_is_zero_filled() {
        let mut aec = EchoCanceller::new();
        let mic = vec![0.1f32; FRAME_SIZE];
        // Reference shorter than a frame (startup underrun) must not panic.
        let out = aec.process(&mic, &[0.1, 0.1, 0.1]);
        assert_eq!(out.len(), FRAME_SIZE);
    }

    #[test]
    fn cancels_a_pure_echo() {
        // Feed the canceller a near-end that is exactly the far-end reference
        // (a perfect, delay-free echo). After the MDF filter converges the
        // output energy must drop well below the input energy.
        let mut aec = EchoCanceller::new();
        aec.set_agc(false); // isolate the AEC stage from AGC gain changes
        let far: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| {
                (2.0 * std::f32::consts::PI * 300.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.4
            })
            .collect();

        let in_energy: f32 = far.iter().map(|s| s * s).sum();
        let mut last_out_energy = in_energy;
        // Many iterations so the adaptive filter converges on the echo path.
        for _ in 0..400 {
            let out = aec.process(&far, &far);
            last_out_energy = out.iter().map(|s| s * s).sum();
        }
        assert!(
            last_out_energy < in_energy * 0.5,
            "AEC failed to attenuate a pure echo: in={in_energy}, out={last_out_energy}"
        );
    }

    #[test]
    fn agc_amplifies_a_quiet_signal_toward_target() {
        let mut aec = EchoCanceller::new();
        aec.set_echo_cancellation(false); // isolate the AGC stage
                                          // A quiet tone well below the -18 dBFS target but above the noise gate.
        let make = || -> Vec<f32> {
            (0..FRAME_SIZE)
                .map(|i| {
                    (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SAMPLE_RATE as f32).sin()
                        * 0.02
                })
                .collect()
        };
        let quiet = make();
        let in_rms = (quiet.iter().map(|s| s * s).sum::<f32>() / quiet.len() as f32).sqrt();

        let mut out_rms = in_rms;
        for _ in 0..200 {
            let out = aec.process(&make(), &vec![0.0; FRAME_SIZE]);
            out_rms = (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt();
        }
        assert!(
            out_rms > in_rms * 2.0,
            "AGC did not raise a quiet signal: in_rms={in_rms}, out_rms={out_rms}"
        );
        assert!(
            out_rms <= AGC_TARGET_RMS * 1.5,
            "AGC overshot the target: out_rms={out_rms}"
        );
    }

    #[test]
    fn agc_holds_gain_on_silence() {
        let mut aec = EchoCanceller::new();
        aec.set_echo_cancellation(false);
        // Silence is below the gate: gain must stay at unity and output stay ~0.
        for _ in 0..50 {
            let out = aec.process(&vec![0.0; FRAME_SIZE], &vec![0.0; FRAME_SIZE]);
            assert!(out.iter().all(|&s| s.abs() < 1e-6));
        }
    }

    #[test]
    fn toggle_state_reports_correctly() {
        let mut aec = EchoCanceller::new();
        assert!(aec.is_echo_cancellation_enabled());
        assert!(aec.is_agc_enabled());
        aec.set_echo_cancellation(false);
        aec.set_agc(false);
        assert!(!aec.is_echo_cancellation_enabled());
        assert!(!aec.is_agc_enabled());
    }

    #[test]
    fn reference_ring_roundtrips_at_48k() {
        let ring = ReferenceRing::new(4096);
        let producer = ring.attach_producer(SAMPLE_RATE);
        let mut consumer = ring.consumer();

        // Push one frame of a ramp.
        let block: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| i as f32 / FRAME_SIZE as f32)
            .collect();
        producer.push(&block);

        let frame = consumer.next_frame(FRAME_SIZE);
        assert_eq!(frame.len(), FRAME_SIZE);
        // At 48 kHz there is no resampling, so samples come through unchanged.
        for (a, b) in frame.iter().zip(block.iter()) {
            assert!((a - b).abs() < 1e-6, "ring corrupted sample: {a} vs {b}");
        }
    }

    #[test]
    fn reference_ring_underrun_yields_silence() {
        let ring = ReferenceRing::new(4096);
        let _producer = ring.attach_producer(SAMPLE_RATE);
        let mut consumer = ring.consumer();
        // Nothing pushed yet.
        let frame = consumer.next_frame(FRAME_SIZE);
        assert_eq!(frame.len(), FRAME_SIZE);
        assert!(frame.iter().all(|&s| s == 0.0), "underrun must be silence");
    }

    #[test]
    fn superseded_producer_stops_writing() {
        let ring = ReferenceRing::new(4096);
        let old = ring.attach_producer(SAMPLE_RATE);
        let _new = ring.attach_producer(SAMPLE_RATE);
        let mut consumer = ring.consumer();
        // The superseded producer must be a no-op (epoch-gated).
        old.push(&vec![0.5f32; FRAME_SIZE]);
        let frame = consumer.next_frame(FRAME_SIZE);
        assert!(
            frame.iter().all(|&s| s == 0.0),
            "a superseded producer must not write to the ring"
        );
    }

    #[test]
    fn reference_ring_resamples_non_48k_device() {
        // A 44.1 kHz device: the consumer must still yield full 48 kHz frames.
        let ring = ReferenceRing::new(REFERENCE_RING_CAPACITY);
        let producer = ring.attach_producer(44_100);
        let mut consumer = ring.consumer();

        // Push ~200 ms of 44.1 kHz tone in device-rate blocks.
        for _ in 0..10 {
            let block: Vec<f32> = (0..882) // 20 ms at 44.1 kHz
                .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 44_100.0).sin() * 0.3)
                .collect();
            producer.push(&block);
        }
        let frame = consumer.next_frame(FRAME_SIZE);
        assert_eq!(
            frame.len(),
            FRAME_SIZE,
            "resampled frame must be full length"
        );
    }
}
