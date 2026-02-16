use crate::{DbError, DbPool};

const MAX_AUTH_GUARD_KEYS: usize = 32;
const AUTH_GUARD_LOCK_THRESHOLD: i64 = 5;
const AUTH_GUARD_BASE_BACKOFF_SECONDS: i64 = 10;
const AUTH_GUARD_MAX_BACKOFF_SECONDS: i64 = 300;
const AUTH_GUARD_MAX_EXPONENT: u32 = 6;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthGuardStateRow {
    pub guard_key: String,
    pub failures: i64,
    pub locked_until: i64,
    pub last_seen: i64,
}

pub async fn increment_window_counter(
    pool: &DbPool,
    bucket_key: &str,
    window_start: i64,
    window_seconds: i64,
) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO rate_limit_counters (bucket_key, window_start, window_seconds, count, updated_at)
         VALUES ($1, $2, $3, 1, datetime('now'))
         ON CONFLICT(bucket_key, window_start) DO UPDATE SET
            count = rate_limit_counters.count + 1,
            updated_at = datetime('now'),
            window_seconds = excluded.window_seconds
         RETURNING count",
    )
    .bind(bucket_key)
    .bind(window_start)
    .bind(window_seconds)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

pub async fn purge_window_counters_older_than(
    pool: &DbPool,
    oldest_window_start: i64,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM rate_limit_counters
         WHERE (bucket_key, window_start) IN (
             SELECT bucket_key, window_start
             FROM rate_limit_counters
             WHERE window_start < $1
             ORDER BY window_start ASC
             LIMIT $2
         )",
    )
    .bind(oldest_window_start)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn get_auth_guard_states(
    pool: &DbPool,
    keys: &[String],
) -> Result<Vec<AuthGuardStateRow>, DbError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    if keys.len() > MAX_AUTH_GUARD_KEYS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many auth guard keys".to_string(),
        )));
    }

    let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("${i}")).collect();
    let sql = format!(
        "SELECT guard_key, failures, locked_until, last_seen
         FROM auth_guard_state
         WHERE guard_key IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query_as::<_, AuthGuardStateRow>(&sql);
    for key in keys {
        query = query.bind(key);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

pub async fn clear_auth_guard_keys(pool: &DbPool, keys: &[String]) -> Result<u64, DbError> {
    if keys.is_empty() {
        return Ok(0);
    }
    if keys.len() > MAX_AUTH_GUARD_KEYS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many auth guard keys".to_string(),
        )));
    }

    let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("${i}")).collect();
    let sql = format!(
        "DELETE FROM auth_guard_state
         WHERE guard_key IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for key in keys {
        query = query.bind(key);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

pub async fn purge_auth_guard_older_than(
    pool: &DbPool,
    min_last_seen: i64,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM auth_guard_state
         WHERE guard_key IN (
             SELECT guard_key
             FROM auth_guard_state
             WHERE last_seen < $1
             ORDER BY last_seen ASC
             LIMIT $2
         )",
    )
    .bind(min_last_seen)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn record_auth_guard_failure(
    pool: &DbPool,
    guard_key: &str,
    now_epoch: i64,
) -> Result<AuthGuardStateRow, DbError> {
    let mut tx = pool.begin().await?;
    let existing = sqlx::query_as::<_, AuthGuardStateRow>(
        "SELECT guard_key, failures, locked_until, last_seen
         FROM auth_guard_state
         WHERE guard_key = $1",
    )
    .bind(guard_key)
    .fetch_optional(&mut *tx)
    .await?;

    let next_failures = existing
        .as_ref()
        .map(|row| row.failures.saturating_add(1))
        .unwrap_or(1);
    let next_locked_until = if next_failures >= AUTH_GUARD_LOCK_THRESHOLD {
        now_epoch.saturating_add(auth_guard_backoff_seconds(next_failures))
    } else {
        0
    };

    if existing.is_some() {
        sqlx::query(
            "UPDATE auth_guard_state
             SET failures = $2,
                 locked_until = $3,
                 last_seen = $4
             WHERE guard_key = $1",
        )
        .bind(guard_key)
        .bind(next_failures)
        .bind(next_locked_until)
        .bind(now_epoch)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO auth_guard_state (guard_key, failures, locked_until, last_seen)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(guard_key)
        .bind(next_failures)
        .bind(next_locked_until)
        .bind(now_epoch)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(AuthGuardStateRow {
        guard_key: guard_key.to_string(),
        failures: next_failures,
        locked_until: next_locked_until,
        last_seen: now_epoch,
    })
}

fn auth_guard_backoff_seconds(failures: i64) -> i64 {
    if failures < AUTH_GUARD_LOCK_THRESHOLD {
        return 0;
    }
    let exponent = (failures - AUTH_GUARD_LOCK_THRESHOLD).clamp(0, AUTH_GUARD_MAX_EXPONENT as i64);
    let backoff = AUTH_GUARD_BASE_BACKOFF_SECONDS.saturating_mul(1_i64 << exponent);
    backoff.min(AUTH_GUARD_MAX_BACKOFF_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::{
        clear_auth_guard_keys, get_auth_guard_states, increment_window_counter,
        purge_window_counters_older_than, record_auth_guard_failure,
    };
    use crate::DbPool;

    async fn setup_db() -> DbPool {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!("paracord-db-rate-limits-{unique}.db"));
        let db_url = format!(
            "sqlite://{}?mode=rwc",
            db_path.to_string_lossy().replace('\\', "/")
        );

        let pool = crate::create_pool(&db_url, 1).await.expect("pool");
        crate::run_migrations(&pool).await.expect("migrations");
        pool
    }

    #[tokio::test]
    async fn increment_window_counter_is_scoped_by_window() {
        let db = setup_db().await;
        let key = "http:global:127.0.0.1";
        let first = increment_window_counter(&db, key, 100, 1)
            .await
            .expect("first");
        let second = increment_window_counter(&db, key, 100, 1)
            .await
            .expect("second");
        let next_window = increment_window_counter(&db, key, 101, 1)
            .await
            .expect("next window");

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert_eq!(next_window, 1);
    }

    #[tokio::test]
    async fn auth_guard_failure_lockout_and_clear_work() {
        let db = setup_db().await;
        let key = "acct:user@example.com";
        let now = 1_700_000_000_i64;

        for i in 1..=6_i64 {
            let row = record_auth_guard_failure(&db, key, now + i)
                .await
                .expect("record failure");
            assert_eq!(row.failures, i);
        }

        let rows = get_auth_guard_states(&db, &[key.to_string()])
            .await
            .expect("load rows");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].locked_until > now);

        let removed = clear_auth_guard_keys(&db, &[key.to_string()])
            .await
            .expect("clear");
        assert_eq!(removed, 1);
    }

    #[tokio::test]
    async fn purge_old_window_counters_removes_stale_rows() {
        let db = setup_db().await;
        increment_window_counter(&db, "k1", 10, 1)
            .await
            .expect("insert k1");
        increment_window_counter(&db, "k2", 20, 1)
            .await
            .expect("insert k2");
        increment_window_counter(&db, "k3", 30, 1)
            .await
            .expect("insert k3");

        let removed = purge_window_counters_older_than(&db, 25, 10)
            .await
            .expect("purge");
        assert_eq!(removed, 2);
    }
}
