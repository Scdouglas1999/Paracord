//! First-owner claim: bootstrap credential handling and the atomic claim.
//!
//! A fresh instance starts `pending`. While pending nothing can create an
//! account except [`claim_instance`], which requires the one-time bootstrap
//! claim token the server printed on startup. That replaces the old behavior
//! where whoever registered first on a freshly exposed server silently became
//! its owner.

use crate::error::CoreError;
use chrono::Utc;
use paracord_db::{instance_setup, DbPool};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Minimum bootstrap-token entropy. 32 random bytes rendered as base32 gives a
/// 52-character token; an operator-supplied token must be at least as long as
/// that rendering so a short, guessable string can never stand in for it.
pub const MIN_CLAIM_TOKEN_LEN: usize = 32;

/// Longest instance name we accept. Matches `instance_setup.instance_name`.
pub const MAX_INSTANCE_NAME_LEN: usize = 100;
/// Space-name bounds, identical to `POST /api/v1/guilds`.
pub const MIN_SPACE_NAME_LEN: usize = 2;
pub const MAX_SPACE_NAME_LEN: usize = 100;

/// Crockford-style base32 alphabet: unambiguous when read off a terminal and
/// safe in a URL, a shell argument and a TOML string without quoting.
const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ0123456789";

/// Mint a fresh bootstrap claim token with at least 256 bits of entropy.
pub fn generate_claim_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    // 32 bytes -> 52 base32 characters (each character carries 5 bits).
    let mut out = String::with_capacity(52);
    let mut acc: u16 = 0;
    let mut bits: u8 = 0;
    for byte in bytes {
        acc = (acc << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((acc >> bits) & 0x1f) as usize;
            out.push(TOKEN_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((acc << (5 - bits)) & 0x1f) as usize;
        out.push(TOKEN_ALPHABET[index] as char);
    }
    out
}

/// Hash a bootstrap token for storage. The plaintext token is never persisted.
pub fn hash_claim_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// Compare a presented token against a stored hash without leaking, through
/// timing, how much of the token was correct.
pub fn claim_token_matches(presented: &str, stored_hash: &str) -> bool {
    let presented_hash = hash_claim_token(presented);
    let a = presented_hash.as_bytes();
    let b = stored_hash.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Validate an operator-supplied instance name.
pub fn validate_instance_name(name: &str) -> Result<String, CoreError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CoreError::BadRequest("Instance name is required".into()));
    }
    if trimmed.chars().count() > MAX_INSTANCE_NAME_LEN {
        return Err(CoreError::BadRequest(format!(
            "Instance name must be at most {MAX_INSTANCE_NAME_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// Validate the first space's name using the same bounds as space creation.
pub fn validate_space_name(name: &str) -> Result<String, CoreError> {
    let trimmed = name.trim();
    let len = trimmed.chars().count();
    if !(MIN_SPACE_NAME_LEN..=MAX_SPACE_NAME_LEN).contains(&len) {
        return Err(CoreError::BadRequest(format!(
            "Space name must be between {MIN_SPACE_NAME_LEN} and {MAX_SPACE_NAME_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// What a successful claim produced.
pub struct ClaimOutcome {
    pub owner: paracord_db::users::UserRow,
    pub space: paracord_db::guilds::GuildRow,
    pub instance_name: String,
}

/// Create the owner account, the first space and the completed setup record.
///
/// The three writes are sequenced so that the instance can never be left with a
/// half-built owner: every step that fails after a preceding step committed
/// rolls the preceding ones back and returns the original error. The
/// `pending -> complete` transition is a single conditional UPDATE, so two
/// concurrent claims cannot both succeed — the loser rolls its own account and
/// space back and reports a conflict.
///
/// `password_hash` must already be produced by [`crate::auth::hash_password`]
/// and the username/email/password must already have passed the same validation
/// ordinary registration applies. This function deliberately does not re-derive
/// those rules so the claim page and the registration page can never drift.
pub async fn claim_instance(
    pool: &DbPool,
    username: &str,
    email: &str,
    password_hash: &str,
    instance_name: &str,
    space_name: &str,
    space_icon: Option<&str>,
) -> Result<ClaimOutcome, CoreError> {
    claim(
        pool,
        username,
        email,
        password_hash,
        None,
        instance_name,
        space_name,
        space_icon,
        None,
    )
    .await
}

/// The one-password claim (`POST /setup/credential-claim`, docs/setup-spec.md
/// §2.7, §2.11, §3.3): the owner gets a one-password credential, the identity
/// and its key backup, and the first server is built from `template` with the
/// chosen `hue`.
///
/// `credential` and `identity` must already have passed
/// [`crate::credential::check_credential`] / [`crate::credential::check_identity`]
/// and the identity proof must already be verified. Any failure rolls the whole
/// claim back, as [`claim_instance`] does.
#[allow(clippy::too_many_arguments)]
pub async fn claim_instance_one_password(
    pool: &DbPool,
    username: &str,
    email: &str,
    credential: &crate::credential::CheckedCredential,
    identity: &crate::credential::CheckedIdentity,
    instance_name: &str,
    space_name: &str,
    space_icon: Option<&str>,
    hue: u16,
    template: paracord_contracts::credential::InitialServerTemplate,
) -> Result<ClaimOutcome, CoreError> {
    let password_hash = credential.hash()?;
    claim(
        pool,
        username,
        email,
        &password_hash,
        Some((credential, identity)),
        instance_name,
        space_name,
        space_icon,
        Some((hue, template)),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn claim(
    pool: &DbPool,
    username: &str,
    email: &str,
    password_hash: &str,
    one_password: Option<(
        &crate::credential::CheckedCredential,
        &crate::credential::CheckedIdentity,
    )>,
    instance_name: &str,
    space_name: &str,
    space_icon: Option<&str>,
    template: Option<(u16, paracord_contracts::credential::InitialServerTemplate)>,
) -> Result<ClaimOutcome, CoreError> {
    let instance_name = validate_instance_name(instance_name)?;
    let space_name = validate_space_name(space_name)?;

    let owner_id = paracord_util::snowflake::generate(1);
    let mut owner = paracord_db::users::create_user_as_first_admin(
        pool,
        owner_id,
        username,
        0,
        email,
        password_hash,
        crate::USER_FLAG_ADMIN,
    )
    .await?;

    // `create_user_as_first_admin` only grants the admin flag when it wins the
    // first-admin slot. A pending instance has never had a user, so losing that
    // race means the database is in a state this code does not understand —
    // fail loudly rather than hand the operator a powerless "owner".
    if owner.flags & crate::USER_FLAG_ADMIN == 0 {
        rollback_owner(pool, owner.id).await;
        return Err(CoreError::Internal(
            "the first-admin slot was already taken on an unclaimed instance; refusing to create an owner without administrator rights".into(),
        ));
    }

    // The account row was inserted as a legacy password (an Argon2 hash); the
    // one-password credential, identity and backup move it to version 2 in one
    // transaction before anything else is built on it.
    if let Some((credential, identity)) = one_password {
        match store_owner_credential(pool, owner.id, password_hash, credential, identity).await {
            Ok(()) => owner.public_key = Some(identity.public_key.clone()),
            Err(err) => {
                rollback_owner(pool, owner.id).await;
                return Err(err);
            }
        }
    }

    let space_id = paracord_util::snowflake::generate(1);
    let created = match template {
        None => {
            crate::guild::create_guild_full(pool, space_id, &space_name, owner.id, space_icon).await
        }
        Some((hue, template)) => {
            crate::guild::create_guild_from_template(
                pool,
                space_id,
                &space_name,
                owner.id,
                space_icon,
                hue,
                template,
            )
            .await
        }
    };
    let space = match created {
        Ok(space) => space,
        Err(err) => {
            rollback_owner(pool, owner.id).await;
            return Err(err);
        }
    };

    let completed = instance_setup::complete_claim(pool, owner.id, &instance_name, Utc::now())
        .await
        .map_err(CoreError::from);
    match completed {
        Ok(true) => Ok(ClaimOutcome {
            owner,
            space,
            instance_name,
        }),
        Ok(false) => {
            rollback_space(pool, space.id).await;
            rollback_owner(pool, owner.id).await;
            Err(CoreError::Conflict(
                "This instance has already been claimed".into(),
            ))
        }
        Err(err) => {
            rollback_space(pool, space.id).await;
            rollback_owner(pool, owner.id).await;
            Err(err)
        }
    }
}

async fn store_owner_credential(
    pool: &DbPool,
    owner_id: i64,
    password_hash: &str,
    credential: &crate::credential::CheckedCredential,
    identity: &crate::credential::CheckedIdentity,
) -> Result<(), CoreError> {
    use crate::credential::FirstCredential;
    let mut tx = pool.begin().await.map_err(paracord_db::DbError::from)?;
    let stored = crate::credential::store_first_credential(
        &mut tx,
        owner_id,
        paracord_db::credentials::VERSION_LEGACY,
        Some(password_hash),
        credential,
        password_hash,
        identity,
        Utc::now(),
    )
    .await?;
    match stored {
        FirstCredential::Stored { .. } => {
            tx.commit().await.map_err(paracord_db::DbError::from)?;
            Ok(())
        }
        FirstCredential::PublicKeyTaken => Err(CoreError::BadRequest(
            "Unable to complete registration".into(),
        )),
        FirstCredential::NotCurrent | FirstCredential::IdentityMismatch => Err(
            CoreError::Internal("the new owner account changed during the claim".into()),
        ),
    }
}

/// Undo a partially built claim. A failure here cannot be propagated (the
/// original error is what the caller must see), so it is logged loudly instead:
/// a leftover row would block the retry with a "username taken" error that says
/// nothing about what actually happened.
async fn rollback_owner(pool: &DbPool, owner_id: i64) {
    if let Err(err) = paracord_db::users::delete_unused_account(pool, owner_id).await {
        tracing::error!(
            owner_id,
            error = %err,
            "failed to roll back the partially created instance owner; the claim must be retried with a different username"
        );
    }
    // The owner account consumed the one-time first-admin slot on its way in.
    // Releasing it is what lets the retry produce a real administrator instead
    // of a silently powerless account.
    if let Err(err) = paracord_db::users::release_first_admin_slot(pool).await {
        tracing::error!(
            error = %err,
            "failed to release the first-admin slot after a rolled-back claim"
        );
    }
}

async fn rollback_space(pool: &DbPool, space_id: i64) {
    if let Err(err) = paracord_db::guilds::delete_guild(pool, space_id).await {
        tracing::error!(
            space_id,
            error = %err,
            "failed to roll back the partially created initial space"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_long_and_unique() {
        let a = generate_claim_token();
        let b = generate_claim_token();
        assert_eq!(a.len(), 52);
        assert!(a.len() >= MIN_CLAIM_TOKEN_LEN);
        assert_ne!(a, b);
        assert!(a.bytes().all(|c| TOKEN_ALPHABET.contains(&c)));
    }

    #[test]
    fn token_comparison_is_hash_based() {
        let token = generate_claim_token();
        let hash = hash_claim_token(&token);
        assert!(claim_token_matches(&token, &hash));
        assert!(!claim_token_matches("wrong", &hash));
        assert!(!claim_token_matches(&token, "not-a-hash"));
        assert!(!claim_token_matches("", &hash));
    }

    #[test]
    fn instance_name_bounds() {
        assert_eq!(validate_instance_name("  Example  ").unwrap(), "Example");
        assert!(validate_instance_name("   ").is_err());
        assert!(validate_instance_name(&"a".repeat(MAX_INSTANCE_NAME_LEN)).is_ok());
        assert!(validate_instance_name(&"a".repeat(MAX_INSTANCE_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn space_name_bounds() {
        assert_eq!(validate_space_name(" Lounge ").unwrap(), "Lounge");
        assert!(validate_space_name("a").is_err());
        assert!(validate_space_name(&"a".repeat(MAX_SPACE_NAME_LEN + 1)).is_err());
    }
}
