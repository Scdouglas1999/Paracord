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
/// When set (`1`/`true`/`yes`/`on`), legacy V1 (`PRCENC01`) payloads are refused
/// outright instead of being decrypted with an empty AAD. V1 blobs carry no
/// record binding, so an attacker with blob-store write access can move one onto
/// a different row and it still authenticates. Deployments that have finished
/// re-wrapping their V1 payloads as V2 (see
/// [`FileCryptor::decrypt_with_aad_migrating`]) should set this.
const REFUSE_LEGACY_V1_ENV: &str = "PARACORD_AT_REST_REFUSE_LEGACY_V1";

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
    #[error("legacy (V1) at-rest payloads are refused by configuration")]
    LegacyPayloadRefused,
}

/// Result of [`FileCryptor::decrypt_with_aad_migrating`].
///
/// `rewrapped` is `Some` when the stored blob was a legacy V1 envelope (no AAD
/// binding) and has been re-encrypted as a V2 envelope bound to `aad`. Callers
/// that own the blob store should persist it in place so the unbound copy stops
/// existing.
#[derive(Debug, Clone)]
pub struct MigratedPayload {
    pub plaintext: Vec<u8>,
    pub rewrapped: Option<Vec<u8>>,
}

fn legacy_v1_reads_refused() -> bool {
    std::env::var(REFUSE_LEGACY_V1_ENV)
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
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

    /// Decrypt a stored payload.
    ///
    /// V2 (`PRCENC02`) envelopes are bound to `aad`: the same ciphertext moved
    /// onto a different record fails to authenticate. V1 (`PRCENC01`) envelopes
    /// predate that binding and were sealed with an empty AAD, so they decrypt
    /// identically under any record id — set `PARACORD_AT_REST_REFUSE_LEGACY_V1`
    /// to refuse them once they have been migrated, and prefer
    /// [`Self::decrypt_with_aad_migrating`] on read paths that can persist the
    /// upgraded blob.
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
        if is_v1 && legacy_v1_reads_refused() {
            return Err(FileCryptoError::LegacyPayloadRefused);
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

    /// Decrypt a stored payload and, when it is a legacy V1 envelope, hand back
    /// a V2 re-wrap bound to `aad` for the caller to persist in place.
    ///
    /// V1 blobs authenticate under any record id (they were sealed with an empty
    /// AAD), so a blob-store writer can relocate one onto a different row and it
    /// decrypts cleanly. Re-wrapping on access retires those copies as the data
    /// is read; the returned `rewrapped` blob is only meaningful if the caller
    /// stores it back under the same key.
    pub fn decrypt_with_aad_migrating(
        &self,
        stored: &[u8],
        aad: &[u8],
    ) -> Result<MigratedPayload, FileCryptoError> {
        let plaintext = self.decrypt_with_aad(stored, aad)?;
        if Self::payload_is_legacy_v1(stored) {
            let rewrapped = self.encrypt_with_aad(&plaintext, aad)?;
            return Ok(MigratedPayload {
                plaintext,
                rewrapped: Some(rewrapped),
            });
        }
        Ok(MigratedPayload {
            plaintext,
            rewrapped: None,
        })
    }

    pub fn payload_is_encrypted(payload: &[u8]) -> bool {
        payload.starts_with(FILE_MAGIC_V1) || payload.starts_with(FILE_MAGIC_V2)
    }

    /// True for a legacy `PRCENC01` envelope — encrypted, but not bound to any
    /// record id.
    pub fn payload_is_legacy_v1(payload: &[u8]) -> bool {
        payload.starts_with(FILE_MAGIC_V1)
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

/// A fresh 32-byte storage master key from the operating system's CSPRNG
/// (setup spec §4.3).
pub fn generate_master_key() -> [u8; 32] {
    let mut key = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

/// The one spelling a stored master key is written in: `hex:<64 lowercase hex>`,
/// which [`parse_master_key`] reads back.
pub fn format_master_key(master_key: &[u8; 32]) -> String {
    format!("hex:{}", crate::hex::hex_encode(master_key))
}

/// HKDF salt of the escrow key (setup spec §4.7).
pub const ESCROW_KDF_SALT: &[u8] = b"paracord/host-storage-escrow/v1";
/// AAD prefix of the escrowed storage key; the instance id follows.
pub const ESCROW_AAD_PREFIX: &str = "paracord/host-storage-escrow/v1|";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EscrowError {
    #[error("the escrow key must be 32 bytes")]
    InvalidWrappingKey,
    #[error("the escrow is malformed")]
    Malformed,
    #[error("the recovery phrase does not unlock this server's storage key")]
    WrongKey,
}

/// `escrow_key = HKDF-SHA256(ikm = owner identity private key, salt =
/// "paracord/host-storage-escrow/v1", info = instance_id, L = 32)`.
///
/// The app derives it from the recovery phrase; the server only ever receives
/// the result, never the identity key. Here for tests and the restore CLI.
pub fn derive_escrow_key(identity_private_key: &[u8], instance_id: &str) -> [u8; 32] {
    let mut out = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(ESCROW_KDF_SALT), identity_private_key)
        .expand(instance_id.as_bytes(), &mut out)
        .expect("HKDF output length is always valid for 32-byte keys");
    out
}

fn escrow_aad(instance_id: &str) -> Vec<u8> {
    format!("{ESCROW_AAD_PREFIX}{instance_id}").into_bytes()
}

/// Wrap the storage master key under `wrapping_key` (AES-256-GCM, random
/// 12-byte IV, AAD bound to the instance). Returns `(iv, ciphertext || tag)`.
pub fn seal_escrow(
    master_key: &[u8; 32],
    wrapping_key: &[u8],
    instance_id: &str,
) -> Result<([u8; NONCE_LEN], Vec<u8>), EscrowError> {
    let cipher =
        Aes256Gcm::new_from_slice(wrapping_key).map_err(|_| EscrowError::InvalidWrappingKey)?;
    let mut iv = [0_u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let aad = escrow_aad(instance_id);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: master_key,
                aad: &aad,
            },
        )
        .map_err(|_| EscrowError::Malformed)?;
    Ok((iv, ciphertext))
}

/// Unwrap a storage master key sealed by [`seal_escrow`].
pub fn open_escrow(
    iv: &[u8],
    ciphertext: &[u8],
    wrapping_key: &[u8],
    instance_id: &str,
) -> Result<[u8; 32], EscrowError> {
    let cipher =
        Aes256Gcm::new_from_slice(wrapping_key).map_err(|_| EscrowError::InvalidWrappingKey)?;
    if iv.len() != NONCE_LEN {
        return Err(EscrowError::Malformed);
    }
    let aad = escrow_aad(instance_id);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| EscrowError::WrongKey)?;
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| EscrowError::Malformed)
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
    for (i, chunk) in bytes.as_chunks::<2>().0.iter().enumerate() {
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
    use super::{
        derive_sqlite_key_hex, parse_master_key, FileCryptoError, FileCryptor, Nonce, Payload,
        FILE_MAGIC_V1, NONCE_LEN, REFUSE_LEGACY_V1_ENV,
    };
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Aes256Gcm;
    use std::sync::{Mutex, OnceLock};

    /// Serializes every test whose behavior depends on
    /// `PARACORD_AT_REST_REFUSE_LEGACY_V1`.
    ///
    /// The flag is read from the process environment inside `decrypt_with_aad`,
    /// and Rust runs tests as parallel threads in ONE process — so a test that
    /// merely *decrypts* observes a flag another test sets, even though it never
    /// touches the environment itself. Only the setter held this lock
    /// originally, which made the rewrap test fail intermittently in a full
    /// workspace run while passing in isolation.
    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// Build a legacy `PRCENC01` blob the way pre-AAD Paracord wrote them:
    /// same key, empty AAD, V1 magic.
    fn legacy_v1_blob(cryptor: &FileCryptor, plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(&cryptor.key).expect("cipher");
        let nonce_bytes = [9_u8; NONCE_LEN];
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: b"",
                },
            )
            .expect("v1 encrypt");
        let mut out = Vec::with_capacity(FILE_MAGIC_V1.len() + NONCE_LEN + ciphertext.len());
        out.extend_from_slice(FILE_MAGIC_V1);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        out
    }

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
        let _guard = env_lock().lock().expect("env lock");
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
        let _guard = env_lock().lock().expect("env lock");
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
        let _guard = env_lock().lock().expect("env lock");
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, true);
        let plaintext = b"legacy plaintext";
        assert_eq!(cryptor.decrypt(plaintext).expect("fallback"), plaintext);
    }

    #[test]
    fn plaintext_read_is_blocked_when_disabled() {
        let _guard = env_lock().lock().expect("env lock");
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let err = cryptor.decrypt(b"legacy plaintext").expect_err("must fail");
        assert!(matches!(err, FileCryptoError::PlaintextReadDisabled));
    }

    #[test]
    fn legacy_v1_payload_rewraps_to_an_aad_bound_v2_payload() {
        let _guard = env_lock().lock().expect("env lock");
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let plaintext = b"legacy attachment bytes";
        let v1 = legacy_v1_blob(&cryptor, plaintext);
        assert!(FileCryptor::payload_is_legacy_v1(&v1));

        // The V1 blob is unbound: it decrypts under a record id it was never
        // sealed for. That is the defect the re-wrap retires.
        assert_eq!(
            cryptor
                .decrypt_with_aad(&v1, b"attachment:999")
                .expect("v1 ignores aad"),
            plaintext
        );

        let migrated = cryptor
            .decrypt_with_aad_migrating(&v1, b"attachment:1")
            .expect("migrating decrypt");
        assert_eq!(migrated.plaintext, plaintext);
        let rewrapped = migrated.rewrapped.expect("v1 payloads must be re-wrapped");
        assert!(!FileCryptor::payload_is_legacy_v1(&rewrapped));

        // The re-wrapped copy is bound: it only opens under its own record id.
        assert_eq!(
            cryptor
                .decrypt_with_aad(&rewrapped, b"attachment:1")
                .expect("rewrapped decrypt"),
            plaintext
        );
        assert!(matches!(
            cryptor
                .decrypt_with_aad(&rewrapped, b"attachment:999")
                .expect_err("relocated ciphertext must fail"),
            FileCryptoError::DecryptFailed
        ));

        // V2 payloads are already bound and are never re-wrapped.
        let v2 = cryptor
            .encrypt_with_aad(plaintext, b"attachment:1")
            .expect("encrypt");
        let migrated_v2 = cryptor
            .decrypt_with_aad_migrating(&v2, b"attachment:1")
            .expect("migrating decrypt");
        assert!(migrated_v2.rewrapped.is_none());
    }

    #[test]
    fn legacy_v1_reads_can_be_refused_by_configuration() {
        let _guard = env_lock().lock().expect("env lock");
        let master =
            parse_master_key("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").expect("master");
        let cryptor = FileCryptor::from_master_key(&master, false);
        let v1 = legacy_v1_blob(&cryptor, b"legacy attachment bytes");

        std::env::set_var(REFUSE_LEGACY_V1_ENV, "true");
        let err = cryptor
            .decrypt_with_aad(&v1, b"attachment:1")
            .expect_err("v1 reads must be refused when configured");
        std::env::remove_var(REFUSE_LEGACY_V1_ENV);
        assert!(matches!(err, FileCryptoError::LegacyPayloadRefused));

        // V2 payloads keep working with the flag set.
        std::env::set_var(REFUSE_LEGACY_V1_ENV, "true");
        let v2 = cryptor
            .encrypt_with_aad(b"fresh bytes", b"attachment:1")
            .expect("encrypt");
        let decrypted = cryptor.decrypt_with_aad(&v2, b"attachment:1");
        std::env::remove_var(REFUSE_LEGACY_V1_ENV);
        assert_eq!(decrypted.expect("v2 decrypt"), b"fresh bytes");
    }

    #[test]
    fn generated_master_keys_are_random_and_round_trip_through_their_spelling() {
        let a = super::generate_master_key();
        let b = super::generate_master_key();
        assert_ne!(a, b);
        let spelled = super::format_master_key(&a);
        assert!(spelled.starts_with("hex:") && spelled.len() == 68);
        assert_eq!(parse_master_key(&spelled).unwrap(), a);
    }

    /// The identity private key of the S1 credential vectors
    /// (`client/src/lib/credential/vectors.json`, `wrap[0]`), and the escrow key
    /// node:crypto derives from it (`hkdfSync('sha256', priv,
    /// 'paracord/host-storage-escrow/v1', instance_id, 32)`).
    const VECTOR_IDENTITY_PRIVATE_KEY: &str =
        "d2cb3a96fd540c24f68825716fdb1e8c2549542d67fd5d25107635c2959f8d9c";
    const VECTOR_INSTANCE_ID: &str = "7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a";
    const VECTOR_ESCROW_KEY: &str =
        "03976eb9f4df480870ebee2d4d495ad22dcc239d87193d5fb9382ef36f2388cf";

    fn unhex(raw: &str) -> Vec<u8> {
        (0..raw.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn escrow_key_matches_the_vector_and_unwraps_only_for_its_instance() {
        let identity = unhex(VECTOR_IDENTITY_PRIVATE_KEY);
        let escrow_key = super::derive_escrow_key(&identity, VECTOR_INSTANCE_ID);
        assert_eq!(crate::hex::hex_encode(&escrow_key), VECTOR_ESCROW_KEY);

        let master = super::generate_master_key();
        let (iv, ciphertext) =
            super::seal_escrow(&master, &escrow_key, VECTOR_INSTANCE_ID).unwrap();
        assert_eq!(ciphertext.len(), 48);
        assert_eq!(
            super::open_escrow(&iv, &ciphertext, &escrow_key, VECTOR_INSTANCE_ID).unwrap(),
            master
        );
        assert_eq!(
            super::open_escrow(&iv, &ciphertext, &escrow_key, "another-instance"),
            Err(super::EscrowError::WrongKey)
        );
        let other = super::derive_escrow_key(&[7_u8; 32], VECTOR_INSTANCE_ID);
        assert_eq!(
            super::open_escrow(&iv, &ciphertext, &other, VECTOR_INSTANCE_ID),
            Err(super::EscrowError::WrongKey)
        );
        assert_eq!(
            super::open_escrow(&iv, &ciphertext, &[1_u8; 16], VECTOR_INSTANCE_ID),
            Err(super::EscrowError::InvalidWrappingKey)
        );
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
