use crate::{DbError, DbPool};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignedPrekeyRow {
    pub id: i64,
    pub user_id: i64,
    pub public_key: String,
    pub signature: String,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OneTimePrekeyRow {
    pub id: i64,
    pub user_id: i64,
    pub public_key: String,
    pub created_at: String,
}

/// Upsert a signed prekey for a user. Each user has at most one signed prekey.
pub async fn upsert_signed_prekey(
    pool: &DbPool,
    id: i64,
    user_id: i64,
    public_key: &str,
    signature: &str,
) -> Result<SignedPrekeyRow, DbError> {
    let row = sqlx::query_as::<_, SignedPrekeyRow>(
        "INSERT INTO signed_prekeys (id, user_id, public_key, signature)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
            id = EXCLUDED.id,
            public_key = EXCLUDED.public_key,
            signature = EXCLUDED.signature
         RETURNING id, user_id, public_key, signature, created_at",
    )
    .bind(id)
    .bind(user_id)
    .bind(public_key)
    .bind(signature)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Get the signed prekey for a user.
pub async fn get_signed_prekey(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<SignedPrekeyRow>, DbError> {
    let row = sqlx::query_as::<_, SignedPrekeyRow>(
        "SELECT id, user_id, public_key, signature, created_at
         FROM signed_prekeys WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Batch insert one-time prekeys for a user. Uses ON CONFLICT DO NOTHING so
/// duplicate (user_id, id) pairs are silently skipped.
/// `keys` is a slice of (id, public_key) tuples.
/// Returns the number of keys actually inserted.
pub async fn upload_one_time_prekeys(
    pool: &DbPool,
    user_id: i64,
    keys: &[(i64, String)],
) -> Result<u64, DbError> {
    let mut inserted: u64 = 0;
    for (id, public_key) in keys {
        let result = sqlx::query(
            "INSERT INTO one_time_prekeys (id, user_id, public_key)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, id) DO NOTHING",
        )
        .bind(id)
        .bind(user_id)
        .bind(public_key)
        .execute(pool)
        .await?;
        inserted += result.rows_affected();
    }
    Ok(inserted)
}

/// Upsert the single long-lived "last-resort" one-time prekey for a user.
///
/// Unlike disposable one-time prekeys, the last-resort key is never deleted on
/// consumption; it is handed out as a fallback so that a peer's prekey bundle
/// always includes an ephemeral one-time-prekey DH contribution even after the
/// disposable pool has been drained. Each user has at most one last-resort key,
/// so any existing one is replaced.
pub async fn upsert_last_resort_prekey(
    pool: &DbPool,
    id: i64,
    user_id: i64,
    public_key: &str,
) -> Result<(), DbError> {
    // Drop any previously-uploaded last-resort key (its id may differ).
    sqlx::query("DELETE FROM one_time_prekeys WHERE user_id = $1 AND last_resort = 1")
        .bind(user_id)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO one_time_prekeys (id, user_id, public_key, last_resort)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (user_id, id) DO UPDATE SET
            public_key = EXCLUDED.public_key,
            last_resort = 1",
    )
    .bind(id)
    .bind(user_id)
    .bind(public_key)
    .execute(pool)
    .await?;
    Ok(())
}

/// Consume a one-time prekey for a user.
///
/// The oldest disposable prekey is atomically selected and deleted so it is
/// never handed out twice. When the disposable pool is empty, the user's
/// long-lived last-resort prekey (if any) is returned WITHOUT deletion so that
/// X3DH never silently degrades to signed-prekey-only. This prevents any
/// authenticated caller from draining a victim's pool and weakening the forward
/// secrecy of newly-initiated sessions.
pub async fn consume_one_time_prekey(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<OneTimePrekeyRow>, DbError> {
    let row = sqlx::query_as::<_, OneTimePrekeyRow>(
        "DELETE FROM one_time_prekeys
         WHERE id IN (
             SELECT id FROM one_time_prekeys
             WHERE user_id = $1 AND last_resort = 0
             ORDER BY created_at ASC, id ASC
             LIMIT 1
         )
         RETURNING id, user_id, public_key, created_at",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    if row.is_some() {
        return Ok(row);
    }
    // Disposable pool exhausted: fall back to the last-resort key without
    // deleting it. Returns None only if the user never uploaded one.
    let last_resort = sqlx::query_as::<_, OneTimePrekeyRow>(
        "SELECT id, user_id, public_key, created_at
         FROM one_time_prekeys
         WHERE user_id = $1 AND last_resort = 1
         LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(last_resort)
}

/// Count the number of remaining disposable one-time prekeys for a user. The
/// long-lived last-resort key is excluded so clients replenish the disposable
/// pool at the right threshold.
pub async fn count_one_time_prekeys(pool: &DbPool, user_id: i64) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE user_id = $1 AND last_resort = 0",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Whether the user has uploaded a long-lived last-resort prekey.
pub async fn has_last_resort_prekey(pool: &DbPool, user_id: i64) -> Result<bool, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM one_time_prekeys WHERE user_id = $1 AND last_resort = 1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0 > 0)
}

/// List one-time prekeys for a user (oldest first). Used for data export.
pub async fn list_one_time_prekeys(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<OneTimePrekeyRow>, DbError> {
    let rows = sqlx::query_as::<_, OneTimePrekeyRow>(
        "SELECT id, user_id, public_key, created_at
         FROM one_time_prekeys
         WHERE user_id = $1
         ORDER BY created_at ASC, id ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Delete all prekeys (signed and one-time) for a user.
pub async fn delete_all_prekeys(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM signed_prekeys WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM one_time_prekeys WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        sqlx::query(
            // Mirror the production schema after 20260220000001_fix_integer_to_bigint:
            // id must be BIGINT (not INTEGER) PRIMARY KEY so it is not a rowid alias,
            // otherwise SQLite discards UNIQUE(user_id, id) as redundant and the
            // ON CONFLICT (user_id, id) upserts below have no index to target.
            "CREATE TABLE one_time_prekeys (
                id          BIGINT PRIMARY KEY,
                user_id     BIGINT NOT NULL,
                public_key  TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                last_resort INTEGER NOT NULL DEFAULT 0,
                UNIQUE(user_id, id)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn last_resort_prevents_exhaustion_from_degrading_x3dh() {
        let pool = test_pool().await;
        let victim = 42_i64;

        // Victim uploads two disposable OPKs plus one last-resort key.
        upload_one_time_prekeys(
            &pool,
            victim,
            &[(1, "opk-one".into()), (2, "opk-two".into())],
        )
        .await
        .unwrap();
        upsert_last_resort_prekey(&pool, 100, victim, "last-resort")
            .await
            .unwrap();

        // The last-resort key must not count toward the disposable pool.
        assert_eq!(count_one_time_prekeys(&pool, victim).await.unwrap(), 2);

        // An attacker drains the disposable pool one fetch at a time.
        assert_eq!(
            consume_one_time_prekey(&pool, victim)
                .await
                .unwrap()
                .unwrap()
                .public_key,
            "opk-one"
        );
        assert_eq!(
            consume_one_time_prekey(&pool, victim)
                .await
                .unwrap()
                .unwrap()
                .public_key,
            "opk-two"
        );
        assert_eq!(count_one_time_prekeys(&pool, victim).await.unwrap(), 0);

        // Pool exhausted: every further fetch still yields the last-resort key
        // (returned WITHOUT deletion), so X3DH never degrades to
        // signed-prekey-only.
        for _ in 0..3 {
            let opk = consume_one_time_prekey(&pool, victim).await.unwrap();
            assert_eq!(opk.unwrap().public_key, "last-resort");
        }
    }

    #[tokio::test]
    async fn consume_returns_none_when_no_last_resort_uploaded() {
        let pool = test_pool().await;
        let user = 7_i64;
        upload_one_time_prekeys(&pool, user, &[(1, "only".into())])
            .await
            .unwrap();

        assert_eq!(
            consume_one_time_prekey(&pool, user)
                .await
                .unwrap()
                .unwrap()
                .public_key,
            "only"
        );
        // No last-resort key was uploaded, so exhaustion yields None.
        assert!(consume_one_time_prekey(&pool, user)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn upsert_last_resort_replaces_previous_key() {
        let pool = test_pool().await;
        let user = 9_i64;
        upsert_last_resort_prekey(&pool, 100, user, "first")
            .await
            .unwrap();
        upsert_last_resort_prekey(&pool, 101, user, "second")
            .await
            .unwrap();

        // Exactly one last-resort key remains, and it is the latest one.
        let opk = consume_one_time_prekey(&pool, user).await.unwrap().unwrap();
        assert_eq!(opk.public_key, "second");
        assert_eq!(count_one_time_prekeys(&pool, user).await.unwrap(), 0);
    }
}
