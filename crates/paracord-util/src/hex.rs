//! Lowercase hexadecimal codec.
//!
//! Both functions write into a single preallocated buffer — no per-byte
//! `format!`/`String` allocation. Shared so that challenge nonces, federation
//! envelopes, and at-rest key derivation all encode identically.

const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

/// Encode bytes as a lowercase hex string.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX_CHARS[(byte >> 4) as usize] as char);
        out.push(HEX_CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode a hex string into bytes. Returns `None` on odd length or any
/// non-hex byte (including multi-byte UTF-8, since those bytes are > 0x7f).
pub fn hex_decode(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let hi = decode_nibble(chunk[0])?;
        let lo = decode_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let original = b"hello world";
        let encoded = hex_encode(original);
        assert_eq!(encoded, "68656c6c6f20776f726c64");
        assert_eq!(hex_decode(&encoded).expect("decode"), original);
    }

    #[test]
    fn encodes_full_byte_range() {
        let bytes: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        let encoded = hex_encode(&bytes);
        assert_eq!(encoded.len(), 512);
        assert_eq!(&encoded[..4], "0001");
        assert_eq!(&encoded[encoded.len() - 4..], "feff");
        assert_eq!(hex_decode(&encoded).expect("decode"), bytes);
    }

    #[test]
    fn empty_round_trips() {
        assert_eq!(hex_encode(b""), "");
        assert_eq!(hex_decode("").expect("decode"), Vec::<u8>::new());
    }

    #[test]
    fn decode_accepts_uppercase() {
        assert_eq!(
            hex_decode("DEADBEEF").expect("decode"),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    #[test]
    fn decode_rejects_odd_length() {
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn decode_rejects_non_hex() {
        assert!(hex_decode("zzzz").is_none());
    }

    #[test]
    fn decode_rejects_multibyte_even_length() {
        // Two-char count but multi-byte UTF-8 — must not panic and must reject.
        assert!(hex_decode("é").is_none());
    }
}
