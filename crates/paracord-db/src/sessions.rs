use crate::{datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

fn max_sessions_per_user() -> i64 {
    std::env::var("PARACORD_MAX_SESSIONS_PER_USER")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(20)
}

#[derive(Debug, Clone)]
pub struct AuthSessionRow {
    pub id: String,
    pub user_id: i64,
    pub refresh_token_hash: String,
    pub current_jti: String,
    pub pub_key: Option<String>,
    pub device_id: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_reason: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AuthSessionRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let issued_at_raw: String = row.try_get("issued_at")?;
        let last_seen_at_raw: String = row.try_get("last_seen_at")?;
        let expires_at_raw: String = row.try_get("expires_at")?;
        let revoked_at_raw: Option<String> = row.try_get("revoked_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            user_id: row.try_get("user_id")?,
            refresh_token_hash: row.try_get("refresh_token_hash")?,
            current_jti: row.try_get("current_jti")?,
            pub_key: row.try_get("pub_key")?,
            device_id: row.try_get("device_id")?,
            user_agent: row.try_get("user_agent")?,
            ip_address: row.try_get("ip_address")?,
            issued_at: datetime_from_db_text(&issued_at_raw)?,
            last_seen_at: datetime_from_db_text(&last_seen_at_raw)?,
            expires_at: datetime_from_db_text(&expires_at_raw)?,
            revoked_at: revoked_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            revoked_reason: row.try_get("revoked_reason")?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn create_session(
    pool: &DbPool,
    id: &str,
    user_id: i64,
    refresh_token_hash: &str,
    current_jti: &str,
    pub_key: Option<&str>,
    device_id: Option<&str>,
    user_agent: Option<&str>,
    ip_address: Option<&str>,
    expires_at: DateTime<Utc>,
) -> Result<AuthSessionRow, DbError> {
    let max_sessions = max_sessions_per_user();
    let active_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)
         FROM auth_sessions
         WHERE user_id = $1
           AND revoked_at IS NULL
           AND expires_at > $2",
    )
    .bind(user_id)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;

    if active_count.0 >= max_sessions {
        let revoke_count = active_count.0 - max_sessions + 1;
        let now = Utc::now();
        sqlx::query(
            "UPDATE auth_sessions
             SET revoked_at = $2,
                 revoked_reason = 'session_limit'
             WHERE id IN (
                 SELECT id
                 FROM auth_sessions
                 WHERE user_id = $1
                   AND revoked_at IS NULL
                 ORDER BY last_seen_at ASC
                 LIMIT $3
             )",
        )
        .bind(user_id)
        .bind(datetime_to_db_text(now))
        .bind(revoke_count)
        .execute(pool)
        .await?;
    }

    let row = sqlx::query_as::<_, AuthSessionRow>(
        "INSERT INTO auth_sessions (
            id, user_id, refresh_token_hash, current_jti, pub_key, device_id, user_agent, ip_address, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, user_id, refresh_token_hash, current_jti, pub_key, device_id, user_agent, ip_address,
                   issued_at, last_seen_at, expires_at, revoked_at, revoked_reason",
    )
    .bind(id)
    .bind(user_id)
    .bind(refresh_token_hash)
    .bind(current_jti)
    .bind(pub_key)
    .bind(device_id)
    .bind(user_agent)
    .bind(ip_address)
    .bind(datetime_to_db_text(expires_at))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_session_by_refresh_hash(
    pool: &DbPool,
    refresh_token_hash: &str,
) -> Result<Option<AuthSessionRow>, DbError> {
    let row = sqlx::query_as::<_, AuthSessionRow>(
        "SELECT id, user_id, refresh_token_hash, current_jti, pub_key, device_id, user_agent, ip_address,
                issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
         FROM auth_sessions
         WHERE refresh_token_hash = $1",
    )
    .bind(refresh_token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_session_by_id(
    pool: &DbPool,
    session_id: &str,
) -> Result<Option<AuthSessionRow>, DbError> {
    let row = sqlx::query_as::<_, AuthSessionRow>(
        "SELECT id, user_id, refresh_token_hash, current_jti, pub_key, device_id, user_agent, ip_address,
                issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
         FROM auth_sessions
         WHERE id = $1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn list_user_sessions(
    pool: &DbPool,
    user_id: i64,
    now: DateTime<Utc>,
) -> Result<Vec<AuthSessionRow>, DbError> {
    let rows = sqlx::query_as::<_, AuthSessionRow>(
        "SELECT id, user_id, refresh_token_hash, current_jti, pub_key, device_id, user_agent, ip_address,
                issued_at, last_seen_at, expires_at, revoked_at, revoked_reason
         FROM auth_sessions
         WHERE user_id = $1
           AND revoked_at IS NULL
           AND expires_at > $2
         ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .bind(datetime_to_db_text(now))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn rotate_session_refresh_token(
    pool: &DbPool,
    session_id: &str,
    old_refresh_token_hash: &str,
    new_refresh_token_hash: &str,
    new_jti: &str,
    now: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE auth_sessions
         SET refresh_token_hash = $3,
             current_jti = $4,
             last_seen_at = $5,
             expires_at = $6
         WHERE id = $1
           AND refresh_token_hash = $2
           AND revoked_at IS NULL
           AND expires_at > $5",
    )
    .bind(session_id)
    .bind(old_refresh_token_hash)
    .bind(new_refresh_token_hash)
    .bind(new_jti)
    .bind(datetime_to_db_text(now))
    .bind(datetime_to_db_text(expires_at))
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_session_jti(
    pool: &DbPool,
    session_id: &str,
    new_jti: &str,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE auth_sessions
         SET current_jti = $2,
             last_seen_at = $3
         WHERE id = $1
           AND revoked_at IS NULL
           AND expires_at > $3",
    )
    .bind(session_id)
    .bind(new_jti)
    .bind(datetime_to_db_text(now))
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn revoke_session(
    pool: &DbPool,
    session_id: &str,
    user_id: i64,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE auth_sessions
         SET revoked_at = $3, revoked_reason = $4
         WHERE id = $1
           AND user_id = $2
           AND revoked_at IS NULL",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(datetime_to_db_text(now))
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn revoke_all_user_sessions_except(
    pool: &DbPool,
    user_id: i64,
    keep_session_id: Option<&str>,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<u64, DbError> {
    let result = if let Some(keep_id) = keep_session_id {
        sqlx::query(
            "UPDATE auth_sessions
             SET revoked_at = $3, revoked_reason = $4
             WHERE user_id = $1
               AND id != $2
               AND revoked_at IS NULL",
        )
        .bind(user_id)
        .bind(keep_id)
        .bind(datetime_to_db_text(now))
        .bind(reason)
        .execute(pool)
        .await?
    } else {
        sqlx::query(
            "UPDATE auth_sessions
             SET revoked_at = $2, revoked_reason = $3
             WHERE user_id = $1
               AND revoked_at IS NULL",
        )
        .bind(user_id)
        .bind(datetime_to_db_text(now))
        .bind(reason)
        .execute(pool)
        .await?
    };

    Ok(result.rows_affected())
}

pub async fn is_access_token_active(
    pool: &DbPool,
    user_id: i64,
    session_id: &str,
    jti: &str,
    now: DateTime<Utc>,
) -> Result<bool, DbError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1
         FROM auth_sessions
         WHERE id = $1
           AND user_id = $2
           AND current_jti = $3
           AND revoked_at IS NULL
           AND expires_at > $4
         LIMIT 1",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(jti)
    .bind(datetime_to_db_text(now))
    .fetch_optional(pool)
    .await?;

    Ok(row.is_some())
}

pub async fn purge_expired_sessions(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM auth_sessions
         WHERE id IN (
             SELECT id FROM auth_sessions
             WHERE expires_at <= $1
                OR (revoked_at IS NOT NULL AND revoked_at <= datetime($1, '-7 days'))
             LIMIT $2
         )",
    )
    .bind(datetime_to_db_text(now))
    .bind(limit)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_db() -> DbPool {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!("paracord-db-sessions-{unique}.db"));
        let db_url = format!(
            "sqlite://{}?mode=rwc",
            db_path.to_string_lossy().replace('\\', "/")
        );
        let pool = crate::create_pool(&db_url, 1).await.expect("pool");
        crate::run_migrations(&pool).await.expect("migrations");
        pool
    }

    #[tokio::test]
    async fn session_activity_respects_current_jti_and_revocation() {
        let db = setup_db().await;
        let user = crate::users::create_user(&db, 7001, "tester", 1, "tester@example.com", "hash")
            .await
            .expect("create user");
        let now = Utc::now();
        let expires = now + chrono::Duration::days(30);

        create_session(
            &db,
            "sess-1",
            user.id,
            "refresh-hash-1",
            "jti-1",
            None,
            Some("device-1"),
            Some("agent"),
            Some("127.0.0.1"),
            expires,
        )
        .await
        .expect("create session");

        let active = is_access_token_active(&db, user.id, "sess-1", "jti-1", now)
            .await
            .expect("active check");
        assert!(active);

        let inactive_wrong_jti = is_access_token_active(&db, user.id, "sess-1", "wrong-jti", now)
            .await
            .expect("wrong jti check");
        assert!(!inactive_wrong_jti);

        let revoked = revoke_session(&db, "sess-1", user.id, "test", now)
            .await
            .expect("revoke session");
        assert!(revoked);

        let inactive_revoked = is_access_token_active(&db, user.id, "sess-1", "jti-1", now)
            .await
            .expect("revoked active check");
        assert!(!inactive_revoked);
    }
}
