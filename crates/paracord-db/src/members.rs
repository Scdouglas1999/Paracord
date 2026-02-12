use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberRow {
    pub user_id: i64,
    pub nick: Option<String>,
    pub avatar_hash: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub deaf: bool,
    pub mute: bool,
    pub communication_disabled_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberWithUserRow {
    pub user_id: i64,
    pub nick: Option<String>,
    pub avatar_hash: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub deaf: bool,
    pub mute: bool,
    pub communication_disabled_until: Option<DateTime<Utc>>,
    pub username: String,
    pub discriminator: i16,
    pub user_avatar_hash: Option<String>,
}

/// Add a user as a server-wide member. guild_id kept for API compat but ignored.
pub async fn add_member(pool: &DbPool, user_id: i64, _guild_id: i64) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO members (user_id) VALUES (?1) ON CONFLICT DO NOTHING"
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn add_server_member(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO members (user_id) VALUES (?1) ON CONFLICT DO NOTHING"
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_member(
    pool: &DbPool,
    user_id: i64,
    _guild_id: i64,
) -> Result<Option<MemberRow>, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "SELECT user_id, nick, avatar_hash, joined_at, deaf, mute, communication_disabled_until
         FROM members WHERE user_id = ?1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_server_member(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<MemberRow>, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "SELECT user_id, nick, avatar_hash, joined_at, deaf, mute, communication_disabled_until
         FROM members WHERE user_id = ?1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_guild_members(
    pool: &DbPool,
    _guild_id: i64,
    limit: i64,
    after: Option<i64>,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    get_server_members(pool, limit, after).await
}

pub async fn get_server_members(
    pool: &DbPool,
    limit: i64,
    after: Option<i64>,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    let rows = if let Some(after_id) = after {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, m.deaf, m.mute, m.communication_disabled_until,
                    u.username, u.discriminator, u.avatar_hash AS user_avatar_hash
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.user_id > ?2
             ORDER BY m.user_id
             LIMIT ?1"
        )
        .bind(limit)
        .bind(after_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, m.deaf, m.mute, m.communication_disabled_until,
                    u.username, u.discriminator, u.avatar_hash AS user_avatar_hash
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             ORDER BY m.joined_at
             LIMIT ?1"
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

pub async fn update_member(
    pool: &DbPool,
    user_id: i64,
    _guild_id: i64,
    nick: Option<&str>,
    deaf: Option<bool>,
    mute: Option<bool>,
) -> Result<MemberRow, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "UPDATE members SET nick = COALESCE(?2, nick), deaf = COALESCE(?3, deaf), mute = COALESCE(?4, mute)
         WHERE user_id = ?1
         RETURNING user_id, nick, avatar_hash, joined_at, deaf, mute, communication_disabled_until"
    )
    .bind(user_id)
    .bind(nick)
    .bind(deaf)
    .bind(mute)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn remove_member(pool: &DbPool, user_id: i64, _guild_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM members WHERE user_id = ?1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_member_timeout(
    pool: &DbPool,
    user_id: i64,
    _guild_id: i64,
    communication_disabled_until: Option<DateTime<Utc>>,
) -> Result<MemberRow, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "UPDATE members
         SET communication_disabled_until = ?2
         WHERE user_id = ?1
         RETURNING user_id, nick, avatar_hash, joined_at, deaf, mute, communication_disabled_until",
    )
    .bind(user_id)
    .bind(communication_disabled_until)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_member_count(pool: &DbPool, _guild_id: i64) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM members")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn get_server_member_count(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM members")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
