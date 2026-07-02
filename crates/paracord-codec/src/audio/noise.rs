// RNNoise noise suppression (pure Rust via nnnoiseless).

use nnnoiseless::DenoiseState;

/// Frame size for nnnoiseless (10 ms at 48 kHz).
const DENOISE_FRAME_SIZE: usize = DenoiseState::FRAME_SIZE; // 480

/// RNNoise-based noise suppressor.
///
/// Processes audio in 10 ms chunks (480 samples at 48 kHz).
/// For 20 ms Opus frames (960 samples), call `process_frame` which
/// internally chains two 10 ms passes.
pub struct NoiseSuppressor {
    state: Box<DenoiseState<'static>>,
    enabled: bool,
}

impl NoiseSuppressor {
    /// Create a new noise suppressor (enabled by default).
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            enabled: true,
        }
    }

    /// Enable or disable noise suppression at runtime.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Returns whether noise suppression is currently enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Process a 20 ms frame (960 f32 samples at 48 kHz) through RNNoise.
    ///
    /// If suppression is disabled, returns the input unchanged.
    /// nnnoiseless operates on 480-sample chunks internally, so this
    /// chains two 10 ms passes.
    pub fn process_frame(&mut self, pcm: &[f32]) -> Vec<f32> {
        if !self.enabled {
            return pcm.to_vec();
        }

        let mut output = Vec::with_capacity(pcm.len());

        // Process in DENOISE_FRAME_SIZE chunks
        for chunk in pcm.chunks(DENOISE_FRAME_SIZE) {
            if chunk.len() == DENOISE_FRAME_SIZE {
                let mut frame = [0.0f32; DENOISE_FRAME_SIZE];
                // nnnoiseless expects samples scaled to i16 range (-32768..32767)
                for (i, &s) in chunk.iter().enumerate() {
                    frame[i] = s * 32767.0;
                }

                let mut out_frame = [0.0f32; DENOISE_FRAME_SIZE];
                self.state.process_frame(&mut out_frame, &frame);

                // Scale back to f32 range (-1.0..1.0)
                for &s in &out_frame {
                    output.push(s / 32767.0);
                }
            } else {
                // Partial chunk at end: pass through unprocessed
                output.extend_from_slice(chunk);
            }
        }

        output
    }

    /// Process a single 10 ms chunk (480 samples).
    /// Useful if you need finer-grained control.
    pub fn process_chunk(&mut self, pcm: &[f32; DENOISE_FRAME_SIZE]) -> [f32; DENOISE_FRAME_SIZE] {
        if !self.enabled {
            return *pcm;
        }

        let mut scaled = [0.0f32; DENOISE_FRAME_SIZE];
        for (i, &s) in pcm.iter().enumerate() {
            scaled[i] = s * 32767.0;
        }

        let mut out = [0.0f32; DENOISE_FRAME_SIZE];
        self.state.process_frame(&mut out, &scaled);

        for s in &mut out {
            *s /= 32767.0;
        }

        out
    }
}

impl Default for NoiseSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::opus::FRAME_SIZE;

    #[test]
    fn process_silence_no_crash() {
        let mut suppressor = NoiseSuppressor::new();
        let silence = vec![0.0f32; FRAME_SIZE];
        let result = suppressor.process_frame(&silence);
        assert_eq!(result.len(), FRAME_SIZE);
    }

    #[test]
    fn process_tone_no_crash() {
        let mut suppressor = NoiseSuppressor::new();
        let tone: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin() * 0.5)
            .collect();
        let result = suppressor.process_frame(&tone);
        assert_eq!(result.len(), FRAME_SIZE);
    }

    #[test]
    fn disabled_passthrough() {
        let mut suppressor = NoiseSuppressor::new();
        suppressor.set_enabled(false);

        let pcm: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| i as f32 / FRAME_SIZE as f32)
            .collect();
        let result = suppressor.process_frame(&pcm);
        assert_eq!(result, pcm);
    }

    #[test]
    fn toggle_enabled() {
        let mut suppressor = NoiseSuppressor::new();
        assert!(suppressor.is_enabled());
        suppressor.set_enabled(false);
        assert!(!suppressor.is_enabled());
        suppressor.set_enabled(true);
        assert!(suppressor.is_enabled());
    }

    #[test]
    fn process_chunk_no_crash() {
        let mut suppressor = NoiseSuppressor::new();
        let chunk = [0.0f32; 480];
        let result = suppressor.process_chunk(&chunk);
        assert_eq!(result.len(), 480);
    }
}
