// Sender key frame encryption/decryption (AES-128-GCM).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes128Gcm, Nonce,
};
use std::collections::HashMap;
use thiserror::Error;

/// AES-128 key size in bytes.
pub const KEY_SIZE: usize = 16;
/// GCM authentication tag size in bytes.
pub const TAG_SIZE: usize = 16;
/// Nonce size for AES-GCM (96 bits / 12 bytes).
pub const NONCE_SIZE: usize = 12;
/// MediaHeader size used as AAD.
pub const HEADER_SIZE: usize = 16;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("no key available for epoch {0}")]
    NoKeyForEpoch(u8),
    #[error("decryption failed (authentication error)")]
    DecryptionFailed,
    #[error("ciphertext too short")]
    CiphertextTooShort,
}

/// Build a 12-byte nonce from packet metadata.
///
/// Layout:
/// - Bytes 0-3:  SSRC (u32 big-endian)
/// - Byte 4:     Key epoch (u8)
/// - Bytes 5-6:  Sequence number (u16 big-endian)
/// - Bytes 7-11: Zero padding
fn build_nonce(ssrc: u32, epoch: u8, sequence: u16) -> [u8; NONCE_SIZE] {
    let mut nonce = [0u8; NONCE_SIZE];
    nonce[0..4].copy_from_slice(&ssrc.to_be_bytes());
    nonce[4] = epoch;
    nonce[5..7].copy_from_slice(&sequence.to_be_bytes());
    // Bytes 7-11 remain zero
    nonce
}

/// Frame encryptor using AES-128-GCM.
///
/// Encrypts media frame payloads using per-epoch keys. The 16-byte MediaHeader
/// is used as Additional Authenticated Data (AAD) to prevent header tampering.
pub struct FrameEncryptor {
    /// Keys indexed by (ssrc, epoch). SSRC 0 is treated as a wildcard fallback.
    keys: HashMap<(u32, u8), Aes128Gcm>,
}

impl FrameEncryptor {
    /// Create a new encryptor with no keys.
    pub fn new() -> Self {
        Self {
            keys: HashMap::new(),
        }
    }

    /// Set the encryption key for a given epoch.
    pub fn set_key(&mut self, epoch: u8, key: &[u8; KEY_SIZE]) {
        self.set_peer_key(0, epoch, key);
    }

    /// Set the encryption key for a specific sender SSRC + epoch.
    pub fn set_peer_key(&mut self, ssrc: u32, epoch: u8, key: &[u8; KEY_SIZE]) {
        let cipher = Aes128Gcm::new_from_slice(key).expect("valid key size");
        self.keys.insert((ssrc, epoch), cipher);
    }

    /// Remove the key for a given epoch.
    pub fn remove_key(&mut self, epoch: u8) {
        self.remove_peer_key(0, epoch);
    }

    /// Remove the key for a specific sender SSRC + epoch.
    pub fn remove_peer_key(&mut self, ssrc: u32, epoch: u8) {
        self.keys.remove(&(ssrc, epoch));
    }

    /// Encrypt a media frame payload.
    ///
    /// - `header_bytes`: the 16-byte serialized MediaHeader (used as AAD)
    /// - `ssrc`, `epoch`, `sequence`: values from the MediaHeader used to construct the nonce
    /// - `plaintext`: the raw payload to encrypt
    ///
    /// Returns the ciphertext (which includes the GCM authentication tag appended by aes-gcm).
    pub fn encrypt(
        &self,
        header_bytes: &[u8; HEADER_SIZE],
        ssrc: u32,
        epoch: u8,
        sequence: u16,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        let cipher = self
            .keys
            .get(&(ssrc, epoch))
            .or_else(|| self.keys.get(&(0, epoch)))
            .ok_or(CryptoError::NoKeyForEpoch(epoch))?;

        let nonce_bytes = build_nonce(ssrc, epoch, sequence);
        let nonce = Nonce::from_slice(&nonce_bytes);

        cipher
            .encrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: plaintext,
                    aad: header_bytes,
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)
    }
}

