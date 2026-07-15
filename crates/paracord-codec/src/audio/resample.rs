//! Stereo push resampler for system/screen audio capture (contract C4/AU3).
//!
//! The Windows WASAPI loopback delivers interleaved-stereo f32 at the render
//! device's mix rate, which is frequently 44.1 kHz. Contract C4 requires the
//! screen-audio wire format to be 48 kHz stereo in 20 ms frames (1920
//! interleaved samples), so non-48k sources must be resampled — with rubato,
//! not a linear-interpolation stopgap.
//!
//! This wraps a fixed-output `FftFixedOut` (one 20 ms output frame per call)
//! behind a push interface: feed it arbitrary-sized interleaved-stereo chunks at
//! the source rate and it emits complete 1920-sample 48 kHz frames as they
//! become available. It lives in the codec crate so the Tauri client can use it
//! without taking a direct rubato dependency.

use rubato::{FftFixedOut, Resampler};

use super::opus::{FRAME_SIZE, SAMPLE_RATE};

/// Number of interleaved samples in one 20 ms stereo frame (960 × 2).
pub const STEREO_FRAME_SAMPLES: usize = FRAME_SIZE * 2;

/// Push-driven 48 kHz-target stereo resampler.
pub struct StereoResampler {
    resampler: FftFixedOut<f32>,
    /// Input frames (per channel) the resampler needs to produce one 20ms frame.
    input_frames_needed: usize,
    /// Accumulated planar input at the source rate, one Vec per channel.
    acc_l: Vec<f32>,
    acc_r: Vec<f32>,
    // Preallocated planar scratch reused across `push` calls.
    in_l: Vec<f32>,
    in_r: Vec<f32>,
}

impl StereoResampler {
    /// Build a resampler from `source_rate` (Hz) to 48 kHz stereo.
    pub fn new(source_rate: u32) -> Result<Self, String> {
        let resampler =
            FftFixedOut::<f32>::new(source_rate as usize, SAMPLE_RATE as usize, FRAME_SIZE, 1, 2)
                .map_err(|e| format!("build stereo resampler: {e}"))?;
        let input_frames_needed = resampler.input_frames_next();
        Ok(Self {
            resampler,
            input_frames_needed,
            acc_l: Vec::with_capacity(input_frames_needed * 2),
            acc_r: Vec::with_capacity(input_frames_needed * 2),
            in_l: vec![0.0; input_frames_needed],
            in_r: vec![0.0; input_frames_needed],
        })
    }

    /// Feed an interleaved-stereo chunk at the source rate. Appends any complete
    /// 48 kHz 20 ms frames (each `STEREO_FRAME_SAMPLES` interleaved) to `out`.
    pub fn push(&mut self, interleaved: &[f32], out: &mut Vec<Vec<f32>>) {
        // Deinterleave into the per-channel accumulators.
        let frames = interleaved.len() / 2;
        for i in 0..frames {
            self.acc_l.push(interleaved[i * 2]);
            self.acc_r.push(interleaved[i * 2 + 1]);
        }

        while self.acc_l.len() >= self.input_frames_needed {
            let need = self.input_frames_needed;
            self.in_l.copy_from_slice(&self.acc_l[..need]);
            self.in_r.copy_from_slice(&self.acc_r[..need]);
            self.acc_l.drain(..need);
            self.acc_r.drain(..need);

            let input = [&self.in_l[..], &self.in_r[..]];
            match self.resampler.process(&input, None) {
                Ok(planar) if planar.len() == 2 => {
                    let mut interleaved_out = Vec::with_capacity(planar[0].len() * 2);
                    for (l, r) in planar[0].iter().zip(planar[1].iter()) {
                        interleaved_out.push(*l);
                        interleaved_out.push(*r);
                    }
                    out.push(interleaved_out);
                }
                Ok(_) => {}
                Err(_) => {}
            }

            // `FftFixedOut` may vary its next input requirement.
            self.input_frames_needed = self.resampler.input_frames_next();
            if self.in_l.len() != self.input_frames_needed {
                self.in_l.resize(self.input_frames_needed, 0.0);
                self.in_r.resize(self.input_frames_needed, 0.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_44100_to_48k_stereo_frames() {
        let mut rs = StereoResampler::new(44_100).expect("resampler");
        let mut out = Vec::new();

        // Feed 1 second of interleaved-stereo 44.1k audio in small chunks.
        let total_frames = 44_100usize;
        let chunk_frames = 441; // 10ms chunks
        let mut produced_any = false;
        for c in 0..(total_frames / chunk_frames) {
            let mut chunk = Vec::with_capacity(chunk_frames * 2);
            for f in 0..chunk_frames {
                let idx = c * chunk_frames + f;
                let s = (idx as f32 * 0.01).sin() * 0.3;
                chunk.push(s);
                chunk.push(-s);
            }
            rs.push(&chunk, &mut out);
            if !out.is_empty() {
                produced_any = true;
            }
        }

        assert!(produced_any, "resampler must emit 48k frames");
        for frame in &out {
            assert_eq!(
                frame.len(),
                STEREO_FRAME_SAMPLES,
                "each emitted frame must be a 1920-sample interleaved stereo frame"
            );
        }
    }

    #[test]
    fn passthrough_frame_count_is_sane() {
        // Roughly one second in should yield ~50 frames (48000/960).
        let mut rs = StereoResampler::new(44_100).expect("resampler");
        let mut out = Vec::new();
        let chunk: Vec<f32> = (0..44_100).flat_map(|_| [0.1f32, -0.1f32]).collect();
        rs.push(&chunk, &mut out);
        // Allow slack for buffering at the tail.
        assert!(
            out.len() >= 45 && out.len() <= 55,
            "expected ~50 frames for 1s of audio, got {}",
            out.len()
        );
    }
}
