use flate2::write::DeflateEncoder;
use flate2::{Compress, Compression, FlushCompress};
use std::io::Write;
use std::sync::Mutex;

/// Application-level zlib-stream compression context (per connection).
///
/// When the client connects with `?compress=zlib-stream`, server→client frames
/// are deflate-compressed and sent as binary WebSocket frames with a
/// Z_SYNC_FLUSH suffix (`0x00 0x00 0xFF 0xFF`).
///
/// Two encoding modes are supported:
///
/// * [`Mode::Independent`] (default) — each frame is a self-contained raw
///   deflate block. The compressor is created fresh per message, so no LZ77
///   window carries across frames. This is the contract the current desktop
///   client relies on: it inflates every frame in isolation
///   (`fflate::inflateSync`), which cannot decode a streamed context.
/// * [`Mode::Streaming`] — a single persistent raw-deflate stream whose LZ77
///   window carries across frames, each flushed with Z_SYNC_FLUSH. This yields
///   better ratios on repetitive gateway traffic but requires a client that
///   feeds every frame into one long-lived inflate context. It is gated behind
///   an explicit capability (`?compress=zlib-stream&zlib_context=stream`) so it
///   is never used with one-shot clients that would misdecode it.
pub struct WsCompressor {
    mode: Mode,
}

enum Mode {
    Disabled,
    Independent,
    Streaming(Mutex<Compress>),
}

impl WsCompressor {
    /// Per-frame independent deflate (or disabled). Every frame decompresses
    /// standalone, matching one-shot clients.
    pub fn new(enabled: bool) -> Self {
        Self {
            mode: if enabled {
                Mode::Independent
            } else {
                Mode::Disabled
            },
        }
    }

    /// Persistent zlib-stream context. Requires a client that maintains a
    /// single long-lived inflate context across the whole connection.
    pub fn streaming() -> Self {
        Self {
            mode: Mode::Streaming(Mutex::new(Compress::new(Compression::fast(), false))),
        }
    }

    /// Compress a JSON payload for sending to the client.
    ///
    /// Returns `None` when compression is disabled (caller should send as text).
    /// Returns `Some(compressed_bytes)` when compression is enabled.
    pub fn compress(&self, json: &str) -> Option<Result<Vec<u8>, std::io::Error>> {
        match &self.mode {
            Mode::Disabled => None,
            Mode::Independent => Some((|| {
                let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
                encoder.write_all(json.as_bytes())?;
                let mut compressed = encoder.finish()?;
                // Z_SYNC_FLUSH suffix for zlib-stream compatibility.
                compressed.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
                Ok(compressed)
            })()),
            Mode::Streaming(stream) => {
                // The stream is serialized: a connection has a single writer.
                let mut compress = stream.lock().unwrap_or_else(|p| p.into_inner());
                Some(deflate_sync(&mut compress, json.as_bytes()))
            }
        }
    }
}

