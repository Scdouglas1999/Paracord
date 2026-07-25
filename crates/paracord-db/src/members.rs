use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::id::{GuildId, UserId};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct MemberRow {
    pub user_id: i64,
    pub nick: Option<String>,
    pub avatar_hash: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub deaf: bool,
    pub mute: bool,
    pub communication_disabled_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct MemberWithUserRow {
    pub user_id: i64,
    pub nick: Option<String>,
    pub avatar_hash: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub deaf: bool,
    pub mute: bool,
    pub communication_disabled_until: Option<DateTime<Utc>>,
    pub username: String,
    pub user_display_name: Option<String>,
    pub discriminator: i16,
    pub user_avatar_hash: Option<String>,
    pub user_flags: i32,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MemberRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let joined_at_raw: String = row.try_get("joined_at")?;
        let timeout_raw: Option<String> = row.try_get("communication_disabled_until")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            nick: row.try_get("nick")?,
            avatar_hash: row.try_get("avatar_hash")?,
            joined_at: datetime_from_db_text(&joined_at_raw)?,
            deaf: bool_from_any_row(row, "deaf")?,
            mute: bool_from_any_row(row, "mute")?,
            communication_disabled_until: timeout_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MemberWithUserRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let joined_at_raw: String = row.try_get("joined_at")?;
        let timeout_raw: Option<String> = row.try_get("communication_disabled_until")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            nick: row.try_get("nick")?,
            avatar_hash: row.try_get("avatar_hash")?,
            joined_at: datetime_from_db_text(&joined_at_raw)?,
            deaf: bool_from_any_row(row, "deaf")?,
            mute: bool_from_any_row(row, "mute")?,
            communication_disabled_until: timeout_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            username: row.try_get("username")?,
            user_display_name: row.try_get("user_display_name")?,
            discriminator: row.try_get("discriminator")?,
            user_avatar_hash: row.try_get("user_avatar_hash")?,
            user_flags: row.try_get("user_flags")?,
        })
    }
}

