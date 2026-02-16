use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
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

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for InviteRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            code: row.try_get("code")?,
            channel_id: row.try_get("channel_id")?,
            inviter_id: row.try_get("inviter_id")?,
            max_uses: row.try_get("max_uses")?,
            uses: row.try_get("uses")?,
            max_age: row.try_get("max_age")?,
            temporary: bool_from_any_row(row, "temporary")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_invite(
    pool: &DbPool,
    code: &str,
    guild_id: i64,
    channel_id: i64,
    inviter_id: i64,
    max_uses: Option<i32>,
    max_age: Option<i32>,
) -> Result<InviteRow, DbError> {
    let row = sqlx::query_as::<_, InviteRow>(
        "INSERT INTO invites (code, channel_id, inviter_id, max_uses, max_age)
         SELECT $1, $2, $3, $4, $5
         WHERE EXISTS (
             SELECT 1
             FROM channels c
             WHERE c.id = $2
               AND c.space_id = $6
         )
         RETURNING code, channel_id, inviter_id, max_uses, uses, max_age, CASE WHEN temporary THEN 1 ELSE 0 END AS temporary, created_at",
    )
    .bind(code)
    .bind(channel_id)
    .bind(inviter_id)
    .bind(max_uses)
    .bind(max_age)
    .bind(guild_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_invite(pool: &DbPool, code: &str) -> Result<Option<InviteRow>, DbError> {
    let row = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, CASE WHEN temporary THEN 1 ELSE 0 END AS temporary, created_at
         FROM invites WHERE code = $1
           AND (max_age IS NULL OR max_age = 0 OR datetime(created_at, '+' || max_age || ' seconds') > datetime('now'))",
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
         WHERE code = $1
           AND (max_uses IS NULL OR max_uses = 0 OR uses < max_uses)
           AND (
                max_age IS NULL OR max_age = 0
                OR datetime(created_at, '+' || max_age || ' seconds') > datetime('now')
           )
         RETURNING code, channel_id, inviter_id, max_uses, uses, max_age, CASE WHEN temporary THEN 1 ELSE 0 END AS temporary, created_at",
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_invite(pool: &DbPool, code: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM invites WHERE code = $1")
        .bind(code)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_guild_invites(pool: &DbPool, guild_id: i64) -> Result<Vec<InviteRow>, DbError> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT i.code, i.channel_id, i.inviter_id, i.max_uses, i.uses, i.max_age, CASE WHEN i.temporary THEN 1 ELSE 0 END AS temporary, i.created_at
         FROM invites i
         INNER JOIN channels c ON c.id = i.channel_id
         WHERE c.space_id = $1
           AND (i.max_age IS NULL OR i.max_age = 0 OR datetime(i.created_at, '+' || i.max_age || ' seconds') > datetime('now'))
         ORDER BY i.created_at DESC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_all_invites(pool: &DbPool) -> Result<Vec<InviteRow>, DbError> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, CASE WHEN temporary THEN 1 ELSE 0 END AS temporary, created_at
         FROM invites
         WHERE (max_age IS NULL OR max_age = 0 OR datetime(created_at, '+' || max_age || ' seconds') > datetime('now'))
         ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_channel_invites(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<InviteRow>, DbError> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "SELECT code, channel_id, inviter_id, max_uses, uses, max_age, CASE WHEN temporary THEN 1 ELSE 0 END AS temporary, created_at
         FROM invites
         WHERE channel_id = $1
           AND (max_age IS NULL OR max_age = 0 OR datetime(created_at, '+' || max_age || ' seconds') > datetime('now'))
         ORDER BY created_at DESC",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn setup_channel(pool: &DbPool) -> (i64, i64, i64) {
        let user_id = 1;
        let guild_id = 100;
        let channel_id = 200;
        crate::users::create_user(pool, user_id, "inviter", 1, "inv@example.com", "hash")
            .await
            .unwrap();
        crate::guilds::create_guild(pool, guild_id, "Test Guild", user_id, None)
            .await
            .unwrap();
        crate::channels::create_channel(pool, channel_id, guild_id, "general", 0, 0, None, None)
            .await
            .unwrap();
        (user_id, guild_id, channel_id)
    }

    #[tokio::test]
    async fn test_create_invite() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        let invite = create_invite(&pool, "abc123", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        assert_eq!(invite.code, "abc123");
        assert_eq!(invite.channel_id, channel_id);
        assert_eq!(invite.inviter_id, Some(user_id));
        assert_eq!(invite.uses, 0);
        assert!(invite.max_uses.is_none());
        assert!(invite.max_age.is_none());
    }

    #[tokio::test]
    async fn test_create_invite_with_limits() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        let invite = create_invite(
            &pool,
            "limited",
            guild_id,
            channel_id,
            user_id,
            Some(5),
            Some(3600),
        )
        .await
        .unwrap();
        assert_eq!(invite.max_uses, Some(5));
        assert_eq!(invite.max_age, Some(3600));
    }

    #[tokio::test]
    async fn test_get_invite() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(&pool, "find_me", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        let invite = get_invite(&pool, "find_me").await.unwrap().unwrap();
        assert_eq!(invite.code, "find_me");
    }

    #[tokio::test]
    async fn test_get_invite_not_found() {
        let pool = test_pool().await;
        let invite = get_invite(&pool, "nonexistent").await.unwrap();
        assert!(invite.is_none());
    }

    #[tokio::test]
    async fn test_get_invite_hides_expired_invite() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(
            &pool,
            "expired_read",
            guild_id,
            channel_id,
            user_id,
            None,
            Some(1),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE invites SET created_at = datetime('now', '-5 seconds') WHERE code = $1",
        )
        .bind("expired_read")
        .execute(&pool)
        .await
        .unwrap();

        let invite = get_invite(&pool, "expired_read").await.unwrap();
        assert!(invite.is_none());
    }

    #[tokio::test]
    async fn test_use_invite_increments_uses() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(&pool, "useme", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        let used = use_invite(&pool, "useme").await.unwrap().unwrap();
        assert_eq!(used.uses, 1);
        let used_again = use_invite(&pool, "useme").await.unwrap().unwrap();
        assert_eq!(used_again.uses, 2);
    }

    #[tokio::test]
    async fn test_use_invite_respects_max_uses() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(&pool, "once", guild_id, channel_id, user_id, Some(1), None)
            .await
            .unwrap();
        let first = use_invite(&pool, "once").await.unwrap();
        assert!(first.is_some());
        let second = use_invite(&pool, "once").await.unwrap();
        assert!(second.is_none());
    }

    #[tokio::test]
    async fn test_delete_invite() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(&pool, "delme", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        delete_invite(&pool, "delme").await.unwrap();
        let invite = get_invite(&pool, "delme").await.unwrap();
        assert!(invite.is_none());
    }

    #[tokio::test]
    async fn test_get_guild_invites() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(&pool, "inv1", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        create_invite(&pool, "inv2", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        let invites = get_guild_invites(&pool, guild_id).await.unwrap();
        assert_eq!(invites.len(), 2);
    }

    #[tokio::test]
    async fn test_get_channel_invites() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        // Create a second channel
        crate::channels::create_channel(&pool, 201, guild_id, "other", 0, 1, None, None)
            .await
            .unwrap();
        create_invite(&pool, "ch1", guild_id, channel_id, user_id, None, None)
            .await
            .unwrap();
        create_invite(&pool, "ch2", guild_id, 201, user_id, None, None)
            .await
            .unwrap();
        let invites = get_channel_invites(&pool, channel_id).await.unwrap();
        assert_eq!(invites.len(), 1);
        assert_eq!(invites[0].code, "ch1");
    }

    #[tokio::test]
    async fn test_get_guild_invites_filters_expired_entries() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_id) = setup_channel(&pool).await;
        create_invite(
            &pool,
            "expired_list",
            guild_id,
            channel_id,
            user_id,
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_invite(
            &pool,
            "active_list",
            guild_id,
            channel_id,
            user_id,
            None,
            Some(3600),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE invites SET created_at = datetime('now', '-5 seconds') WHERE code = $1",
        )
        .bind("expired_list")
        .execute(&pool)
        .await
        .unwrap();

        let invites = get_guild_invites(&pool, guild_id).await.unwrap();
        assert_eq!(invites.len(), 1);
        assert_eq!(invites[0].code, "active_list");
    }
}
