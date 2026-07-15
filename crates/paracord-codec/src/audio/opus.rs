// Opus encode/decode wrapper.

use audiopus::{
    coder::{Decoder as OpusDecoderInner, Encoder as OpusEncoderInner},
    packet::Packet,
    Application, Bitrate, Channels, MutSignals, SampleRate,
};
use thiserror::Error;

/// 48 kHz sample rate (native for Opus).
pub const SAMPLE_RATE: u32 = 48_000;
/// 20 ms frame at 48 kHz = 960 samples *per channel*.
pub const FRAME_SIZE: usize = 960;
/// Maximum Opus packet size (recommended by RFC 6716).
const MAX_PACKET_SIZE: usize = 4000;

#[derive(Debug, Error)]
pub enum OpusError {
    #[error("opus encoder error: {0}")]
    Encoder(#[from] audiopus::Error),
    #[error("frame size mismatch: expected {expected}, got {actual}")]
    FrameSizeMismatch { expected: usize, actual: usize },
}

/// Opus encoder. Voice is 48 kHz mono; the stream/system-audio configuration
/// (see [`OpusEncoder::new_stream_audio`]) is 48 kHz stereo.
pub struct OpusEncoder {
    inner: OpusEncoderInner,
    encode_buf: Vec<u8>,
    /// Number of interleaved channels this encoder expects per frame (1 or 2).
    channels: usize,
}

impl OpusEncoder {
    /// Create a new voice Opus encoder.
    ///
    /// - 48 kHz mono
    /// - Voip application (voice-optimized)
    /// - 96 kbps default bitrate
    /// - FEC enabled for packet loss resilience
    /// - DTX enabled for silence suppression
    /// - Complexity 9 (this trades CPU, not latency — Opus's algorithmic delay
    ///   is fixed by the frame/lookahead, independent of the complexity knob)
    pub fn new() -> Result<Self, OpusError> {
        let mut encoder =
            OpusEncoderInner::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)?;

        encoder.set_bitrate(Bitrate::BitsPerSecond(96_000))?;

        encoder.set_complexity(9)?;

        // Enable in-band FEC
        encoder.set_inband_fec(true)?;

        // Enable DTX (discontinuous transmission) for silence suppression
        encoder.set_dtx(true)?;

        // Set expected packet loss percentage for FEC tuning
        encoder.set_packet_loss_perc(10u8)?;

        Ok(Self {
            inner: encoder,
            encode_buf: vec![0u8; MAX_PACKET_SIZE],
            channels: 1,
        })
    }

    /// Create a stereo Opus encoder for stream / system audio (contract C4).
    ///
    /// - 48 kHz stereo
    /// - `Audio` application (full-bandwidth music/system audio, not voice)
    /// - 192 kbps
    /// - Complexity 10 (highest quality; CPU only, not latency)
    /// - DTX **off** — system audio must never be gated to silence frames
    /// - FEC off — the stream-audio track is not FEC-recovered on the wire
    pub fn new_stream_audio() -> Result<Self, OpusError> {
        let mut encoder =
            OpusEncoderInner::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio)?;

        encoder.set_bitrate(Bitrate::BitsPerSecond(192_000))?;
        encoder.set_complexity(10)?;
        encoder.set_inband_fec(false)?;
        encoder.set_dtx(false)?;

        Ok(Self {
            inner: encoder,
            encode_buf: vec![0u8; MAX_PACKET_SIZE],
            channels: 2,
        })
    }

    /// Number of interleaved channels this encoder expects (1 = mono, 2 = stereo).
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Encode one 20 ms frame of interleaved PCM f32 samples.
    ///
    /// The expected length is channel-aware: `FRAME_SIZE * channels`
    /// (960 for mono, 1920 for stereo). Returns the encoded Opus packet bytes.
    pub fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>, OpusError> {
        let expected = FRAME_SIZE * self.channels;
        if pcm.len() != expected {
            return Err(OpusError::FrameSizeMismatch {
                expected,
                actual: pcm.len(),
            });
        }

        let len = self.inner.encode_float(pcm, &mut self.encode_buf)?;
        Ok(self.encode_buf[..len].to_vec())
    }

    /// Set the bitrate in bits per second.
    pub fn set_bitrate(&mut self, bps: i32) -> Result<(), OpusError> {
        self.inner.set_bitrate(Bitrate::BitsPerSecond(bps))?;
        Ok(())
    }

    /// Set expected packet loss percentage (0-100) to tune FEC behavior.
    pub fn set_packet_loss_perc(&mut self, pct: u8) -> Result<(), OpusError> {
        self.inner.set_packet_loss_perc(pct)?;
        Ok(())
    }
}

/// Opus decoder for a single remote participant.
pub struct OpusDecoder {
    inner: OpusDecoderInner,
    decode_buf: Vec<f32>,
    channels: usize,
}

impl OpusDecoder {
    /// Create a new voice Opus decoder (48 kHz mono).
    pub fn new() -> Result<Self, OpusError> {
        Self::with_channels(Channels::Mono, 1)
    }

    /// Create a stereo Opus decoder for stream / system audio (contract C4).
    /// Decoded frames are interleaved L/R, `FRAME_SIZE * 2` samples per frame.
    pub fn new_stereo() -> Result<Self, OpusError> {
        Self::with_channels(Channels::Stereo, 2)
    }

    fn with_channels(channels: Channels, count: usize) -> Result<Self, OpusError> {
        let decoder = OpusDecoderInner::new(SampleRate::Hz48000, channels)?;
        Ok(Self {
            inner: decoder,
            // decode_float writes `samples_per_channel * channels` interleaved
            // values; size the scratch buffer for a full 20 ms frame.
            decode_buf: vec![0.0f32; FRAME_SIZE * count],
            channels: count,
        })
    }

