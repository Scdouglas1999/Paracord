//! Server-held wrapped identities (`account_key_backups`, setup spec §3.1,
//! §3.4, §3.6, §9.3).
//!
//! One row per account: the identity public key and the private key wrapped
//! under the password-derived wrap key, which the server can never compute.
//! `credential_epoch` is the epoch of the credential whose wrap key wrapped
//! it. `recovery_confirmed` records that the person ticked "I wrote down my
//! recovery phrase", so any device can show the phrase screen until they have.
//!
//! Booleans are bound as Rust `bool` and read through `CAST(col AS INTEGER)`;
//! timestamps are TEXT written by `datetime_to_db_text` (CLAUDE.md).

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBackupRow {
    pub user_id: i64,
    /// hex.
    pub public_key: String,
    /// b64url `iv12 || ciphertext+tag`.
    pub wrapped_key: String,
    pub wrap_alg: String,
    pub credential_epoch: i64,
    pub recovery_confirmed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for KeyBackupRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at: String = row.try_get("created_at")?;
        let updated_at: String = row.try_get("updated_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            public_key: row.try_get("public_key")?,
            wrapped_key: row.try_get("wrapped_key")?,
            wrap_alg: row.try_get("wrap_alg")?,
            credential_epoch: row.try_get::<i64, _>("credential_epoch")?,
            recovery_confirmed: bool_from_any_row(row, "recovery_confirmed")?,
            created_at: datetime_from_db_text(&created_at)?,
            updated_at: datetime_from_db_text(&updated_at)?,
        })
    }
}

const SELECT_COLUMNS: &str = "user_id, public_key, wrapped_key, wrap_alg, \
     CAST(credential_epoch AS BIGINT) AS credential_epoch, \
     CAST(recovery_confirmed AS INTEGER) AS recovery_confirmed, created_at, updated_at";

/// The backup of `user_id`, if the account has one.
pub async fn get<'e, E>(executor: E, user_id: i64) -> Result<Option<KeyBackupRow>, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query_as::<_, KeyBackupRow>(&format!(
        "SELECT {SELECT_COLUMNS} FROM account_key_backups WHERE user_id = $1"
    ))
    .bind(user_id)
    .fetch_optional(executor)
    .await?;
    Ok(row)
}

/// Store the backup of `user_id`, replacing any previous one.
///
/// `recovery_confirmed` survives a replacement that keeps the same identity
/// (a password change re-wraps the same key, so the phrase written down is
/// still the right one) and resets when the identity changes (Start over makes
/// a new identity and a new phrase).
pub async fn put<'e, E>(
    executor: E,
    user_id: i64,
    public_key: &str,
    wrapped_key: &str,
    wrap_alg: &str,
    credential_epoch: i64,
    now: DateTime<Utc>,
) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let now = datetime_to_db_text(now);
    sqlx::query(
        "INSERT INTO account_key_backups
             (user_id, public_key, wrapped_key, wrap_alg, credential_epoch,
              recovery_confirmed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (user_id) DO UPDATE SET
             wrapped_key = excluded.wrapped_key,
             wrap_alg = excluded.wrap_alg,
             credential_epoch = excluded.credential_epoch,
             recovery_confirmed = CASE
                 WHEN account_key_backups.public_key = excluded.public_key
                 THEN account_key_backups.recovery_confirmed
                 ELSE excluded.recovery_confirmed
             END,
             public_key = excluded.public_key,
             updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(public_key)
    .bind(wrapped_key)
    .bind(wrap_alg)
    .bind(credential_epoch)
    .bind(false)
    .bind(now)
    .execute(executor)
    .await?;
    Ok(())
}

/// Record that the person confirmed they wrote down the recovery phrase.
/// Returns `false` when the account has no backup.
pub async fn set_recovery_confirmed<'e, E>(
    executor: E,
    user_id: i64,
    now: DateTime<Utc>,
) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let affected = sqlx::query(
        "UPDATE account_key_backups SET recovery_confirmed = $1, updated_at = $2
         WHERE user_id = $3",
    )
    .bind(true)
    .bind(datetime_to_db_text(now))
    .bind(user_id)
    .execute(executor)
    .await?
    .rows_affected();
    Ok(affected == 1)
}

/// Delete the backup of `user_id`. Returns whether there was one.
pub async fn delete<'e, E>(executor: E, user_id: i64) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let affected = sqlx::query("DELETE FROM account_key_backups WHERE user_id = $1")
        .bind(user_id)
        .execute(executor)
        .await?
        .rows_affected();
    Ok(affected == 1)
}
