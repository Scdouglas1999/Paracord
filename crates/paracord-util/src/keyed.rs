//! Keys derived from the instance's secret material, and a keyed pseudorandom
//! function over them.
//!
//! A feature that needs its own secret (so that knowing the source code is not
//! enough to predict its output) derives one from an existing instance secret
//! with a fixed, feature-specific label instead of inventing a new setting.

use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF-SHA256 of `secret`, salted with `salt`, expanded under `label`.
pub fn derive_key(secret: &[u8], salt: &[u8], label: &[u8]) -> [u8; 32] {
    let mut out = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(salt), secret)
        .expand(label, &mut out)
        .expect("HKDF output length is always valid for 32-byte keys");
    out
}

/// A keyed pseudorandom 64-bit value for `input`: the first eight bytes of
/// HKDF-Expand (HMAC-SHA256) with `key` as the pseudorandom key.
pub fn keyed_u64(key: &[u8; 32], input: &[u8]) -> u64 {
    let hkdf = Hkdf::<Sha256>::from_prk(key).expect("a 32-byte key is a valid PRK for SHA-256");
    let mut out = [0_u8; 8];
    hkdf.expand(input, &mut out)
        .expect("HKDF output length is always valid for 8 bytes");
    u64::from_be_bytes(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_depends_on_secret_salt_and_label() {
        let base = derive_key(b"secret", b"salt", b"label");
        assert_eq!(base, derive_key(b"secret", b"salt", b"label"));
        assert_ne!(base, derive_key(b"secret2", b"salt", b"label"));
        assert_ne!(base, derive_key(b"secret", b"salt2", b"label"));
        assert_ne!(base, derive_key(b"secret", b"salt", b"label2"));
    }

    #[test]
    fn keyed_values_depend_on_key_and_input() {
        let key = derive_key(b"secret", b"salt", b"label");
        let other = derive_key(b"other", b"salt", b"label");
        assert_eq!(keyed_u64(&key, b"a"), keyed_u64(&key, b"a"));
        assert_ne!(keyed_u64(&key, b"a"), keyed_u64(&key, b"b"));
        assert_ne!(keyed_u64(&key, b"a"), keyed_u64(&other, b"a"));
    }
}
