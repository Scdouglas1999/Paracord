use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{
    STANDARD as BASE64_STANDARD, STANDARD_NO_PAD as BASE64_STANDARD_NO_PAD,
    URL_SAFE as BASE64_URL_SAFE, URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD,
};
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use thiserror::Error;

const FILE_MAGIC_V1: &[u8; 8] = b"PRCENC01";
const FILE_MAGIC_V2: &[u8; 8] = b"PRCENC02";
const NONCE_LEN: usize = 12;

#[derive(Debug, Error)]
pub enum AtRestKeyError {
    #[error("at-rest encryption key is empty")]
    Missing,
    #[error("at-rest encryption key must decode to 32 bytes (got {actual})")]
    InvalidLength { actual: usize },
    #[error("at-rest encryption key has invalid hex encoding")]
    InvalidHex,
    #[error("at-rest encryption key is not valid hex or base64")]
    InvalidEncoding,
}

#[derive(Debug, Error)]
pub enum FileCryptoError {
    #[error("attachment encryption key is invalid")]
    InvalidKey,
    #[error("attachment encryption failed")]
    EncryptFailed,
    #[error("attachment payload format is invalid")]
    InvalidPayload,
    #[error("attachment payload decryption failed")]
    DecryptFailed,
    #[error("plaintext attachment reads are disabled while at-rest encryption is enabled")]
    PlaintextReadDisabled,
}

#[derive(Clone)]
pub struct FileCryptor {
    key: [u8; 32],
    allow_plaintext_reads: bool,
}

impl std::fmt::Debug for FileCryptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileCryptor")
            .field("key", &"<redacted>")
            .field("allow_plaintext_reads", &self.allow_plaintext_reads)
            .finish()
    }
}

impl FileCryptor {
    pub fn from_master_key(master_key: &[u8; 32], allow_plaintext_reads: bool) -> Self {
        Self {
            key: derive_subkey(master_key, b"files"),
            allow_plaintext_reads,
        }
    }

    /// Create a cryptor with a custom HKDF context label (e.g. `b"totp"` for TOTP secrets).
    pub fn from_master_key_with_context(
        master_key: &[u8; 32],
        context: &[u8],
        allow_plaintext_reads: bool,
    ) -> Self {
        Self {
            key: derive_subkey(master_key, context),
            allow_plaintext_reads,
        }
    }

    pub fn allow_plaintext_reads(&self) -> bool {
        self.allow_plaintext_reads
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, FileCryptoError> {
        self.encrypt_with_aad(plaintext, b"")
    }

    pub fn encrypt_with_aad(
        &self,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, FileCryptoError> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| FileCryptoError::InvalidKey)?;
        let mut nonce_bytes = [0_u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| FileCryptoError::EncryptFailed)?;

        let mut out = Vec::with_capacity(FILE_MAGIC_V2.len() + NONCE_LEN + ciphertext.len());
        out.extend_from_slice(FILE_MAGIC_V2);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn decrypt(&self, stored: &[u8]) -> Result<Vec<u8>, FileCryptoError> {
        self.decrypt_with_aad(stored, b"")
    }

    pub fn decrypt_with_aad(&self, stored: &[u8], aad: &[u8]) -> Result<Vec<u8>, FileCryptoError> {
        if !Self::payload_is_encrypted(stored) {
            if self.allow_plaintext_reads {
                return Ok(stored.to_vec());
            }
            return Err(FileCryptoError::PlaintextReadDisabled);
        }
        if stored.len() <= FILE_MAGIC_V2.len() + NONCE_LEN {
            return Err(FileCryptoError::InvalidPayload);
        }

        let is_v2 = stored.starts_with(FILE_MAGIC_V2);
        let is_v1 = stored.starts_with(FILE_MAGIC_V1);
        if !is_v2 && !is_v1 {
            return Err(FileCryptoError::InvalidPayload);
        }

        let nonce_start = FILE_MAGIC_V2.len();
        let nonce_end = nonce_start + NONCE_LEN;
        let nonce = Nonce::from_slice(&stored[nonce_start..nonce_end]);
        let ciphertext = &stored[nonce_end..];

        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| FileCryptoError::InvalidKey)?;
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad: if is_v2 { aad } else { b"" },
                },
            )
            .map_err(|_| FileCryptoError::DecryptFailed)
    }

    pub fn payload_is_encrypted(payload: &[u8]) -> bool {
        payload.starts_with(FILE_MAGIC_V1) || payload.starts_with(FILE_MAGIC_V2)
    }
}

