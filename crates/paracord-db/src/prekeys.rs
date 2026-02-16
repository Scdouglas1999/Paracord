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

/// Atomically consume (select + delete) the oldest one-time prekey for a user.
pub async fn consume_one_time_prekey(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<OneTimePrekeyRow>, DbError> {
    let row = sqlx::query_as::<_, OneTimePrekeyRow>(
        "DELETE FROM one_time_prekeys
         WHERE id IN (
             SELECT id FROM one_time_prekeys
             WHERE user_id = $1
             ORDER BY created_at ASC, id ASC
             LIMIT 1
         )
         RETURNING id, user_id, public_key, created_at",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Count the number of remaining one-time prekeys for a user.
pub async fn count_one_time_prekeys(pool: &DbPool, user_id: i64) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM one_time_prekeys WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(row.0)
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