/// Core implementation using newtype IDs.
pub async fn add_member_typed(
    pool: &DbPool,
    user_id: UserId,
    guild_id: GuildId,
) -> Result<(), DbError> {
    sqlx::query("INSERT INTO members (user_id, guild_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(guild_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat with callers that haven't migrated yet.
pub async fn add_member(pool: &DbPool, user_id: i64, guild_id: i64) -> Result<(), DbError> {
    add_member_typed(pool, UserId::new(user_id), GuildId::new(guild_id)).await
}

pub async fn add_server_member(pool: &DbPool, user_id: UserId) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO members (user_id, guild_id)
         SELECT $1, s.id
         FROM spaces s
         ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Core implementation using newtype IDs.
pub async fn get_member_typed(
    pool: &DbPool,
    user_id: UserId,
    guild_id: GuildId,
) -> Result<Option<MemberRow>, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "SELECT user_id, nick, avatar_hash, joined_at, CASE WHEN deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN mute THEN 1 ELSE 0 END AS mute, communication_disabled_until
         FROM members WHERE user_id = $1 AND guild_id = $2",
    )
    .bind(user_id)
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_member(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Option<MemberRow>, DbError> {
    get_member_typed(pool, UserId::new(user_id), GuildId::new(guild_id)).await
}

pub async fn get_server_member(
    pool: &DbPool,
    user_id: UserId,
) -> Result<Option<MemberRow>, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "SELECT user_id, nick, avatar_hash, joined_at, CASE WHEN deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN mute THEN 1 ELSE 0 END AS mute, communication_disabled_until
         FROM members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Core implementation using newtype IDs.
pub async fn get_guild_members_typed(
    pool: &DbPool,
    guild_id: GuildId,
    limit: i64,
    after: Option<UserId>,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    let rows = if let Some(after_id) = after {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                    u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.guild_id = $3
               AND m.user_id > $2
             ORDER BY m.user_id
             LIMIT $1"
        )
        .bind(limit)
        .bind(after_id)
        .bind(guild_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                    u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.guild_id = $2
             ORDER BY joined_at
             LIMIT $1"
        )
        .bind(limit)
        .bind(guild_id)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_guild_members(
    pool: &DbPool,
    guild_id: i64,
    limit: i64,
    after: Option<i64>,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    get_guild_members_typed(pool, GuildId::new(guild_id), limit, after.map(UserId::new)).await
}

pub async fn get_server_members(
    pool: &DbPool,
    limit: i64,
    after: Option<i64>,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    let rows = if let Some(after_id) = after {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, MIN(m.joined_at) AS joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                    u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.user_id > $2
             GROUP BY m.user_id, m.nick, m.avatar_hash, m.deaf, m.mute, m.communication_disabled_until, u.username, u.display_name, u.discriminator, u.avatar_hash, u.flags
             ORDER BY m.user_id
             LIMIT $1"
        )
        .bind(limit)
        .bind(after_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, MemberWithUserRow>(
            "SELECT m.user_id, m.nick, m.avatar_hash, MIN(m.joined_at) AS joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                    u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
             FROM members m
             INNER JOIN users u ON u.id = m.user_id
             GROUP BY m.user_id, m.nick, m.avatar_hash, m.deaf, m.mute, m.communication_disabled_until, u.username, u.display_name, u.discriminator, u.avatar_hash, u.flags
             ORDER BY m.joined_at
             LIMIT $1"
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

/// Core implementation using newtype IDs.
pub async fn update_member_typed(
    pool: &DbPool,
    user_id: UserId,
    guild_id: GuildId,
    nick: Option<&str>,
    deaf: Option<bool>,
    mute: Option<bool>,
) -> Result<MemberRow, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "UPDATE members SET nick = COALESCE($2, nick), deaf = COALESCE($3, deaf), mute = COALESCE($4, mute)
         WHERE user_id = $1 AND guild_id = $5
         RETURNING user_id, nick, avatar_hash, joined_at, CASE WHEN deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN mute THEN 1 ELSE 0 END AS mute, communication_disabled_until"
    )
    .bind(user_id)
    .bind(nick)
    .bind(deaf)
    .bind(mute)
    .bind(guild_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_member(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    nick: Option<&str>,
    deaf: Option<bool>,
    mute: Option<bool>,
) -> Result<MemberRow, DbError> {
    update_member_typed(
        pool,
        UserId::new(user_id),
        GuildId::new(guild_id),
        nick,
        deaf,
        mute,
    )
    .await
}

/// Core implementation using newtype IDs.
pub async fn remove_member_typed(
    pool: &DbPool,
    user_id: UserId,
    guild_id: GuildId,
) -> Result<(), DbError> {
    // Strip the user's explicit role assignments for this guild's roles.
    // member_roles has no FK/cascade tied to the members row, so leaving these
    // rows behind would let a kicked/left/banned user retain guild privileges
    // (and instantly regain every role on re-join). Delete them in the same
    // removal operation.
    // Both deletes are one removal: if the membership row goes but the role
    // assignments survive (or the process dies between them) the user keeps
    // guild privileges and regains every role the moment they re-join.
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM member_roles
         WHERE user_id = $1
           AND role_id IN (SELECT id FROM roles WHERE space_id = $2)",
    )
    .bind(user_id)
    .bind(guild_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM members WHERE user_id = $1 AND guild_id = $2")
        .bind(user_id)
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn remove_member(pool: &DbPool, user_id: i64, guild_id: i64) -> Result<(), DbError> {
    remove_member_typed(pool, UserId::new(user_id), GuildId::new(guild_id)).await
}

/// Core implementation using newtype IDs.
pub async fn set_member_timeout_typed(
    pool: &DbPool,
    user_id: UserId,
    guild_id: GuildId,
    communication_disabled_until: Option<DateTime<Utc>>,
) -> Result<MemberRow, DbError> {
    let row = sqlx::query_as::<_, MemberRow>(
        "UPDATE members
         SET communication_disabled_until = $2
         WHERE user_id = $1 AND guild_id = $3
         RETURNING user_id, nick, avatar_hash, joined_at, CASE WHEN deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN mute THEN 1 ELSE 0 END AS mute, communication_disabled_until",
    )
    .bind(user_id)
    .bind(communication_disabled_until.map(datetime_to_db_text))
    .bind(guild_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn set_member_timeout(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    communication_disabled_until: Option<DateTime<Utc>>,
) -> Result<MemberRow, DbError> {
    set_member_timeout_typed(
        pool,
        UserId::new(user_id),
        GuildId::new(guild_id),
        communication_disabled_until,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn get_member_count_typed(pool: &DbPool, guild_id: GuildId) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

/// Raw i64 shim kept for API compat.
pub async fn get_member_count(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    get_member_count_typed(pool, GuildId::new(guild_id)).await
}

pub async fn get_all_memberships(pool: &DbPool) -> Result<Vec<(i64, i64)>, DbError> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT guild_id, user_id FROM members")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Core implementation using newtype ID.
pub async fn search_guild_members_typed(
    pool: &DbPool,
    guild_id: GuildId,
    query: &str,
    limit: i64,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    let pattern = format!("{query}%");
    let rows = match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            sqlx::query_as::<_, MemberWithUserRow>(
                "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                        u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
                 FROM members m
                 INNER JOIN users u ON u.id = m.user_id
                 WHERE m.guild_id = $1
                   AND (LOWER(u.username) LIKE LOWER($2) OR LOWER(COALESCE(u.display_name, '')) LIKE LOWER($2) OR LOWER(COALESCE(m.nick, '')) LIKE LOWER($2))
                 ORDER BY u.username
                 LIMIT $3",
            )
            .bind(guild_id)
            .bind(&pattern)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        crate::DatabaseEngine::Sqlite => {
            sqlx::query_as::<_, MemberWithUserRow>(
                "SELECT m.user_id, m.nick, m.avatar_hash, m.joined_at, CASE WHEN m.deaf THEN 1 ELSE 0 END AS deaf, CASE WHEN m.mute THEN 1 ELSE 0 END AS mute, m.communication_disabled_until,
                        u.username, u.display_name AS user_display_name, u.discriminator, u.avatar_hash AS user_avatar_hash, u.flags AS user_flags
                 FROM members m
                 INNER JOIN users u ON u.id = m.user_id
                 WHERE m.guild_id = $1
                   AND (u.username LIKE $2 COLLATE NOCASE OR COALESCE(u.display_name, '') LIKE $2 COLLATE NOCASE OR COALESCE(m.nick, '') LIKE $2 COLLATE NOCASE)
                 ORDER BY u.username
                 LIMIT $3",
            )
            .bind(guild_id)
            .bind(&pattern)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn search_guild_members(
    pool: &DbPool,
    guild_id: i64,
    query: &str,
    limit: i64,
) -> Result<Vec<MemberWithUserRow>, DbError> {
    search_guild_members_typed(pool, GuildId::new(guild_id), query, limit).await
}

/// Core implementation using newtype ID. Returns typed UserId vec.
pub async fn get_guild_member_user_ids_typed(
    pool: &DbPool,
    guild_id: GuildId,
) -> Result<Vec<UserId>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT user_id
         FROM members
         WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| UserId::new(id)).collect())
}

/// Raw i64 shim kept for API compat.
pub async fn get_guild_member_user_ids(pool: &DbPool, guild_id: i64) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT user_id
         FROM members
         WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(user_id,)| user_id).collect())
}

/// Core implementation using newtype IDs.
pub async fn share_any_guild_typed(
    pool: &DbPool,
    user_a: UserId,
    user_b: UserId,
) -> Result<bool, DbError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1
         FROM members a
         INNER JOIN members b ON a.guild_id = b.guild_id
         WHERE a.user_id = $1
           AND b.user_id = $2
         LIMIT 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Raw i64 shim kept for API compat.
pub async fn share_any_guild(pool: &DbPool, user_a: i64, user_b: i64) -> Result<bool, DbError> {
    share_any_guild_typed(pool, UserId::new(user_a), UserId::new(user_b)).await
}

pub async fn get_server_member_count(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(DISTINCT user_id) FROM members")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn setup_guild(pool: &DbPool) -> (i64, i64) {
        let user_id = 1;
        let guild_id = 100;
        crate::users::create_user(pool, user_id, "owner", 1, "o@example.com", "hash")
            .await
            .unwrap();
        crate::guilds::create_guild(pool, guild_id, "Test Guild", user_id, None)
            .await
            .unwrap();
        (user_id, guild_id)
    }

    #[tokio::test]
    async fn test_add_member() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        let member = get_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        assert!(member.is_some());
        let m = member.unwrap();
        assert_eq!(m.user_id, user_id);
        assert!(m.nick.is_none());
        assert!(!m.deaf);
        assert!(!m.mute);
    }

    #[tokio::test]
    async fn test_add_member_duplicate_is_noop() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        // Adding again should not error
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        let count = get_member_count_typed(&pool, GuildId::new(guild_id))
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_get_member_not_found() {
        let pool = test_pool().await;
        let member = get_member_typed(&pool, UserId::new(999), GuildId::new(888))
            .await
            .unwrap();
        assert!(member.is_none());
    }

    #[tokio::test]
    async fn test_remove_member() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        remove_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        let member = get_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        assert!(member.is_none());
    }

    #[tokio::test]
    async fn test_get_guild_members() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::users::create_user(&pool, 2, "user2", 1, "u2@example.com", "hash")
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(2), GuildId::new(guild_id))
            .await
            .unwrap();
        let members = get_guild_members_typed(&pool, GuildId::new(guild_id), 50, None)
            .await
            .unwrap();
        assert_eq!(members.len(), 2);
    }

    #[tokio::test]
    async fn test_get_guild_members_with_pagination() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        for i in 2..=5 {
            crate::users::create_user(
                &pool,
                i,
                &format!("user{}", i),
                1,
                &format!("u{}@example.com", i),
                "hash",
            )
            .await
            .unwrap();
        }
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        for i in 2..=5 {
            add_member_typed(&pool, UserId::new(i), GuildId::new(guild_id))
                .await
                .unwrap();
        }
        let page1 = get_guild_members_typed(&pool, GuildId::new(guild_id), 2, None)
            .await
            .unwrap();
        assert_eq!(page1.len(), 2);
        let last_id = page1.last().unwrap().user_id;
        let page2 =
            get_guild_members_typed(&pool, GuildId::new(guild_id), 2, Some(UserId::new(last_id)))
                .await
                .unwrap();
        assert_eq!(page2.len(), 2);
        // Ensure no overlap
        let page1_ids: Vec<i64> = page1.iter().map(|m| m.user_id).collect();
        let page2_ids: Vec<i64> = page2.iter().map(|m| m.user_id).collect();
        for id in &page2_ids {
            assert!(!page1_ids.contains(id));
        }
    }

    #[tokio::test]
    async fn test_update_member_nick() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        let updated = update_member_typed(
            &pool,
            UserId::new(user_id),
            GuildId::new(guild_id),
            Some("MyNick"),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.nick.as_deref(), Some("MyNick"));
    }

    #[tokio::test]
    async fn test_update_member_deaf_and_mute() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        let updated = update_member_typed(
            &pool,
            UserId::new(user_id),
            GuildId::new(guild_id),
            None,
            Some(true),
            Some(true),
        )
        .await
        .unwrap();
        assert!(updated.deaf);
        assert!(updated.mute);
    }

    #[tokio::test]
    async fn update_member_is_scoped_to_target_guild() {
        let pool = test_pool().await;
        let user_id = 1;
        crate::users::create_user(&pool, user_id, "tester", 1, "m@example.com", "hash")
            .await
            .unwrap();
        let guild_a =
            crate::guilds::create_space(&pool, GuildId::new(200), "a", UserId::new(user_id), None)
                .await
                .unwrap();
        let guild_b =
            crate::guilds::create_space(&pool, GuildId::new(201), "b", UserId::new(user_id), None)
                .await
                .unwrap();

        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_a.id))
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_b.id))
            .await
            .unwrap();

        update_member_typed(
            &pool,
            UserId::new(user_id),
            GuildId::new(guild_a.id),
            Some("nick-a"),
            None,
            None,
        )
        .await
        .unwrap();

        let member_a = get_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_a.id))
            .await
            .unwrap()
            .unwrap();
        let member_b = get_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_b.id))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(member_a.nick.as_deref(), Some("nick-a"));
        assert!(member_b.nick.is_none());
    }

    #[tokio::test]
    async fn test_get_member_count() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        assert_eq!(
            get_member_count_typed(&pool, GuildId::new(guild_id))
                .await
                .unwrap(),
            0
        );
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        assert_eq!(
            get_member_count_typed(&pool, GuildId::new(guild_id))
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn test_get_guild_member_user_ids() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::users::create_user(&pool, 2, "user2", 1, "u2@example.com", "hash")
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(2), GuildId::new(guild_id))
            .await
            .unwrap();
        let ids = get_guild_member_user_ids_typed(&pool, GuildId::new(guild_id))
            .await
            .unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&UserId::new(user_id)));
        assert!(ids.contains(&UserId::new(2)));
    }

    #[tokio::test]
    async fn test_share_any_guild() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::users::create_user(&pool, 2, "user2", 1, "u2@example.com", "hash")
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(2), GuildId::new(guild_id))
            .await
            .unwrap();
        assert!(
            share_any_guild_typed(&pool, UserId::new(user_id), UserId::new(2))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn test_share_any_guild_false_when_separate() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::users::create_user(&pool, 2, "user2", 1, "u2@example.com", "hash")
            .await
            .unwrap();
        add_member_typed(&pool, UserId::new(user_id), GuildId::new(guild_id))
            .await
            .unwrap();
        // user 2 not added to any guild
        assert!(
            !share_any_guild_typed(&pool, UserId::new(user_id), UserId::new(2))
                .await
                .unwrap()
        );
    }
}
