//! One password, server side (docs/setup-spec.md §3.2–§3.11, §3.13).
//!
//! The client derives two independent keys from the password: an **auth key**
//! it sends to sign in and a **wrap key** it never sends, which wraps the
//! identity private key. This module holds what the server does with them:
//!
//! - input checks for a new credential and a new identity (exact byte lengths,
//!   the KDF floor, the wrap algorithm, a canonical Ed25519 public key);
//! - the identity proof: an Ed25519 signature over
//!   `"<purpose>:<nonce>:<timestamp>:<origin>"`, where the purpose separates it
//!   from the plain key sign-in message (`"<nonce>:<timestamp>:<origin>"`);
//! - `Argon2id(auth_key)` (over the raw 32 bytes, so no typed password sent to
//!   a legacy route can ever match a one-password hash);
//! - the fake parameters `POST /auth/credential/params` answers for unknown and
//!   key-only accounts, so that route does not reveal who exists;
//! - the transactional writes: first credential (sign-up, claim, v1 move),
//!   replacement (change, phrase reset) and Start over (email reset).
//!
//! Every write is conditional on the version (and epoch) it started from, so
//! `credential_version` only ever increases and two concurrent writers cannot
//! both win (§3.13).

use std::sync::OnceLock;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use paracord_contracts::credential::{
    CredentialParams, KdfParams, NewCredential, NewIdentity, WRAP_ALG_V2,
};
use paracord_db::credentials::{CredentialRow, VERSION_LEGACY, VERSION_ONE_PASSWORD};
use paracord_util::hex::hex_decode;
use sha2::Sha256;

use crate::error::CoreError;

/// Proof purpose for a new identity: sign-up, the claim and the v1 move.
pub const PURPOSE_REGISTER: &str = "paracord/credential/v2/register";
/// Proof purpose for replacing the credential with the identity key (phrase
/// reset) and for the new identity of an email reset ("Start over").
pub const PURPOSE_RESET: &str = "paracord/credential/v2/reset";
/// HKDF info for the key behind the fake salts.
const FAKE_SALT_INFO: &[u8] = b"paracord/credential/fake-salt";
/// Byte length of the salt and the auth key.
pub const KEY_LEN: usize = 32;
/// `iv12 || AES-256-GCM(identity_sk[32]) || tag16`.
pub const WRAPPED_KEY_LEN: usize = 12 + 32 + 16;

/// The transaction the credential writes run in (a pool transaction).
pub type CredentialTx = sqlx::Transaction<'static, sqlx::Any>;

fn b64url() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// Decode unpadded base64url into exactly `N` bytes.
pub fn decode_b64url_exact<const N: usize>(value: &str) -> Option<[u8; N]> {
    let bytes = b64url().decode(value.as_bytes()).ok()?;
    bytes.try_into().ok()
}

/// Decode an auth key as sent on the wire (b64url, 32 bytes).
pub fn decode_auth_key(value: &str) -> Option<[u8; KEY_LEN]> {
    decode_b64url_exact::<KEY_LEN>(value)
}

fn bad(message: &str) -> CoreError {
    CoreError::BadRequest(message.to_string())
}

/// A new credential that passed every server-side check (§3.4).
pub struct CheckedCredential {
    /// b64url, as received (canonical: it decoded to exactly 32 bytes).
    pub salt: String,
    /// `"scrypt:17:8:1"`.
    pub kdf: String,
    auth_key: [u8; KEY_LEN],
}

impl CheckedCredential {
    /// `Argon2id(auth_key)` as a PHC string, for `users.password_hash`.
    pub fn hash(&self) -> Result<String, CoreError> {
        hash_auth_key(&self.auth_key)
    }
}

