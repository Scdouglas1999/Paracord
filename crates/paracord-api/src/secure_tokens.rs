//! Centralized secure-token generation and hashing.
//!
//! Bots, webhooks, and interaction tokens all mint high-entropy opaque tokens
//! and store only their SHA-256 hash. Keeping a single implementation here
//! avoids drift in entropy, encoding, and hash format across those call sites.

use rand::RngCore;
use sha2::{Digest, Sha256};

const HEX_ALPHABET: &[u8; 16] = b"0123456789abcdef";

/// Lowercase-hex encode `bytes` without per-byte formatting allocations.
fn encode_hex(bytes: &[u8]) -> String {
    let mut out = vec![0_u8; bytes.len() * 2];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2] = HEX_ALPHABET[(b >> 4) as usize];
        out[i * 2 + 1] = HEX_ALPHABET[(b & 0x0f) as usize];
    }
    // Safety-free: the buffer only ever contains ASCII hex digits.
    String::from_utf8(out).expect("hex alphabet is valid ASCII")
}

/// Generate a 256-bit opaque token, hex-encoded (64 lowercase hex chars).
pub fn generate_secure_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    encode_hex(&bytes)
}

/// Compute the lowercase-hex SHA-256 digest of `token`.
pub fn hash_token_sha256_hex(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    encode_hex(&hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_64_lowercase_hex_chars() {
        let token = generate_secure_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(token.chars().all(|c| !c.is_ascii_uppercase()));
        // Two independent draws must not collide.
        assert_ne!(token, generate_secure_token());
    }

    #[test]
    fn hash_matches_known_sha256_vector() {
        // SHA-256("abc")
        assert_eq!(
            hash_token_sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // SHA-256("") — empty input
        assert_eq!(
            hash_token_sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
