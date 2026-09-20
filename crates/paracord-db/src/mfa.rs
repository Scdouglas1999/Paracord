use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
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

/// Upsert a *pending* TOTP secret for setup (enabled=false until verified).
///
/// The `ON CONFLICT` branch is guarded by `WHERE mfa_configs.enabled = FALSE`
/// so re-running setup can never overwrite the live secret or clear the
/// `enabled` flag of an account that already has MFA active. Weakening an
/// enabled account must go through `disable_mfa`, which requires a valid
/// current code. Returns `true` when the pending secret was written, `false`
/// when the write was refused because MFA is already enabled.
pub async fn upsert_mfa_secret(
    pool: &DbPool,
    user_id: i64,
    totp_secret: &str,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "INSERT INTO mfa_configs (user_id, totp_secret, enabled)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET
            totp_secret = $2,
            enabled = FALSE,
            last_used_step = -1,
            updated_at = datetime('now')
         WHERE mfa_configs.enabled = FALSE",
    )
    .bind(user_id)
    .bind(totp_secret)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Consume a matching TOTP step once, tied to the exact configuration verified.
/// A replaced pending secret cannot be authenticated using a stale read.
pub async fn claim_totp_step(
    pool: &DbPool,
    user_id: i64,
    verified_secret: &str,
    step: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE mfa_configs SET last_used_step = $3
         WHERE user_id = $1 AND totp_secret = $2 AND last_used_step < $3",
    )
    .bind(user_id)
    .bind(verified_secret)
    .bind(step)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Hold the account lock until its new session commits, rechecking credentials
/// and gates. `verified_secret=None` requires MFA to remain disabled; `Some`
/// requires the exact second factor that the caller verified to remain enabled.
pub async fn lock_login_credentials(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: i64,
    email: &str,
    primary_credential: &str,
    public_key_login: bool,
    verified_secret: Option<&str>,
    require_verified_email: bool,
) -> Result<bool, DbError> {
    let query = if public_key_login {
        "UPDATE users SET id = id WHERE id = $1 AND email = $2 AND public_key = $3
         AND ($4 = FALSE OR email_verified = TRUE)"
    } else {
        "UPDATE users SET id = id WHERE id = $1 AND email = $2 AND password_hash = $3
         AND ($4 = FALSE OR email_verified = TRUE)"
    };
    let locked = sqlx::query(query)
        .bind(user_id)
        .bind(email)
        .bind(primary_credential)
        .bind(require_verified_email)
        .execute(&mut **tx)
        .await?;
    if locked.rows_affected() != 1 {
        return Ok(false);
    }
    let current_secret: Option<String> = sqlx::query_scalar(
        "SELECT totp_secret FROM mfa_configs WHERE user_id = $1 AND enabled = TRUE",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(current_secret.as_deref() == verified_secret)
}

/// Commit verified enrollment and its backup codes as one operation. A concurrent
/// setup must not replace the secret after it was verified, nor may concurrent
/// enrollments overwrite backup codes that another caller has already received.
pub async fn enable_mfa_with_backup_codes(
    pool: &DbPool,
    user_id: i64,
    verified_secret: &str,
    code_hashes: &[String],
) -> Result<bool, DbError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET id = id WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let changed = sqlx::query(
        "UPDATE mfa_configs SET enabled = TRUE, updated_at = $3
         WHERE user_id = $1 AND totp_secret = $2 AND enabled = FALSE",
    )
    .bind(user_id)
    .bind(verified_secret)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Ok(false);
    }
    sqlx::query("UPDATE users SET mfa_enabled = TRUE, updated_at = $2 WHERE id = $1")
        .bind(user_id)
        .bind(datetime_to_db_text(Utc::now()))
        .execute(&mut *tx)
        .await?;
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
    Ok(true)
}

/// Enable MFA after TOTP code verified. Also updates users.mfa_enabled.
pub async fn enable_mfa(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET id = id WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "UPDATE mfa_configs SET enabled = TRUE, updated_at = datetime('now')
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE users SET mfa_enabled = TRUE, updated_at = $2
         WHERE id = $1",
    )
    .bind(user_id)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Disable MFA for a user.
pub async fn disable_mfa(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    disable_mfa_config(pool, user_id, None).await?;
    Ok(())
}

pub async fn disable_mfa_for_secret(
    pool: &DbPool,
    user_id: i64,
    verified_secret: &str,
) -> Result<bool, DbError> {
    disable_mfa_config(pool, user_id, Some(verified_secret)).await
}