/// Check a credential: salt and auth key exactly 32 bytes, scrypt within the
/// floor and ceiling.
pub fn check_credential(credential: &NewCredential) -> Result<CheckedCredential, CoreError> {
    let Some(salt) = decode_b64url_exact::<KEY_LEN>(&credential.salt) else {
        return Err(bad(
            "The credential salt must be 32 bytes of unpadded base64url.",
        ));
    };
    let Some(auth_key) = decode_auth_key(&credential.auth_key) else {
        return Err(bad("The auth key must be 32 bytes of unpadded base64url."));
    };
    check_kdf(&credential.kdf)?;
    Ok(CheckedCredential {
        // Re-encoded, so the stored salt is canonical.
        salt: b64url().encode(salt),
        kdf: credential.kdf.to_db_text(),
        auth_key,
    })
}

/// The work ceiling the client enforces (`SCRYPT_MAX_WORK` in
/// `client/src/lib/credential/kdfCore.ts`): N·r·p at most 2^23, the cost of
/// N = 2^20 with r = 8, p = 1. The server refuses what a client would refuse,
/// so it never stores a credential no client can sign in with.
pub const SCRYPT_MAX_WORK: u64 = 1 << 23;

/// The KDF must be scrypt between N = 2^17 and 2^20 with r ≥ 8 and p ≥ 1, and
/// N·r·p within [`SCRYPT_MAX_WORK`].
pub fn check_kdf(kdf: &KdfParams) -> Result<(), CoreError> {
    let work = (1u64 << kdf.log_n.min(63))
        .saturating_mul(u64::from(kdf.r))
        .saturating_mul(u64::from(kdf.p));
    if kdf.within_policy() && work <= SCRYPT_MAX_WORK {
        Ok(())
    } else {
        Err(bad(
            "The key derivation parameters are below what Paracord allows (scrypt N=2^17, r=8, p=1) or above its ceiling (N=2^20).",
        ))
    }
}

/// Check a wrapped identity key: `aes256gcm-v2`, 12 + 48 bytes. Returns it in
/// canonical b64url.
pub fn check_wrapped_key(wrapped_key: &str) -> Result<String, CoreError> {
    let Some(bytes) = decode_b64url_exact::<WRAPPED_KEY_LEN>(wrapped_key) else {
        return Err(bad(
            "The wrapped key must be 60 bytes of unpadded base64url (12-byte IV and 48 bytes of ciphertext).",
        ));
    };
    Ok(b64url().encode(bytes))
}

/// Check a public key: 64 lowercase hex characters encoding a valid Ed25519
/// point.
pub fn check_public_key(public_key: &str) -> Result<VerifyingKey, CoreError> {
    let message = "The public key must be 64 lowercase hexadecimal characters of an Ed25519 key.";
    if public_key.len() != 64
        || !public_key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad(message));
    }
    let bytes: [u8; 32] = hex_decode(public_key)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| bad(message))?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| bad(message))?;
    if key.is_weak() {
        return Err(bad(message));
    }
    Ok(key)
}

/// A new identity whose shape passed every check. The proof is verified
/// separately, against a server-issued challenge.
pub struct CheckedIdentity {
    pub public_key: String,
    pub wrapped_key: String,
}

pub fn check_identity(identity: &NewIdentity) -> Result<CheckedIdentity, CoreError> {
    if identity.wrap_alg != WRAP_ALG_V2 {
        return Err(bad("The wrapped key must use aes256gcm-v2."));
    }
    check_public_key(&identity.public_key)?;
    let wrapped_key = check_wrapped_key(&identity.wrapped_key)?;
    Ok(CheckedIdentity {
        public_key: identity.public_key.clone(),
        wrapped_key,
    })
}

/// The exact bytes an identity proof signs.
pub fn proof_message(purpose: &str, nonce: &str, timestamp: i64, origin: &str) -> String {
    format!("{purpose}:{nonce}:{timestamp}:{origin}")
}

/// Verify an identity proof signature (strict Ed25519). Malformed keys or
/// signatures are simply invalid.
pub fn verify_proof_signature(
    purpose: &str,
    public_key_hex: &str,
    nonce: &str,
    timestamp: i64,
    origin: &str,
    signature_hex: &str,
) -> bool {
    let Ok(key) = check_public_key(&public_key_hex.to_ascii_lowercase()) else {
        return false;
    };
    let Some(signature) = hex_decode(signature_hex).and_then(|b| Signature::from_slice(&b).ok())
    else {
        return false;
    };
    key.verify_strict(
        proof_message(purpose, nonce, timestamp, origin).as_bytes(),
        &signature,
    )
    .is_ok()
}

