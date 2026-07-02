use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct MfaConfigRow {
    pub user_id: i64,
    pub totp_secret: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MfaConfigRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            totp_secret: row.try_get("totp_secret")?,
            enabled: bool_from_any_row(row, "enabled")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct MfaBackupCodeRow {
    pub id: i64,
    pub user_id: i64,
    pub code_hash: String,
    pub used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MfaBackupCodeRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let used_at_raw: Option<String> = row.try_get("used_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            user_id: row.try_get("user_id")?,
            code_hash: row.try_get("code_hash")?,
            used_at: used_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

/// Get MFA config for a user. Returns None if MFA has never been configured.
pub async fn get_mfa_config(pool: &DbPool, user_id: i64) -> Result<Option<MfaConfigRow>, DbError> {
    let row = sqlx::query_as::<_, MfaConfigRow>(
        "SELECT user_id, totp_secret, CASE WHEN enabled THEN 1 ELSE 0 END AS enabled, created_at, updated_at
         FROM mfa_configs WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Upsert a TOTP secret for setup (enabled=false until verified).
pub async fn upsert_mfa_secret(
    pool: &DbPool,
    user_id: i64,
    totp_secret: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO mfa_configs (user_id, totp_secret, enabled)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET
            totp_secret = $2,
            enabled = FALSE,
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(user_id)
    .bind(totp_secret)
    .execute(pool)
    .await?;
    Ok(())
}

/// Enable MFA after TOTP code verified. Also updates users.mfa_enabled.
pub async fn enable_mfa(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "UPDATE mfa_configs SET enabled = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE users SET mfa_enabled = TRUE, updated_at = datetime('now')
         WHERE id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Disable MFA for a user.
pub async fn disable_mfa(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM mfa_configs WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE users SET mfa_enabled = FALSE, updated_at = datetime('now') WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

/// Store backup codes (hashed). Replaces any existing ones.
pub async fn store_backup_codes(
    pool: &DbPool,
    user_id: i64,
    code_hashes: &[String],
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    for hash in code_hashes {
        sqlx::query("INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)")
            .bind(user_id)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Get all unused backup codes for a user.
pub async fn get_unused_backup_codes(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<MfaBackupCodeRow>, DbError> {
    let rows = sqlx::query_as::<_, MfaBackupCodeRow>(
        "SELECT id, user_id, code_hash, used_at, created_at
         FROM mfa_backup_codes
         WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Consume a backup code. Returns true if it was valid and unused.
pub async fn consume_backup_code(
    pool: &DbPool,
    user_id: i64,
    code_hash: &str,
    _now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE mfa_backup_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    )
    .bind(user_id)
    .bind(code_hash)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
