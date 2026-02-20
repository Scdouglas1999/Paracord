use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::io::Write;

/// Application-level zlib-stream compression context (per connection).
///
/// When the client connects with `?compress=zlib-stream`, all server→client
/// frames are deflate-compressed and sent as binary WebSocket frames with a
/// Z_SYNC_FLUSH suffix (`0x00 0x00 0xFF 0xFF`) for Discord gateway
/// compatibility.
pub struct WsCompressor {
    enabled: bool,
}

impl WsCompressor {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    /// Compress a JSON payload for sending to the client.
    ///
    /// Returns `None` when compression is disabled (caller should send as text).
    /// Returns `Some(compressed_bytes)` when compression is enabled.
    pub fn compress(&self, json: &str) -> Option<Result<Vec<u8>, std::io::Error>> {
        if !self.enabled {
            return None;
        }

        Some((|| {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(json.as_bytes())?;
            let mut compressed = encoder.finish()?;

            // Z_SYNC_FLUSH suffix for zlib-stream compatibility
            compressed.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);

            Ok(compressed)
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
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
}