async fn disable_mfa_config(
    pool: &DbPool,
    user_id: i64,
    verified_secret: Option<&str>,
) -> Result<bool, DbError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET id = id WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    let removed = sqlx::query("DELETE FROM mfa_configs WHERE user_id = $1 AND (CAST($2 AS TEXT) IS NULL OR totp_secret = $2)")
        .bind(user_id)
        .bind(verified_secret)
        .execute(&mut *tx)
        .await?;
    if verified_secret.is_some() && removed.rows_affected() != 1 {
        return Ok(false);
    }

    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE users SET mfa_enabled = FALSE, updated_at = $2 WHERE id = $1")
        .bind(user_id)
        .bind(datetime_to_db_text(Utc::now()))
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(true)
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
         SET used_at = datetime('now')
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    )
    .bind(user_id)
    .bind(code_hash)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations_for_engine(&pool, crate::DatabaseEngine::Sqlite)
            .await
            .unwrap();
        pool
    }

    async fn setup_user(pool: &DbPool) -> i64 {
        let user_id = 1;
        crate::users::create_user(pool, user_id, "alice", 1, "alice@example.com", "hash")
            .await
            .unwrap();
        user_id
    }

    #[tokio::test]
    async fn upsert_stores_pending_secret_when_no_config() {
        let pool = test_pool().await;
        let user_id = setup_user(&pool).await;

        let stored = upsert_mfa_secret(&pool, user_id, "secret-a").await.unwrap();
        assert!(stored, "first setup should store the pending secret");

        let cfg = get_mfa_config(&pool, user_id).await.unwrap().unwrap();
        assert_eq!(cfg.totp_secret, "secret-a");
        assert!(!cfg.enabled);
    }

    #[tokio::test]
    async fn upsert_refuses_to_weaken_enabled_config() {
        let pool = test_pool().await;
        let user_id = setup_user(&pool).await;

        // Complete a real setup + enable.
        upsert_mfa_secret(&pool, user_id, "secret-a").await.unwrap();
        enable_mfa(&pool, user_id).await.unwrap();

        // Re-running setup must NOT overwrite the live secret or clear `enabled`.
        let stored = upsert_mfa_secret(&pool, user_id, "attacker-secret")
            .await
            .unwrap();
        assert!(!stored, "setup must be refused while MFA is enabled");

        let cfg = get_mfa_config(&pool, user_id).await.unwrap().unwrap();
        assert!(cfg.enabled, "MFA must remain enabled after refused setup");
        assert_eq!(
            cfg.totp_secret, "secret-a",
            "live secret must not be overwritten"
        );
    }

    #[tokio::test]
    async fn totp_step_consumption_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}?mode=rwc", dir.path().join("mfa.db").display());
        let pool = crate::create_pool(&url, 2).await.unwrap();
        crate::run_migrations_for_engine(&pool, crate::DatabaseEngine::Sqlite)
            .await
            .unwrap();
        let user = setup_user(&pool).await;
        upsert_mfa_secret(&pool, user, "secret-a").await.unwrap();
        assert!(claim_totp_step(&pool, user, "secret-a", 57_000_000)
            .await
            .unwrap());
        pool.close().await;

        let reopened = crate::create_pool(&url, 2).await.unwrap();
        assert!(!claim_totp_step(&reopened, user, "secret-a", 57_000_000)
            .await
            .unwrap());
        assert!(!claim_totp_step(&reopened, user, "secret-a", 56_999_999)
            .await
            .unwrap());
        assert!(claim_totp_step(&reopened, user, "secret-a", 57_000_001)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn concurrent_totp_claims_have_one_winner() {
        let pool = test_pool().await;
        let user = setup_user(&pool).await;
        upsert_mfa_secret(&pool, user, "secret-a").await.unwrap();
        let (first, second) = tokio::join!(
            claim_totp_step(&pool, user, "secret-a", 57_000_000),
            claim_totp_step(&pool, user, "secret-a", 57_000_000),
        );
        assert_ne!(first.unwrap(), second.unwrap());
    }

    #[tokio::test]
    async fn enrollment_rejects_a_replaced_secret_and_preserves_backup_codes() {
        let pool = test_pool().await;
        let user = setup_user(&pool).await;
        upsert_mfa_secret(&pool, user, "secret-a").await.unwrap();
        assert!(claim_totp_step(&pool, user, "secret-a", 57_000_000)
            .await
            .unwrap());
        // A second setup replaces the configuration after the first was verified.
        upsert_mfa_secret(&pool, user, "secret-b").await.unwrap();
        assert!(!claim_totp_step(&pool, user, "secret-a", 57_000_001)
            .await
            .unwrap());
        assert!(
            !enable_mfa_with_backup_codes(&pool, user, "secret-a", &["old".into()])
                .await
                .unwrap()
        );
        assert!(!get_mfa_config(&pool, user).await.unwrap().unwrap().enabled);
        assert!(get_unused_backup_codes(&pool, user)
            .await
            .unwrap()
            .is_empty());

        assert!(claim_totp_step(&pool, user, "secret-b", 57_000_000)
            .await
            .unwrap());
        assert!(
            enable_mfa_with_backup_codes(&pool, user, "secret-b", &["current".into()])
                .await
                .unwrap()
        );
        assert!(
            !enable_mfa_with_backup_codes(&pool, user, "secret-b", &["replacement".into()])
                .await
                .unwrap()
        );
        assert_eq!(
            get_unused_backup_codes(&pool, user).await.unwrap()[0].code_hash,
            "current"
        );
    }

    async fn primary_snapshot_is_current(
        pool: &DbPool,
        primary: &str,
        key_login: bool,
        require_verified_email: bool,
    ) -> bool {
        let mut tx = pool.begin().await.unwrap();
        let accepted = lock_login_credentials(
            &mut tx,
            1,
            "alice@example.com",
            primary,
            key_login,
            None,
            require_verified_email,
        )
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        accepted
    }

    async fn check_primary_login_snapshots(pool: &DbPool) {
        sqlx::query("UPDATE users SET email_verified = TRUE, public_key = 'key-a' WHERE id = 1")
            .execute(pool)
            .await
            .unwrap();
        assert!(primary_snapshot_is_current(pool, "hash", false, true).await);
        assert!(primary_snapshot_is_current(pool, "key-a", true, true).await);
        // These mutations represent a credential transaction committed after
        // initial verification but before the login can acquire the account.
        sqlx::query(
            "UPDATE users SET password_hash = 'replacement', public_key = NULL WHERE id = 1",
        )
        .execute(pool)
        .await
        .unwrap();
        assert!(!primary_snapshot_is_current(pool, "hash", false, true).await);
        assert!(!primary_snapshot_is_current(pool, "key-a", true, true).await);
        assert!(primary_snapshot_is_current(pool, "replacement", false, true).await);
        sqlx::query("UPDATE users SET email_verified = FALSE WHERE id = 1")
            .execute(pool)
            .await
            .unwrap();
        assert!(!primary_snapshot_is_current(pool, "replacement", false, true).await);
        assert!(primary_snapshot_is_current(pool, "replacement", false, false).await);
        upsert_mfa_secret(pool, 1, "new-second-factor")
            .await
            .unwrap();
        enable_mfa_with_backup_codes(pool, 1, "new-second-factor", &["code".into()])
            .await
            .unwrap();
        assert!(
            !primary_snapshot_is_current(pool, "replacement", false, false).await,
            "MFA enabled after the initial gate must block primary-only issuance"
        );
    }

    #[tokio::test]
    async fn primary_login_rechecks_changed_credentials_and_new_mfa_before_session_commit() {
        let pool = test_pool().await;
        setup_user(&pool).await;
        check_primary_login_snapshots(&pool).await;
    }

    #[tokio::test]
    async fn postgres_mfa_atomic_claims_and_reopen_when_configured() {
        let Some(url) = std::env::var("PARACORD_TEST_POSTGRES_URL")
            .ok()
            .filter(|url| !url.trim().is_empty())
        else {
            return;
        };
        // Never mutate the configured database's application records. This
        // isolated database exercises PostgreSQL migrations and row locking.
        let admin = crate::create_pool(&url, 1).await.unwrap();
        let name = format!("paracord_mfa_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let (prefix, _) = url.rsplit_once('/').expect("PostgreSQL database URL");
        let isolated_url = format!("{prefix}/{name}");
        let pool = crate::create_pool(&isolated_url, 5).await.unwrap();
        crate::run_migrations_for_engine(&pool, crate::DatabaseEngine::Postgres)
            .await
            .unwrap();
        let user = setup_user(&pool).await;
        upsert_mfa_secret(&pool, user, "secret-a").await.unwrap();
        let (first, second) = tokio::join!(
            claim_totp_step(&pool, user, "secret-a", 57_000_000),
            claim_totp_step(&pool, user, "secret-a", 57_000_000),
        );
        assert_ne!(first.unwrap(), second.unwrap(), "one concurrent claim wins");
        pool.close().await;

        let reopened = crate::create_pool(&isolated_url, 5).await.unwrap();
        assert!(!claim_totp_step(&reopened, user, "secret-a", 57_000_000)
            .await
            .unwrap());
        upsert_mfa_secret(&reopened, user, "secret-b")
            .await
            .unwrap();
        assert!(!claim_totp_step(&reopened, user, "secret-a", 57_000_001)
            .await
            .unwrap());
        assert!(
            !enable_mfa_with_backup_codes(&reopened, user, "secret-a", &["stale".into()])
                .await
                .unwrap()
        );
        assert!(claim_totp_step(&reopened, user, "secret-b", 57_000_000)
            .await
            .unwrap());
        assert!(
            enable_mfa_with_backup_codes(&reopened, user, "secret-b", &["current".into()])
                .await
                .unwrap()
        );
        assert!(!disable_mfa_for_secret(&reopened, user, "secret-a")
            .await
            .unwrap());
        let mut tx = reopened.begin().await.unwrap();
        assert!(lock_login_credentials(
            &mut tx,
            user,
            "alice@example.com",
            "hash",
            false,
            Some("secret-b"),
            false,
        )
        .await
        .unwrap());
        tx.rollback().await.unwrap();
        assert!(disable_mfa_for_secret(&reopened, user, "secret-b")
            .await
            .unwrap());
        assert!(get_mfa_config(&reopened, user).await.unwrap().is_none());
        check_primary_login_snapshots(&reopened).await;
        reopened.close().await;
        sqlx::query(&format!("DROP DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }
}