    /// Number of interleaved channels this decoder emits (1 = mono, 2 = stereo).
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Decode an Opus packet into interleaved PCM f32 samples.
    /// Returns `FRAME_SIZE * channels` samples for a full 20 ms frame.
    pub fn decode(&mut self, packet_data: &[u8]) -> Result<Vec<f32>, OpusError> {
        let pkt: Packet<'_> = packet_data.try_into()?;
        let output: MutSignals<'_, f32> = (&mut self.decode_buf[..]).try_into()?;
        let per_channel = self.inner.decode_float(Some(pkt), output, false)?;
        Ok(self.decode_buf[..per_channel * self.channels].to_vec())
    }

    /// Perform packet loss concealment (PLC).
    /// Called when a packet is missing; the decoder generates a best-guess frame.
    pub fn decode_plc(&mut self) -> Result<Vec<f32>, OpusError> {
        let output: MutSignals<'_, f32> = (&mut self.decode_buf[..]).try_into()?;
        let per_channel = self.inner.decode_float(None, output, false)?;
        Ok(self.decode_buf[..per_channel * self.channels].to_vec())
    }

    /// Decode with FEC. If the *next* packet has arrived but the *current* one
    /// was lost, pass the next packet here with `fec=true` to recover the
    /// lost frame from the forward error correction data.
    pub fn decode_fec(&mut self, next_packet_data: &[u8]) -> Result<Vec<f32>, OpusError> {
        let pkt: Packet<'_> = next_packet_data.try_into()?;
        let output: MutSignals<'_, f32> = (&mut self.decode_buf[..]).try_into()?;
        let per_channel = self.inner.decode_float(Some(pkt), output, true)?;
        Ok(self.decode_buf[..per_channel * self.channels].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_round_trip() {
        let mut encoder = OpusEncoder::new().expect("encoder creation failed");
        let mut decoder = OpusDecoder::new().expect("decoder creation failed");

        // Encode silence (960 zero samples)
        let silence = vec![0.0f32; FRAME_SIZE];
        let packet = encoder.encode(&silence).expect("encode failed");
        assert!(!packet.is_empty());

        // Decode
        let decoded = decoder.decode(&packet).expect("decode failed");
        assert_eq!(decoded.len(), FRAME_SIZE);

        // Decoded silence should be near-zero
        for &sample in &decoded {
            assert!(
                sample.abs() < 0.01,
                "decoded sample too far from silence: {sample}"
            );
        }
    }

    #[test]
    fn encode_decode_tone() {
        let mut encoder = OpusEncoder::new().expect("encoder creation failed");
        let mut decoder = OpusDecoder::new().expect("decoder creation failed");

        // Generate a 440Hz sine wave
        let pcm: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();

        let packet = encoder.encode(&pcm).expect("encode failed");
        assert!(!packet.is_empty());

        let decoded = decoder.decode(&packet).expect("decode failed");
        assert_eq!(decoded.len(), FRAME_SIZE);

        // Check that decoded signal has non-trivial energy
        let energy: f32 = decoded.iter().map(|s| s * s).sum::<f32>() / decoded.len() as f32;
        assert!(
            energy > 0.01,
            "decoded tone has too little energy: {energy}"
        );
    }

    #[test]
    fn plc_does_not_crash() {
        let mut decoder = OpusDecoder::new().expect("decoder creation failed");
        let plc = decoder.decode_plc().expect("PLC failed");
        assert_eq!(plc.len(), FRAME_SIZE);
    }

    #[test]
    fn wrong_frame_size_rejected() {
        let mut encoder = OpusEncoder::new().expect("encoder creation failed");
        let bad_pcm = vec![0.0f32; 480]; // 10ms instead of 20ms
        let result = encoder.encode(&bad_pcm);
        assert!(result.is_err());
    }

    /// Contract C4 / AU2: the screen-audio path pushes 20 ms *stereo* chunks
    /// (960 frames × 2 channels = 1920 interleaved samples). The mono voice
    /// encoder rejected these, so every macOS system-audio frame errored. The
    /// stereo encoder must accept exactly 1920 and round-trip through a stereo
    /// decoder back to 1920 interleaved samples.
    #[test]
    fn stream_audio_encodes_1920_sample_stereo_chunk() {
        let mut encoder = OpusEncoder::new_stream_audio().expect("stream encoder creation failed");
        assert_eq!(encoder.channels(), 2);

        // Interleaved L/R tone: distinct per channel so a channel swap would show.
        let pcm: Vec<f32> = (0..FRAME_SIZE)
            .flat_map(|i| {
                let l = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin()
                    * 0.5;
                let r = (2.0 * std::f32::consts::PI * 660.0 * i as f32 / SAMPLE_RATE as f32).sin()
                    * 0.5;
                [l, r]
            })
            .collect();
        assert_eq!(pcm.len(), FRAME_SIZE * 2);

        let packet = encoder.encode(&pcm).expect("stereo encode failed");
        assert!(!packet.is_empty());

        let mut decoder = OpusDecoder::new_stereo().expect("stereo decoder creation failed");
        assert_eq!(decoder.channels(), 2);
        let decoded = decoder.decode(&packet).expect("stereo decode failed");
        assert_eq!(
            decoded.len(),
            FRAME_SIZE * 2,
            "one 20ms stereo frame must decode to 1920 interleaved samples"
        );
    }

    #[test]
    fn stream_audio_rejects_mono_frame_size() {
        let mut encoder = OpusEncoder::new_stream_audio().expect("stream encoder creation failed");
        // A mono 960 chunk is half the stereo frame — must be rejected loudly.
        let mono = vec![0.0f32; FRAME_SIZE];
        assert!(encoder.encode(&mono).is_err());
    }
}