/// `Argon2id(auth_key)` with the same parameters as legacy password hashes.
pub fn hash_auth_key(auth_key: &[u8; KEY_LEN]) -> Result<String, CoreError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(auth_key, &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| CoreError::Internal(e.to_string()))
}

/// Verify an auth key against a stored hash. An unparsable hash is a mismatch.
pub fn verify_auth_key(auth_key: &[u8; KEY_LEN], hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(auth_key, &parsed).is_ok(),
        Err(_) => false,
    }
}

static DUMMY_AUTH_KEY_HASH: OnceLock<String> = OnceLock::new();

/// Run one Argon2 verification against a fixed dummy hash, so a sign-in for an
/// unknown or key-only account costs the same time as a real one.
pub fn equalize_auth_key_timing(auth_key: &[u8; KEY_LEN]) {
    let hash = DUMMY_AUTH_KEY_HASH.get_or_init(|| {
        hash_auth_key(&[0x5a; KEY_LEN]).expect("hash the dummy auth key for timing equalization")
    });
    let _ = verify_auth_key(auth_key, hash);
}

/// `HMAC-SHA256(HKDF-SHA256(jwt_secret, info="paracord/credential/fake-salt"),
/// lower(identifier))`, b64url: stable per identifier and per server, and
/// indistinguishable from a random salt without the server's secret.
pub fn fake_salt(jwt_secret: &str, identifier: &str) -> String {
    let mut key = [0u8; KEY_LEN];
    Hkdf::<Sha256>::new(None, jwt_secret.as_bytes())
        .expand(FAKE_SALT_INFO, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("HMAC accepts any key length");
    mac.update(identifier.trim().to_lowercase().as_bytes());
    b64url().encode(mac.finalize().into_bytes())
}

/// What `POST /auth/credential/params` answers for an identifier.
///
/// A one-password account gets its real parameters; a legacy account
/// `version: 1`; anything else (no such account, key-only, a stored row that
/// does not parse) the default KDF, a fake salt and epoch 1, the same shape a
/// fresh one-password account has.
pub fn params_for(
    row: Option<&CredentialRow>,
    jwt_secret: &str,
    identifier: &str,
) -> CredentialParams {
    if let Some(row) = row {
        if row.version == VERSION_LEGACY {
            return CredentialParams::Legacy;
        }
        if row.version == VERSION_ONE_PASSWORD {
            if let (Some(salt), Some(kdf)) = (
                row.salt.as_deref(),
                row.kdf.as_deref().and_then(KdfParams::from_db_text),
            ) {
                return CredentialParams::OnePassword {
                    kdf,
                    salt: salt.to_string(),
                    epoch: row.epoch,
                };
            }
            tracing::error!(
                user_id = row.user_id,
                "one-password account has no usable salt or KDF; answering fake parameters"
            );
        }
    }
    CredentialParams::OnePassword {
        kdf: KdfParams::default_scrypt(),
        salt: fake_salt(jwt_secret, identifier),
        epoch: 1,
    }
}

fn db_now(now: DateTime<Utc>) -> String {
    now.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(e) if e.is_unique_violation())
}

/// What storing a first one-password credential found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstCredential {
    /// Stored. `public_key_set` is true when the account had no identity
    /// before and now has this one.
    Stored { public_key_set: bool },
    /// The account is no longer at the expected version (or its legacy
    /// password changed meanwhile). Nothing changed.
    NotCurrent,
    /// The account already has a different identity public key. Nothing
    /// changed.
    IdentityMismatch,
    /// Another account already uses this public key. Nothing changed.
    PublicKeyTaken,
}

