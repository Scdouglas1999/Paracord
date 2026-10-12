//! The password credential of an account (setup spec §3.4, §3.13, §9.3).
//!
//! `users.credential_version` is 0 for key-only accounts (no usable password),
//! 1 for a legacy password (Argon2id of the password) and 2 for one password
//! (Argon2id of the derived auth key, plus the salt and KDF parameters the
//! client derives it with). The version only ever increases: every write here
//! is a conditional `UPDATE … WHERE credential_version = <expected>`, so a
//! concurrent writer or a replayed request can never move an account back to
//! the older scheme. Password changes are additionally conditional on the
//! epoch they started from, so two concurrent changes cannot both win.
//!
//! The KDF parameters are stored as text (`"scrypt:17:8:1"`); the parsing and
//! policy live with the wire type, `paracord_contracts::credential::KdfParams`.

use crate::{datetime_to_db_text, DbError};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// No usable password: public-key sign-up, system and federated accounts.
pub const VERSION_KEY_ONLY: i32 = 0;
/// A legacy password, verified as typed.
pub const VERSION_LEGACY: i32 = 1;
/// One password: the server holds Argon2id of the derived auth key.
pub const VERSION_ONE_PASSWORD: i32 = 2;

/// The credential columns of one account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRow {
    pub user_id: i64,
    pub version: i32,
    /// b64url salt; `Some` exactly when `version == 2`.
    pub salt: Option<String>,
    /// `"scrypt:<log_n>:<r>:<p>"`; `Some` exactly when `version == 2`.
    pub kdf: Option<String>,
    /// 0 until the account has one password; 1 at the first one-password
    /// credential; +1 on every change or reset.
    pub epoch: i64,
    /// PHC string: Argon2id of the password (v1) or of the auth key (v2).
    pub password_hash: String,
    /// hex identity public key, when the account has one.
    pub public_key: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for CredentialRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            user_id: row.try_get("id")?,
            version: row.try_get::<i32, _>("credential_version")?,
            salt: row.try_get("credential_salt")?,
            kdf: row.try_get("credential_kdf")?,
            epoch: row.try_get::<i64, _>("credential_epoch")?,
            password_hash: row.try_get("password_hash")?,
            public_key: row.try_get("public_key")?,
        })
    }
}

const SELECT_COLUMNS: &str = "id, credential_version, credential_salt, credential_kdf, \
     CAST(credential_epoch AS BIGINT) AS credential_epoch, password_hash, public_key";

/// The credential of `user_id`, or `None` when there is no such account.
pub async fn get<'e, E>(executor: E, user_id: i64) -> Result<Option<CredentialRow>, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query_as::<_, CredentialRow>(&format!(
        "SELECT {SELECT_COLUMNS} FROM users WHERE id = $1"
    ))
    .bind(user_id)
    .fetch_optional(executor)
    .await?;
    Ok(row)
}

/// Give an account its first one-password credential, at epoch 1.
///
/// Used by sign-up and the claim (`from_version` is the version the account
/// was created with) and by the v1 move (`from_version = 1`, spec §3.11).
/// Applies only while the account is still at `from_version`; returns `false`
/// when it is not (already moved, or a concurrent request won), in which case
/// nothing changed.
pub async fn set_first_one_password<'e, E>(
    executor: E,
    user_id: i64,
    from_version: i32,
    password_hash: &str,
    salt: &str,
    kdf: &str,
    now: DateTime<Utc>,
) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    if from_version >= VERSION_ONE_PASSWORD {
        return Err(DbError::Conflict(format!(
            "credential version {from_version} cannot move to one password"
        )));
    }
    let affected = sqlx::query(
        "UPDATE users
         SET credential_version = $1, password_hash = $2, credential_salt = $3,
             credential_kdf = $4, credential_epoch = 1, updated_at = $5
         WHERE id = $6 AND credential_version = $7",
    )
    .bind(VERSION_ONE_PASSWORD)
    .bind(password_hash)
    .bind(salt)
    .bind(kdf)
    .bind(datetime_to_db_text(now))
    .bind(user_id)
    .bind(from_version)
    .execute(executor)
    .await?
    .rows_affected();
    Ok(affected == 1)
}

/// Replace a one-password credential (change, phrase reset, email reset) and
/// bump the epoch.
///
/// Applies only while the account is at version 2 **and** at
/// `expected_epoch`; returns the new epoch, or `None` when either no longer
/// holds (a concurrent change won, or the account is not a one-password
/// account), in which case nothing changed.
pub async fn replace_one_password<'e, E>(
    executor: E,
    user_id: i64,
    expected_epoch: i64,
    password_hash: &str,
    salt: &str,
    kdf: &str,
    now: DateTime<Utc>,
) -> Result<Option<i64>, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let new_epoch = expected_epoch
        .checked_add(1)
        .ok_or_else(|| DbError::Conflict("credential epoch overflow".into()))?;
    let affected = sqlx::query(
        "UPDATE users
         SET password_hash = $1, credential_salt = $2, credential_kdf = $3,
             credential_epoch = $4, updated_at = $5
         WHERE id = $6 AND credential_version = $7 AND credential_epoch = $8",
    )
    .bind(password_hash)
    .bind(salt)
    .bind(kdf)
    .bind(new_epoch)
    .bind(datetime_to_db_text(now))
    .bind(user_id)
    .bind(VERSION_ONE_PASSWORD)
    .bind(expected_epoch)
    .execute(executor)
    .await?
    .rows_affected();
    Ok((affected == 1).then_some(new_epoch))
}
