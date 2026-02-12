use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InviteRow {
    pub code: String,
    pub channel_id: i64,
    pub inviter_id: Option<i64>,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub max_age: Option<i32>,
    pub temporary: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn create_invite(
    pool: &DbPool,
    code: &str,
    _guild_id: i64,
    channel_id: i64,
    inviter_id: i64,
    max_uses: Option<i32>,
    max_age: Option<i32>,
) -> Result<InviteRow, DbError> {
    let row = sqlx::query_as::<_, InviteRow>(
        "INSERT INTO invites (code, channel_id, inviter_id, max_uses, max_age)
         VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at"
    )
    .bind(code)
    .bind(channel_id)
    .bind(inviter_id)
    .bind(max_uses)
    .bind(max_age)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_invite(pool: &DbPool, code: &str) -> Result<Option<InviteRow>, DbError> {
    let row = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at
         FROM invites WHERE code = ?1"
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn use_invite(pool: &DbPool, code: &str) -> Result<Option<InviteRow>, DbError> {
    let row = sqlx::query_as::<_, InviteRow>(
        "UPDATE invites
         SET uses = uses + 1
         WHERE code = ?1
           AND (max_uses IS NULL OR max_uses = 0 OR uses < max_uses)
           AND (
                max_age IS NULL OR max_age = 0
                OR datetime(created_at, '+' || max_age || ' seconds') > datetime('now')
           )
         RETURNING code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at"
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_invite(pool: &DbPool, code: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM invites WHERE code = ?1")
        .bind(code)
        .execute(pool)
        .await?;
    Ok(())
}

/// Get all invites (server-wide). guild_id param kept for API compat but ignored.
pub async fn get_guild_invites(pool: &DbPool, _guild_id: i64) -> Result<Vec<InviteRow>, DbError> {
    get_all_invites(pool).await
}

pub async fn get_all_invites(pool: &DbPool) -> Result<Vec<InviteRow>, DbError> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at
         FROM invites ORDER BY created_at DESC"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_channel_invites(pool: &DbPool, channel_id: i64) -> Result<Vec<InviteRow>, DbError> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at
         FROM invites WHERE channel_id = ?1 ORDER BY created_at DESC"
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