/// Give an account its first one-password credential and the key backup,
/// inside the caller's transaction (sign-up, claim, v1 move).
///
/// Holds only while the account is at `from_version` and, when
/// `expected_password_hash` is given, still has that hash. The account's
/// existing public key, if any, must equal the new identity's; a missing one
/// is set. On any outcome but `Stored`, the caller rolls back.
pub async fn store_first_credential(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: i64,
    from_version: i32,
    expected_password_hash: Option<&str>,
    credential: &CheckedCredential,
    password_hash: &str,
    identity: &CheckedIdentity,
    now: DateTime<Utc>,
) -> Result<FirstCredential, CoreError> {
    // Take the row lock first (SQLite write lock / PostgreSQL row lock) so the
    // reads below cannot go stale before the writes.
    let locked = sqlx::query(
        "UPDATE users SET id = id
         WHERE id = $1 AND credential_version = $2 AND ($3 = FALSE OR password_hash = $4)",
    )
    .bind(user_id)
    .bind(from_version)
    .bind(expected_password_hash.is_some())
    .bind(expected_password_hash.unwrap_or_default())
    .execute(&mut **tx)
    .await
    .map_err(paracord_db::DbError::from)?;
    if locked.rows_affected() != 1 {
        return Ok(FirstCredential::NotCurrent);
    }
    let (current_key,): (Option<String>,) =
        sqlx::query_as("SELECT public_key FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(paracord_db::DbError::from)?;
    if let Some(current) = current_key.as_deref() {
        if !current.eq_ignore_ascii_case(&identity.public_key) {
            return Ok(FirstCredential::IdentityMismatch);
        }
    }
    if !paracord_db::credentials::set_first_one_password(
        &mut **tx,
        user_id,
        from_version,
        password_hash,
        &credential.salt,
        &credential.kdf,
        now,
    )
    .await?
    {
        return Ok(FirstCredential::NotCurrent);
    }
    let public_key_set = current_key.is_none();
    if public_key_set {
        let result = sqlx::query(
            "UPDATE users SET public_key = $2, updated_at = $3
             WHERE id = $1 AND public_key IS NULL",
        )
        .bind(user_id)
        .bind(&identity.public_key)
        .bind(db_now(now))
        .execute(&mut **tx)
        .await;
        match result {
            Err(err) if is_unique_violation(&err) => return Ok(FirstCredential::PublicKeyTaken),
            Err(err) => return Err(paracord_db::DbError::from(err).into()),
            Ok(done) if done.rows_affected() != 1 => return Ok(FirstCredential::NotCurrent),
            Ok(_) => {}
        }
    }
    paracord_db::key_backups::put(
        &mut **tx,
        user_id,
        &identity.public_key,
        &identity.wrapped_key,
        WRAP_ALG_V2,
        1,
        now,
    )
    .await?;
    Ok(FirstCredential::Stored { public_key_set })
}

/// Replace a one-password credential and re-wrap the backup of the same
/// identity, inside the caller's transaction (change §3.7, phrase reset §3.8).
///
/// Holds only while the account is version 2 at `expected_epoch` (and, when
/// given, still has `expected_password_hash`) and while `keep_session_id` is a
/// live session of the account. Revokes every other session and retires
/// outstanding email-reset tokens. Returns the new epoch, or `None` when the
/// account moved on meanwhile (nothing changed; the caller rolls back).
#[allow(clippy::too_many_arguments)]
pub async fn replace_credential(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: i64,
    expected_epoch: i64,
    expected_password_hash: Option<&str>,
    credential: &CheckedCredential,
    password_hash: &str,
    public_key: &str,
    wrapped_key: &str,
    keep_session_id: &str,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<Option<i64>, CoreError> {
    let locked = sqlx::query(
        "UPDATE users SET id = id
         WHERE id = $1 AND credential_version = $2 AND credential_epoch = $3
           AND public_key = $4 AND ($5 = FALSE OR password_hash = $6)",
    )
    .bind(user_id)
    .bind(VERSION_ONE_PASSWORD)
    .bind(expected_epoch)
    .bind(public_key)
    .bind(expected_password_hash.is_some())
    .bind(expected_password_hash.unwrap_or_default())
    .execute(&mut **tx)
    .await
    .map_err(paracord_db::DbError::from)?;
    if locked.rows_affected() != 1 {
        return Ok(None);
    }
    let session = sqlx::query(
        "UPDATE auth_sessions SET id = id WHERE id = $1 AND user_id = $2
         AND revoked_at IS NULL AND expires_at > $3",
    )
    .bind(keep_session_id)
    .bind(user_id)
    .bind(db_now(now))
    .execute(&mut **tx)
    .await
    .map_err(paracord_db::DbError::from)?;
    if session.rows_affected() != 1 {
        return Err(CoreError::Conflict(
            "This session ended while the password was changing. Sign in again.".into(),
        ));
    }
    let Some(epoch) = paracord_db::credentials::replace_one_password(
        &mut **tx,
        user_id,
        expected_epoch,
        password_hash,
        &credential.salt,
        &credential.kdf,
        now,
    )
    .await?
    else {
        return Ok(None);
    };
    paracord_db::key_backups::put(
        &mut **tx,
        user_id,
        public_key,
        wrapped_key,
        WRAP_ALG_V2,
        epoch,
        now,
    )
    .await?;
    revoke_sessions(tx, user_id, Some(keep_session_id), reason, now).await?;
    Ok(Some(epoch))
}

/// The email reset of a one-password account ("Start over", §3.9), inside
/// the caller's transaction: spend the reset token, replace the credential,
/// install the brand-new identity, drop the old prekeys and backup, revoke
/// every session.
///
/// Returns the new epoch, or `None` when the token is no longer valid for this
/// account or the account is not (or no longer) at `expected_epoch`. The
/// caller rolls back on `None` and on `PublicKeyTaken`.
pub async fn start_over(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: i64,
    token_hash: &str,
    expected_epoch: i64,
    credential: &CheckedCredential,
    password_hash: &str,
    identity: &CheckedIdentity,
    now: DateTime<Utc>,
) -> Result<StartOver, CoreError> {
    let locked = sqlx::query(
        "UPDATE users SET id = id WHERE id = $1 AND credential_version = $2 AND credential_epoch = $3",
    )
    .bind(user_id)
    .bind(VERSION_ONE_PASSWORD)
    .bind(expected_epoch)
    .execute(&mut **tx)
    .await
    .map_err(paracord_db::DbError::from)?;
    if locked.rows_affected() != 1 {
        return Ok(StartOver::NotCurrent);
    }
    let consumed = sqlx::query(
        "UPDATE password_reset_tokens SET used_at = $3
         WHERE token_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > $3",
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(db_now(now))
    .execute(&mut **tx)
    .await
    .map_err(paracord_db::DbError::from)?;
    if consumed.rows_affected() != 1 {
        return Ok(StartOver::NotCurrent);
    }
    let Some(epoch) = paracord_db::credentials::replace_one_password(
        &mut **tx,
        user_id,
        expected_epoch,
        password_hash,
        &credential.salt,
        &credential.kdf,
        now,
    )
    .await?
    else {
        return Ok(StartOver::NotCurrent);
    };
    let result = sqlx::query("UPDATE users SET public_key = $2, updated_at = $3 WHERE id = $1")
        .bind(user_id)
        .bind(&identity.public_key)
        .bind(db_now(now))
        .execute(&mut **tx)
        .await;
    match result {
        Err(err) if is_unique_violation(&err) => return Ok(StartOver::PublicKeyTaken),
        Err(err) => return Err(paracord_db::DbError::from(err).into()),
        Ok(_) => {}
    }
    for table in ["signed_prekeys", "one_time_prekeys"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id = $1"))
            .bind(user_id)
            .execute(&mut **tx)
            .await
            .map_err(paracord_db::DbError::from)?;
    }
    paracord_db::key_backups::delete(&mut **tx, user_id).await?;
    paracord_db::key_backups::put(
        &mut **tx,
        user_id,
        &identity.public_key,
        &identity.wrapped_key,
        WRAP_ALG_V2,
        epoch,
        now,
    )
    .await?;
    revoke_sessions(tx, user_id, None, "password_reset", now).await?;
    Ok(StartOver::Done { epoch })
}

/// What [`start_over`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartOver {
    Done { epoch: i64 },
    NotCurrent,
    PublicKeyTaken,
}

/// Revoke the account's sessions except `keep`, and retire every outstanding
/// email-reset token (a completed change or recovery supersedes them).
async fn revoke_sessions(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: i64,
    keep: Option<&str>,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), CoreError> {
    let sql = if keep.is_some() {
        "UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3
         WHERE user_id = $1 AND revoked_at IS NULL AND id != $4"
    } else {
        "UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3
         WHERE user_id = $1 AND revoked_at IS NULL"
    };
    let mut query = sqlx::query(sql)
        .bind(user_id)
        .bind(db_now(now))
        .bind(reason);
    if let Some(keep) = keep {
        query = query.bind(keep);
    }
    query
        .execute(&mut **tx)
        .await
        .map_err(paracord_db::DbError::from)?;
    sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(paracord_db::DbError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn credential(salt: &str, auth_key: &str, log_n: u8) -> NewCredential {
        NewCredential {
            salt: salt.into(),
            auth_key: auth_key.into(),
            kdf: KdfParams {
                log_n,
                ..KdfParams::default_scrypt()
            },
        }
    }

    #[test]
    fn credential_checks_lengths_and_floor() {
        let k32 = b64url().encode([7u8; 32]);
        let k31 = b64url().encode([7u8; 31]);
        let padded = base64::engine::general_purpose::URL_SAFE.encode([7u8; 32]);
        assert!(check_credential(&credential(&k32, &k32, 17)).is_ok());
        assert!(check_credential(&credential(&k32, &k32, 20)).is_ok());
        assert!(check_credential(&credential(&k31, &k32, 17)).is_err());
        assert!(check_credential(&credential(&k32, &k31, 17)).is_err());
        assert!(check_credential(&credential(&padded, &k32, 17)).is_err());
        assert!(check_credential(&credential(&k32, &k32, 16)).is_err());
        assert!(check_credential(&credential(&k32, &k32, 21)).is_err());
        let mut heavy_r = credential(&k32, &k32, 20);
        heavy_r.kdf.r = 16;
        assert!(check_credential(&heavy_r).is_err());
        let mut heavy_p = credential(&k32, &k32, 18);
        heavy_p.kdf.p = 5;
        assert!(check_credential(&heavy_p).is_err());
        let mut fine_r = credential(&k32, &k32, 17);
        fine_r.kdf.r = 16;
        assert!(check_credential(&fine_r).is_ok());
        let mut weak_r = credential(&k32, &k32, 17);
        weak_r.kdf.r = 4;
        assert!(check_credential(&weak_r).is_err());
        let mut argon = credential(&k32, &k32, 17);
        argon.kdf.alg = "argon2id".into();
        assert!(check_credential(&argon).is_err());
    }

    #[test]
    fn auth_key_hash_round_trips_and_rejects_text_passwords() {
        let key = [9u8; 32];
        let hash = hash_auth_key(&key).unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_auth_key(&key, &hash));
        assert!(!verify_auth_key(&[8u8; 32], &hash));
        // The legacy verifier hashes the typed text; the b64url of the key is
        // not the key.
        let text = b64url().encode(key);
        assert!(!crate::auth::verify_password(&text, &hash).unwrap());
        assert!(!verify_auth_key(&key, "!federated!"));
    }

    #[test]
    fn fake_salt_is_stable_case_insensitive_and_secret_bound() {
        let a = fake_salt("secret", "Sam");
        assert_eq!(a, fake_salt("secret", " sam "));
        assert_ne!(a, fake_salt("secret", "sam2"));
        assert_ne!(a, fake_salt("other", "sam"));
        assert_eq!(decode_b64url_exact::<32>(&a).map(|b| b.len()), Some(32));
    }

    #[test]
    fn proofs_are_bound_to_their_purpose() {
        let signing = SigningKey::from_bytes(&[3u8; 32]);
        let public = paracord_util::hex::hex_encode(signing.verifying_key().as_bytes());
        let message = proof_message(PURPOSE_REGISTER, "n", 5, "https://o");
        assert_eq!(message, "paracord/credential/v2/register:n:5:https://o");
        let sig = paracord_util::hex::hex_encode(&signing.sign(message.as_bytes()).to_bytes());
        assert!(verify_proof_signature(
            PURPOSE_REGISTER,
            &public,
            "n",
            5,
            "https://o",
            &sig
        ));
        assert!(!verify_proof_signature(
            PURPOSE_RESET,
            &public,
            "n",
            5,
            "https://o",
            &sig
        ));
        assert!(!verify_proof_signature(
            PURPOSE_REGISTER,
            &public,
            "n",
            6,
            "https://o",
            &sig
        ));
        // The plain key sign-in message is not a credential proof.
        let plain = paracord_util::hex::hex_encode(&signing.sign(b"n:5:https://o").to_bytes());
        assert!(!verify_proof_signature(
            PURPOSE_REGISTER,
            &public,
            "n",
            5,
            "https://o",
            &plain
        ));
    }

    #[test]
    fn identity_checks_key_and_wrap() {
        let signing = SigningKey::from_bytes(&[3u8; 32]);
        let public = paracord_util::hex::hex_encode(signing.verifying_key().as_bytes());
        let identity = |public_key: &str, wrapped: &[u8], alg: &str| NewIdentity {
            public_key: public_key.into(),
            wrapped_key: b64url().encode(wrapped),
            wrap_alg: alg.into(),
            proof: paracord_contracts::credential::IdentityProof {
                nonce: String::new(),
                timestamp: 0,
                signature: String::new(),
            },
        };
        assert!(check_identity(&identity(&public, &[0u8; 60], WRAP_ALG_V2)).is_ok());
        assert!(check_identity(&identity(&public, &[0u8; 59], WRAP_ALG_V2)).is_err());
        assert!(check_identity(&identity(&public, &[0u8; 61], WRAP_ALG_V2)).is_err());
        assert!(check_identity(&identity(&public, &[0u8; 60], "aes256gcm")).is_err());
        assert!(
            check_identity(&identity(&public.to_uppercase(), &[0u8; 60], WRAP_ALG_V2)).is_err()
        );
        assert!(check_identity(&identity(&public[2..], &[0u8; 60], WRAP_ALG_V2)).is_err());
        // The identity point (a small-order key) is refused.
        let small = format!("01{}", "00".repeat(31));
        assert!(check_identity(&identity(&small, &[0u8; 60], WRAP_ALG_V2)).is_err());
    }

    #[test]
    fn params_never_reveal_missing_or_key_only_accounts() {
        let row = |version: i32| CredentialRow {
            user_id: 1,
            version,
            salt: (version == 2).then(|| "real".to_string()),
            kdf: (version == 2).then(|| "scrypt:18:8:1".to_string()),
            epoch: if version == 2 { 4 } else { 0 },
            password_hash: String::new(),
            public_key: None,
        };
        assert_eq!(
            params_for(Some(&row(1)), "s", "a"),
            CredentialParams::Legacy
        );
        assert_eq!(
            params_for(Some(&row(2)), "s", "a"),
            CredentialParams::OnePassword {
                kdf: KdfParams::from_db_text("scrypt:18:8:1").unwrap(),
                salt: "real".into(),
                epoch: 4
            }
        );
        let fake = params_for(None, "s", "a");
        assert_eq!(params_for(Some(&row(0)), "s", "a"), fake);
        assert_eq!(
            fake,
            CredentialParams::OnePassword {
                kdf: KdfParams::default_scrypt(),
                salt: fake_salt("s", "a"),
                epoch: 1
            }
        );
    }
}