impl Default for FrameEncryptor {
    fn default() -> Self {
        Self::new()
    }
}

/// Frame decryptor using AES-128-GCM.
///
/// Decrypts media frame payloads, supporting multiple active key epochs
/// for handling in-flight packets during key rotation.
pub struct FrameDecryptor {
    /// Keys indexed by (ssrc, epoch). SSRC 0 is treated as a wildcard fallback.
    keys: HashMap<(u32, u8), Aes128Gcm>,
}

impl FrameDecryptor {
    /// Create a new decryptor with no keys.
    pub fn new() -> Self {
        Self {
            keys: HashMap::new(),
        }
    }

    /// Set the decryption key for a given epoch.
    pub fn set_key(&mut self, epoch: u8, key: &[u8; KEY_SIZE]) {
        self.set_peer_key(0, epoch, key);
    }

    /// Set the decryption key for a specific sender SSRC + epoch.
    pub fn set_peer_key(&mut self, ssrc: u32, epoch: u8, key: &[u8; KEY_SIZE]) {
        let cipher = Aes128Gcm::new_from_slice(key).expect("valid key size");
        self.keys.insert((ssrc, epoch), cipher);
    }

    /// Remove the key for a given epoch.
    pub fn remove_key(&mut self, epoch: u8) {
        self.remove_peer_key(0, epoch);
    }

    /// Remove the key for a specific sender SSRC + epoch.
    pub fn remove_peer_key(&mut self, ssrc: u32, epoch: u8) {
        self.keys.remove(&(ssrc, epoch));
    }

    /// Decrypt a media frame payload.
    ///
    /// - `header_bytes`: the 16-byte serialized MediaHeader (used as AAD)
    /// - `ssrc`, `epoch`, `sequence`: values from the MediaHeader used to construct the nonce
    /// - `ciphertext`: the encrypted payload (includes GCM tag)
    ///
    /// Returns the decrypted plaintext.
    pub fn decrypt(
        &self,
        header_bytes: &[u8; HEADER_SIZE],
        ssrc: u32,
        epoch: u8,
        sequence: u16,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if ciphertext.len() < TAG_SIZE {
            return Err(CryptoError::CiphertextTooShort);
        }

        let cipher = self
            .keys
            .get(&(ssrc, epoch))
            .or_else(|| self.keys.get(&(0, epoch)))
            .ok_or(CryptoError::NoKeyForEpoch(epoch))?;

        let nonce_bytes = build_nonce(ssrc, epoch, sequence);
        let nonce = Nonce::from_slice(&nonce_bytes);

        cipher
            .decrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: ciphertext,
                    aad: header_bytes,
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)
    }
}

