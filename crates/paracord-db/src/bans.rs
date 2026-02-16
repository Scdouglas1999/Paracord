use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct BanRow {
    pub user_id: i64,
    pub guild_id: i64,
    pub reason: Option<String>,
    pub banned_by: Option<i64>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BanRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            guild_id: row.try_get("guild_id")?,
            reason: row.try_get("reason")?,
            banned_by: row.try_get("banned_by")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_ban(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    reason: Option<&str>,
    banned_by: i64,
) -> Result<BanRow, DbError> {
    let row = sqlx::query_as::<_, BanRow>(
        "INSERT INTO bans (user_id, guild_id, reason, banned_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET reason = $3, banned_by = $4, created_at = datetime('now')
         RETURNING user_id, guild_id, reason, banned_by, created_at",
    )
    .bind(user_id)
    .bind(guild_id)
    .bind(reason)
    .bind(banned_by)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_ban(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Option<BanRow>, DbError> {
    let row = sqlx::query_as::<_, BanRow>(
        "SELECT user_id, guild_id, reason, banned_by, created_at
         FROM bans WHERE user_id = $1 AND guild_id = $2",
    )
    .bind(user_id)
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_ban(pool: &DbPool, user_id: i64, guild_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM bans WHERE user_id = $1 AND guild_id = $2")
        .bind(user_id)
        .bind(guild_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_guild_bans(pool: &DbPool, guild_id: i64) -> Result<Vec<BanRow>, DbError> {
    let rows = sqlx::query_as::<_, BanRow>(
        "SELECT user_id, guild_id, reason, banned_by, created_at
         FROM bans
         WHERE guild_id = $1
         ORDER BY created_at DESC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_all_bans(pool: &DbPool) -> Result<Vec<BanRow>, DbError> {
    let rows = sqlx::query_as::<_, BanRow>(
        "SELECT user_id, guild_id, reason, banned_by, created_at
         FROM bans ORDER BY created_at DESC",
    )
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

    async fn setup_guild(pool: &DbPool) -> (i64, i64, i64) {
        let owner_id = 1;
        let target_id = 2;
        let guild_id = 100;
        crate::users::create_user(pool, owner_id, "owner", 1, "owner@example.com", "hash")
            .await
            .unwrap();
        crate::users::create_user(pool, target_id, "target", 1, "target@example.com", "hash")
            .await
            .unwrap();
        crate::guilds::create_guild(pool, guild_id, "Test Guild", owner_id, None)
            .await
            .unwrap();
        (owner_id, target_id, guild_id)
    }

    #[tokio::test]
    async fn test_create_ban() {
        let pool = test_pool().await;
        let (owner_id, target_id, guild_id) = setup_guild(&pool).await;
        let ban = create_ban(&pool, target_id, guild_id, Some("Spamming"), owner_id)
            .await
            .unwrap();
        assert_eq!(ban.user_id, target_id);
        assert_eq!(ban.guild_id, guild_id);
        assert_eq!(ban.reason.as_deref(), Some("Spamming"));
        assert_eq!(ban.banned_by, Some(owner_id));
    }

    #[tokio::test]
    async fn test_create_ban_without_reason() {
        let pool = test_pool().await;
        let (owner_id, target_id, guild_id) = setup_guild(&pool).await;
        let ban = create_ban(&pool, target_id, guild_id, None, owner_id)
            .await
            .unwrap();
        assert!(ban.reason.is_none());
    }

    #[tokio::test]
    async fn test_create_ban_upserts_on_conflict() {
        let pool = test_pool().await;
        let (owner_id, target_id, guild_id) = setup_guild(&pool).await;
        create_ban(&pool, target_id, guild_id, Some("first"), owner_id)
            .await
            .unwrap();
        let ban = create_ban(&pool, target_id, guild_id, Some("updated"), owner_id)
            .await
            .unwrap();
        assert_eq!(ban.reason.as_deref(), Some("updated"));
        // Should still be only 1 ban
        let all = get_guild_bans(&pool, guild_id).await.unwrap();
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn test_get_ban() {
        let pool = test_pool().await;
        let (owner_id, target_id, guild_id) = setup_guild(&pool).await;
        create_ban(&pool, target_id, guild_id, Some("Bad"), owner_id)
            .await
            .unwrap();
        let ban = get_ban(&pool, target_id, guild_id).await.unwrap().unwrap();
        assert_eq!(ban.reason.as_deref(), Some("Bad"));
    }

    #[tokio::test]
    async fn test_get_ban_not_found() {
        let pool = test_pool().await;
        let ban = get_ban(&pool, 999, 888).await.unwrap();
        assert!(ban.is_none());
    }

    #[tokio::test]
    async fn test_delete_ban() {
        let pool = test_pool().await;
        let (owner_id, target_id, guild_id) = setup_guild(&pool).await;
        create_ban(&pool, target_id, guild_id, None, owner_id)
            .await
            .unwrap();
        delete_ban(&pool, target_id, guild_id).await.unwrap();
        let ban = get_ban(&pool, target_id, guild_id).await.unwrap();
        assert!(ban.is_none());
    }

    #[tokio::test]
    async fn test_get_guild_bans() {
        let pool = test_pool().await;
        let (owner_id, _target_id, guild_id) = setup_guild(&pool).await;
        // Create a third user to ban
        crate::users::create_user(&pool, 3, "user3", 1, "u3@example.com", "hash")
            .await
            .unwrap();
        create_ban(&pool, 2, guild_id, Some("reason1"), owner_id)
            .await
            .unwrap();
        create_ban(&pool, 3, guild_id, Some("reason2"), owner_id)
            .await
            .unwrap();
        let bans = get_guild_bans(&pool, guild_id).await.unwrap();
        assert_eq!(bans.len(), 2);
    }

    #[tokio::test]
    async fn test_get_guild_bans_empty() {
        let pool = test_pool().await;
        let bans = get_guild_bans(&pool, 999).await.unwrap();
        assert!(bans.is_empty());
    }
}
