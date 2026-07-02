use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct PasswordResetTokenRow {
    pub token_hash: String,
    pub user_id: i64,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for PasswordResetTokenRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let expires_at_raw: String = row.try_get("expires_at")?;
        let used_at_raw: Option<String> = row.try_get("used_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            token_hash: row.try_get("token_hash")?,
            user_id: row.try_get("user_id")?,
            expires_at: datetime_from_db_text(&expires_at_raw)?,
            used_at: used_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_reset_token(
    pool: &DbPool,
    token_hash: &str,
    user_id: i64,
    expires_at: DateTime<Utc>,
) -> Result<(), DbError> {
    let expires_str = expires_at.format("%Y-%m-%d %H:%M:%S").to_string();
    sqlx::query(
        "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)",
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(expires_str)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_valid_reset_token(
    pool: &DbPool,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<Option<PasswordResetTokenRow>, DbError> {
    let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let row = sqlx::query_as::<_, PasswordResetTokenRow>(
        "SELECT token_hash, user_id, expires_at, used_at, created_at
         FROM password_reset_tokens
         WHERE token_hash = $1
           AND expires_at > $2
           AND used_at IS NULL",
    )
    .bind(token_hash)
    .bind(now_str)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn mark_reset_token_used(
    pool: &DbPool,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let result = sqlx::query(
        "UPDATE password_reset_tokens
         SET used_at = $2
         WHERE token_hash = $1 AND used_at IS NULL",
    )
    .bind(token_hash)
    .bind(now_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Delete expired or used tokens (cleanup).
pub async fn purge_old_reset_tokens(pool: &DbPool, before: DateTime<Utc>) -> Result<(), DbError> {
    let before_str = before.format("%Y-%m-%d %H:%M:%S").to_string();
    sqlx::query("DELETE FROM password_reset_tokens WHERE expires_at < $1 OR used_at IS NOT NULL")
        .bind(before_str)
        .execute(pool)
        .await?;
    Ok(())
}

/// Invalidate all existing unused reset tokens for a user (before creating a new one).
pub async fn invalidate_user_reset_tokens(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    // Mark all as used to prevent reuse (or just delete them)
    sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}