impl Default for FrameDecryptor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; KEY_SIZE] {
        [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F,
        ]
    }

    fn test_header() -> [u8; HEADER_SIZE] {
        [
            0x80, // version=1, type=audio, simlayer=0
            0x00, 0x01, // seq=1
            0x00, 0x00, 0x03, 0xC0, // timestamp=960
            0xDE, 0xAD, 0xBE, 0xEF, // ssrc
            0x7F, // audio_level=127
            0x01, // epoch=1
            0x00, 0x3C, // payload_length=60
            0x00, // reserved
        ]
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = test_key();
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &key);

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &key);

        let plaintext = b"Hello, voice data!";
        let ssrc = 0xDEADBEEF;
        let epoch = 1;
        let sequence = 1;

        let ciphertext = encryptor
            .encrypt(&header, ssrc, epoch, sequence, plaintext)
            .expect("encryption failed");

        // Ciphertext should be larger than plaintext (includes tag)
        assert!(ciphertext.len() > plaintext.len());
        assert_eq!(ciphertext.len(), plaintext.len() + TAG_SIZE);

        let decrypted = decryptor
            .decrypt(&header, ssrc, epoch, sequence, &ciphertext)
            .expect("decryption failed");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn tampered_header_fails() {
        let key = test_key();
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &key);

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &key);

        let plaintext = b"protected payload";
        let ciphertext = encryptor
            .encrypt(&header, 0xDEADBEEF, 1, 1, plaintext)
            .expect("encryption failed");

        // Tamper with header
        let mut bad_header = header;
        bad_header[0] = 0xFF;

        let result = decryptor.decrypt(&bad_header, 0xDEADBEEF, 1, 1, &ciphertext);
        assert!(result.is_err(), "should fail with tampered header");
    }

    #[test]
    fn wrong_key_fails() {
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &test_key());

        let mut decryptor = FrameDecryptor::new();
        let wrong_key = [0xFFu8; KEY_SIZE];
        decryptor.set_key(1, &wrong_key);

        let plaintext = b"secret";
        let ciphertext = encryptor
            .encrypt(&header, 0xDEADBEEF, 1, 1, plaintext)
            .expect("encryption failed");

        let result = decryptor.decrypt(&header, 0xDEADBEEF, 1, 1, &ciphertext);
        assert!(result.is_err(), "should fail with wrong key");
    }

    #[test]
    fn wrong_epoch_fails() {
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &test_key());

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &test_key());

        let plaintext = b"data";
        let ciphertext = encryptor
            .encrypt(&header, 0xDEADBEEF, 1, 1, plaintext)
            .expect("encryption failed");

        // Try to decrypt with wrong epoch (no key for epoch 2)
        let result = decryptor.decrypt(&header, 0xDEADBEEF, 2, 1, &ciphertext);
        assert!(matches!(result, Err(CryptoError::NoKeyForEpoch(2))));
    }

    #[test]
    fn wrong_sequence_fails() {
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &test_key());

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &test_key());

        let plaintext = b"data";
        let ciphertext = encryptor
            .encrypt(&header, 0xDEADBEEF, 1, 1, plaintext)
            .expect("encryption failed");

        // Wrong sequence number changes the nonce, so decryption should fail
        let result = decryptor.decrypt(&header, 0xDEADBEEF, 1, 999, &ciphertext);
        assert!(result.is_err(), "should fail with wrong sequence (nonce)");
    }

    #[test]
    fn multiple_epochs() {
        let header = test_header();

        let key1 = [0x01u8; KEY_SIZE];
        let key2 = [0x02u8; KEY_SIZE];

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &key1);
        encryptor.set_key(2, &key2);

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &key1);
        decryptor.set_key(2, &key2);

        // Encrypt with epoch 1
        let ct1 = encryptor
            .encrypt(&header, 0xAABBCCDD, 1, 0, b"epoch1")
            .unwrap();
        // Encrypt with epoch 2
        let ct2 = encryptor
            .encrypt(&header, 0xAABBCCDD, 2, 0, b"epoch2")
            .unwrap();

        // Both should decrypt correctly
        let pt1 = decryptor.decrypt(&header, 0xAABBCCDD, 1, 0, &ct1).unwrap();
        let pt2 = decryptor.decrypt(&header, 0xAABBCCDD, 2, 0, &ct2).unwrap();

        assert_eq!(pt1, b"epoch1");
        assert_eq!(pt2, b"epoch2");
    }

    #[test]
    fn encryptor_prefers_ssrc_specific_key_over_wildcard() {
        let header = test_header();
        let wildcard_key = test_key();
        let peer_key = [
            0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D,
            0x1E, 0x1F,
        ];
        let ssrc = 0xDEADBEEF;
        let epoch = 1;
        let sequence = 7;

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(epoch, &wildcard_key);
        encryptor.set_peer_key(ssrc, epoch, &peer_key);

        let ciphertext = encryptor
            .encrypt(&header, ssrc, epoch, sequence, b"ssrc scoped sender key")
            .expect("encryption failed");

        let mut wildcard_only = FrameDecryptor::new();
        wildcard_only.set_key(epoch, &wildcard_key);
        let result = wildcard_only.decrypt(&header, ssrc, epoch, sequence, &ciphertext);
        assert!(matches!(result, Err(CryptoError::DecryptionFailed)));

        let mut peer_decryptor = FrameDecryptor::new();
        peer_decryptor.set_key(epoch, &wildcard_key);
        peer_decryptor.set_peer_key(ssrc, epoch, &peer_key);
        let decrypted = peer_decryptor
            .decrypt(&header, ssrc, epoch, sequence, &ciphertext)
            .expect("peer decrypt failed");
        assert_eq!(decrypted, b"ssrc scoped sender key");
    }

    #[test]
    fn empty_ciphertext_rejected() {
        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(0, &[0u8; KEY_SIZE]);

        let header = [0u8; HEADER_SIZE];
        let result = decryptor.decrypt(&header, 0, 0, 0, &[]);
        assert!(matches!(result, Err(CryptoError::CiphertextTooShort)));
    }

    #[test]
    fn encrypt_empty_payload() {
        let key = test_key();
        let header = test_header();

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_key(1, &key);

        let mut decryptor = FrameDecryptor::new();
        decryptor.set_key(1, &key);

        // Encrypt empty payload
        let ciphertext = encryptor
            .encrypt(&header, 0xDEADBEEF, 1, 0, b"")
            .expect("encryption failed");

        assert_eq!(ciphertext.len(), TAG_SIZE); // just the tag

        let decrypted = decryptor
            .decrypt(&header, 0xDEADBEEF, 1, 0, &ciphertext)
            .expect("decryption failed");

        assert!(decrypted.is_empty());
    }

    // ================================================================
    // Cross-platform test vectors (AES-128-GCM known-answer tests)
    // ================================================================
    //
    // These vectors are deterministic: same (key, nonce, plaintext, AAD) always
    // produces identical ciphertext. The TypeScript SenderKeyManager in
    // client/src/lib/media/senderKeys.ts MUST produce the same output.
    //
    // Nonce layout: SSRC (4 BE) || epoch (1) || sequence (2 BE) || 5 zero bytes = 12 bytes
    // AAD: the full 16-byte MediaHeader
    // Output: ciphertext || 16-byte GCM authentication tag

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn from_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Vector 1: Standard voice frame encryption.
    ///   Key:       000102030405060708090a0b0c0d0e0f
    ///   SSRC:      0xDEADBEEF
    ///   Epoch:     1
    ///   Sequence:  1
    ///   Nonce:     deadbeef 01 0001 0000000000 (hex)
    ///   Header:    80000100 0003c0de adbeef7f 01003c00
    ///   Plaintext: "Hello, voice data!" (UTF-8)
    ///   Expected:  c9611e22e84a7843baeea950f4874840d7de76e45bab8f2dc788366fe73643bb62f5
    #[test]
    fn test_vector_1_standard_frame() {
        let key: [u8; KEY_SIZE] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F,
        ];
        let header: [u8; HEADER_SIZE] = [
            0x80, 0x00, 0x01, 0x00, 0x00, 0x03, 0xC0, 0xDE, 0xAD, 0xBE, 0xEF, 0x7F, 0x01, 0x00,
            0x3C, 0x00,
        ];
        let mut enc = FrameEncryptor::new();
        enc.set_key(1, &key);

        let ct = enc
            .encrypt(&header, 0xDEADBEEF, 1, 1, b"Hello, voice data!")
            .unwrap();
        assert_eq!(
            hex(&ct),
            "c9611e22e84a7843baeea950f4874840d7de76e45bab8f2dc788366fe73643bb62f5",
            "Vector 1 ciphertext mismatch"
        );

        // Verify round-trip
        let mut dec = FrameDecryptor::new();
        dec.set_key(1, &key);
        let pt = dec.decrypt(&header, 0xDEADBEEF, 1, 1, &ct).unwrap();
        assert_eq!(pt, b"Hello, voice data!");
    }

    /// Vector 2: Empty payload (tag-only output).
    ///   Key:       000102030405060708090a0b0c0d0e0f
    ///   SSRC:      0xDEADBEEF
    ///   Epoch:     1
    ///   Sequence:  0
    ///   Nonce:     deadbeef 01 0000 0000000000 (hex)
    ///   Header:    80000100 0003c0de adbeef7f 01003c00
    ///   Plaintext: (empty)
    ///   Expected:  e4ee5cfea6b77f20fcb4d7c719b1f0a4
    #[test]
    fn test_vector_2_empty_payload() {
        let key: [u8; KEY_SIZE] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F,
        ];
        let header: [u8; HEADER_SIZE] = [
            0x80, 0x00, 0x01, 0x00, 0x00, 0x03, 0xC0, 0xDE, 0xAD, 0xBE, 0xEF, 0x7F, 0x01, 0x00,
            0x3C, 0x00,
        ];
        let mut enc = FrameEncryptor::new();
        enc.set_key(1, &key);

        let ct = enc.encrypt(&header, 0xDEADBEEF, 1, 0, b"").unwrap();
        assert_eq!(
            hex(&ct),
            "e4ee5cfea6b77f20fcb4d7c719b1f0a4",
            "Vector 2 ciphertext mismatch"
        );
        assert_eq!(ct.len(), TAG_SIZE);
    }

    /// Vector 3: Different key/epoch/SSRC.
    ///   Key:       ffffffffffffffffffffffffffffffff
    ///   SSRC:      0x11223344
    ///   Epoch:     5
    ///   Sequence:  10
    ///   Nonce:     11223344 05 000a 0000000000 (hex)
    ///   Header:    8000 0a00 00078011 22334464 05000400
    ///   Plaintext: 00010203
    ///   Expected:  81c292b9fd8c98a87d786ee1f5698993b50ae66d
    #[test]
    fn test_vector_3_different_params() {
        let key: [u8; KEY_SIZE] = [0xFF; KEY_SIZE];
        let header: [u8; HEADER_SIZE] = [
            0x80, 0x00, 0x0A, 0x00, 0x00, 0x07, 0x80, 0x11, 0x22, 0x33, 0x44, 0x64, 0x05, 0x00,
            0x04, 0x00,
        ];
        let mut enc = FrameEncryptor::new();
        enc.set_key(5, &key);

        let ct = enc
            .encrypt(&header, 0x11223344, 5, 10, &[0x00, 0x01, 0x02, 0x03])
            .unwrap();
        assert_eq!(
            hex(&ct),
            "81c292b9fd8c98a87d786ee1f5698993b50ae66d",
            "Vector 3 ciphertext mismatch"
        );

        // Verify round-trip
        let mut dec = FrameDecryptor::new();
        dec.set_key(5, &key);
        let pt = dec.decrypt(&header, 0x11223344, 5, 10, &ct).unwrap();
        assert_eq!(pt, &[0x00, 0x01, 0x02, 0x03]);
    }

    /// Verify test vector ciphertext can be reconstructed from hex.
    #[test]
    fn test_vector_roundtrip_from_hex() {
        let key: [u8; KEY_SIZE] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F,
        ];
        let header: [u8; HEADER_SIZE] = [
            0x80, 0x00, 0x01, 0x00, 0x00, 0x03, 0xC0, 0xDE, 0xAD, 0xBE, 0xEF, 0x7F, 0x01, 0x00,
            0x3C, 0x00,
        ];
        let ct_hex = "c9611e22e84a7843baeea950f4874840d7de76e45bab8f2dc788366fe73643bb62f5";
        let ct = from_hex(ct_hex);

        let mut dec = FrameDecryptor::new();
        dec.set_key(1, &key);
        let pt = dec.decrypt(&header, 0xDEADBEEF, 1, 1, &ct).unwrap();
        assert_eq!(pt, b"Hello, voice data!");
    }

    #[test]
    fn nonce_uniqueness() {
        // Different (ssrc, epoch, seq) combinations should produce different nonces
        let n1 = build_nonce(1, 0, 0);
        let n2 = build_nonce(2, 0, 0);
        let n3 = build_nonce(1, 1, 0);
        let n4 = build_nonce(1, 0, 1);

        assert_ne!(n1, n2);
        assert_ne!(n1, n3);
        assert_ne!(n1, n4);
        assert_ne!(n2, n3);
    }
}