/// Feed `input` through a persistent deflate stream and flush with Z_SYNC_FLUSH,
/// returning the bytes produced for this frame (ending in `00 00 FF FF`). The
/// compressor's window is retained for the next call.
fn deflate_sync(compress: &mut Compress, input: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut out = Vec::with_capacity(input.len() / 2 + 16);
    let mut consumed = 0usize;
    loop {
        // Guarantee spare capacity so `compress_vec` can make forward progress.
        out.reserve(64);
        // `compress_vec` writes into the vec's existing spare capacity only, so
        // this is exactly the room deflate has to work with on this call.
        let available = out.capacity() - out.len();
        let in_before = compress.total_in();
        let out_before = compress.total_out();
        compress
            .compress_vec(&input[consumed..], &mut out, FlushCompress::Sync)
            .map_err(std::io::Error::other)?;
        consumed += (compress.total_in() - in_before) as usize;
        let produced = (compress.total_out() - out_before) as usize;
        // Once all input is consumed, the Z_SYNC_FLUSH is complete as soon as
        // deflate leaves spare room in the output buffer (it fills the whole
        // buffer only when it still has more pending output to emit). We cannot
        // wait for `produced == 0`: a repeated Z_SYNC_FLUSH on a drained stream
        // keeps re-emitting the empty sync block, which would spin forever.
        if consumed >= input.len() && produced < available {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use flate2::{Decompress, FlushDecompress, Status};
    use std::io::Read;

    #[test]
    fn disabled_compressor_returns_none() {
        let c = WsCompressor::new(false);
        assert!(c.compress(r#"{"op":0}"#).is_none());
    }

    #[test]
    fn enabled_compressor_produces_valid_deflate() {
        let c = WsCompressor::new(true);
        let input = r#"{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{"content":"hello world"}}"#;
        let compressed = c.compress(input).unwrap().unwrap();

        // Must end with Z_SYNC_FLUSH marker
        assert!(compressed.ends_with(&[0x00, 0x00, 0xFF, 0xFF]));

        // Strip the sync-flush suffix before decompressing
        let data = &compressed[..compressed.len() - 4];
        let mut decoder = DeflateDecoder::new(data);
        let mut decompressed = String::new();
        decoder.read_to_string(&mut decompressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn compression_reduces_size() {
        let c = WsCompressor::new(true);
        let input = r#"{"op":0,"t":"READY","s":1,"d":{"user":{"id":"123","username":"test"},"guilds":[{"id":"1","name":"Test Guild","channels":[]},{"id":"2","name":"Another Guild","channels":[]}],"session_id":"abc"}}"#;
        let compressed = c.compress(input).unwrap().unwrap();
        assert!(
            compressed.len() < input.len(),
            "compressed {} should be smaller than original {}",
            compressed.len(),
            input.len()
        );
    }

    /// Each independent frame must decode on its own (fresh window), which is
    /// what one-shot clients require.
    #[test]
    fn independent_frames_decode_standalone() {
        let c = WsCompressor::new(true);
        let first = c.compress(r#"{"op":0,"s":1}"#).unwrap().unwrap();
        let second = c.compress(r#"{"op":0,"s":2}"#).unwrap().unwrap();

        for (frame, expected) in [(first, r#"{"op":0,"s":1}"#), (second, r#"{"op":0,"s":2}"#)] {
            let data = &frame[..frame.len() - 4];
            let mut decoder = DeflateDecoder::new(data);
            let mut out = String::new();
            decoder.read_to_string(&mut out).unwrap();
            assert_eq!(out, expected);
        }
    }

    /// The streaming compressor carries its window across frames; a single
    /// persistent inflate context decodes the whole sequence correctly.
    #[test]
    fn streaming_context_round_trips_across_frames() {
        let c = WsCompressor::streaming();
        let frames = [
            r#"{"op":0,"t":"MESSAGE_CREATE","s":1,"d":{"content":"repeated payload shape"}}"#,
            r#"{"op":0,"t":"MESSAGE_CREATE","s":2,"d":{"content":"repeated payload shape"}}"#,
            r#"{"op":0,"t":"MESSAGE_CREATE","s":3,"d":{"content":"repeated payload shape"}}"#,
        ];

        let mut decompress = Decompress::new(false);
        for original in frames {
            let compressed = c.compress(original).unwrap().unwrap();
            assert!(compressed.ends_with(&[0x00, 0x00, 0xFF, 0xFF]));
            let decoded = inflate_stream(&mut decompress, &compressed);
            assert_eq!(String::from_utf8(decoded).unwrap(), original);
        }
    }

    /// Later frames of a persistent stream back-reference earlier frames, so a
    /// fresh one-shot inflate of a single frame must NOT reproduce the payload —
    /// this is exactly why the streaming path is capability-gated.
    #[test]
    fn streaming_frames_are_not_standalone() {
        let c = WsCompressor::streaming();
        let repeated = r#"{"op":0,"t":"TYPING_START","d":{"channel_id":"123456789012345"}}"#;
        let _first = c.compress(repeated).unwrap().unwrap();
        let second = c.compress(repeated).unwrap().unwrap();

        let data = &second[..second.len() - 4];
        let mut decoder = DeflateDecoder::new(data);
        let mut out = String::new();
        let standalone = decoder.read_to_string(&mut out);
        assert!(
            standalone.is_err() || out != repeated,
            "streamed frame unexpectedly decoded standalone"
        );
    }

    fn inflate_stream(decompress: &mut Decompress, frame: &[u8]) -> Vec<u8> {
        let mut input = frame;
        let mut out = Vec::with_capacity(frame.len() * 2 + 16);
        loop {
            out.reserve(64);
            let in_before = decompress.total_in();
            let out_before = decompress.total_out();
            let status = decompress
                .decompress_vec(input, &mut out, FlushDecompress::Sync)
                .unwrap();
            let consumed = (decompress.total_in() - in_before) as usize;
            input = &input[consumed..];
            let produced = decompress.total_out() - out_before;
            if matches!(status, Status::StreamEnd) {
                break;
            }
            if input.is_empty() && produced == 0 {
                break;
            }
        }
        out
    }
}