pub fn parse_master_key(raw: &str) -> Result<[u8; 32], AtRestKeyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AtRestKeyError::Missing);
    }

    if let Some(hex) = trimmed.strip_prefix("hex:") {
        return parse_hex_key(hex);
    }
    if let Some(base64) = trimmed.strip_prefix("base64:") {
        return parse_base64_key(base64);
    }

    if let Ok(parsed) = parse_hex_key(trimmed) {
        return Ok(parsed);
    }
    if let Ok(parsed) = parse_base64_key(trimmed) {
        return Ok(parsed);
    }

    Err(AtRestKeyError::InvalidEncoding)
}

pub fn derive_sqlite_key_hex(master_key: &[u8; 32]) -> String {
    let key = derive_subkey(master_key, b"sqlite");
    crate::hex::hex_encode(&key)
}

fn derive_subkey(master_key: &[u8; 32], context: &[u8]) -> [u8; 32] {
    let mut out = [0_u8; 32];
    let hkdf = Hkdf::<Sha256>::new(Some(b"paracord-at-rest-v1"), master_key);
    hkdf.expand(context, &mut out)
        .expect("HKDF output length is always valid for 32-byte subkeys");
    out
}

fn parse_hex_key(raw: &str) -> Result<[u8; 32], AtRestKeyError> {
    let bytes = raw.trim().as_bytes();
    if bytes.len() != 64 {
        return Err(AtRestKeyError::InvalidLength {
            actual: bytes.len() / 2,
        });
    }

    let mut out = [0_u8; 32];
    for (i, chunk) in bytes.chunks_exact(2).enumerate() {
        let hi = decode_hex_nibble(chunk[0]).ok_or(AtRestKeyError::InvalidHex)?;
        let lo = decode_hex_nibble(chunk[1]).ok_or(AtRestKeyError::InvalidHex)?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_base64_key(raw: &str) -> Result<[u8; 32], AtRestKeyError> {
    for engine in [
        &BASE64_STANDARD,
        &BASE64_STANDARD_NO_PAD,
        &BASE64_URL_SAFE,
        &BASE64_URL_SAFE_NO_PAD,
    ] {
        if let Ok(decoded) = engine.decode(raw) {
            if decoded.len() != 32 {
                return Err(AtRestKeyError::InvalidLength {
                    actual: decoded.len(),
                });
            }
            let mut out = [0_u8; 32];
            out.copy_from_slice(&decoded);
            return Ok(out);
        }
    }
    Err(AtRestKeyError::InvalidEncoding)
}

#[cfg(test)]
mod tests {
    use super::{derive_sqlite_key_hex, parse_master_key, FileCryptoError, FileCryptor};

    #[test]
    fn parses_hex_master_key() {
        let key =
            parse_master_key("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
                .expect("hex key");
        assert_eq!(key[0], 0x00);
        assert_eq!(key[31], 0x1f);
    }

    #[test]
    fn parses_base64_master_key() {
        let key =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("base64 key");
        assert_eq!(key[0], 0x00);
        assert_eq!(key[31], 0x1f);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let plaintext = b"hello attachment";
        let encrypted = cryptor.encrypt(plaintext).expect("encrypt");
        assert!(FileCryptor::payload_is_encrypted(&encrypted));

        let decrypted = cryptor.decrypt(&encrypted).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_with_wrong_aad_fails() {
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let plaintext = b"hello attachment";
        let encrypted = cryptor
            .encrypt_with_aad(plaintext, b"attachment:1")
            .expect("encrypt");

        let err = cryptor
            .decrypt_with_aad(&encrypted, b"attachment:2")
            .expect_err("aad mismatch must fail");
        assert!(matches!(err, FileCryptoError::DecryptFailed));
    }

    #[test]
    fn plaintext_read_fallback_when_allowed() {
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, true);
        let plaintext = b"legacy plaintext";
        assert_eq!(cryptor.decrypt(plaintext).expect("fallback"), plaintext);
    }

    #[test]
    fn plaintext_read_is_blocked_when_disabled() {
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let err = cryptor.decrypt(b"legacy plaintext").expect_err("must fail");
        assert!(matches!(err, FileCryptoError::PlaintextReadDisabled));
    }

    #[test]
    fn sqlite_key_derivation_is_deterministic() {
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let first = derive_sqlite_key_hex(&master);
        let second = derive_sqlite_key_hex(&master);
        assert_eq!(first.len(), 64);
        assert_eq!(first, second);
    }
}
