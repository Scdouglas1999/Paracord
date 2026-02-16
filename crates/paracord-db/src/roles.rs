use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct RoleRow {
    pub id: i64,
    pub space_id: i64,
    pub name: String,
    pub color: i32,
    pub hoist: bool,
    pub position: i32,
    pub permissions: i64,
    pub managed: bool,
    pub mentionable: bool,
    pub server_wide: bool,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for RoleRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            space_id: row.try_get("space_id")?,
            name: row.try_get("name")?,
            color: row.try_get("color")?,
            hoist: bool_from_any_row(row, "hoist")?,
            position: row.try_get("position")?,
            permissions: row.try_get("permissions")?,
            managed: bool_from_any_row(row, "managed")?,
            mentionable: bool_from_any_row(row, "mentionable")?,
            server_wide: bool_from_any_row(row, "server_wide")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl RoleRow {
    /// Backward compat alias
    pub fn guild_id(&self) -> i64 {
        self.space_id
    }
}

pub async fn create_role(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    name: &str,
    permissions: i64,
) -> Result<RoleRow, DbError> {
    let row = sqlx::query_as::<_, RoleRow>(
        "INSERT INTO roles (id, space_id, name, permissions)
         VALUES ($1, $2, $3, $4)
         RETURNING id, space_id, name, color, CASE WHEN hoist THEN 1 ELSE 0 END AS hoist, position, permissions, CASE WHEN managed THEN 1 ELSE 0 END AS managed, CASE WHEN mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN server_wide THEN 1 ELSE 0 END AS server_wide, created_at"
    )
    .bind(id)
    .bind(space_id)
    .bind(name)
    .bind(permissions)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_role(pool: &DbPool, id: i64) -> Result<Option<RoleRow>, DbError> {
    let row = sqlx::query_as::<_, RoleRow>(
        "SELECT id, space_id, name, color, CASE WHEN hoist THEN 1 ELSE 0 END AS hoist, position, permissions, CASE WHEN managed THEN 1 ELSE 0 END AS managed, CASE WHEN mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN server_wide THEN 1 ELSE 0 END AS server_wide, created_at
         FROM roles WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_role(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    color: Option<i32>,
    hoist: Option<bool>,
    permissions: Option<i64>,
    mentionable: Option<bool>,
) -> Result<RoleRow, DbError> {
    let row = sqlx::query_as::<_, RoleRow>(
        "UPDATE roles SET
            name = COALESCE($2, name),
            color = COALESCE($3, color),
            hoist = COALESCE($4, hoist),
            permissions = COALESCE($5, permissions),
            mentionable = COALESCE($6, mentionable)
         WHERE id = $1
         RETURNING id, space_id, name, color, CASE WHEN hoist THEN 1 ELSE 0 END AS hoist, position, permissions, CASE WHEN managed THEN 1 ELSE 0 END AS managed, CASE WHEN mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN server_wide THEN 1 ELSE 0 END AS server_wide, created_at"
    )
    .bind(id)
    .bind(name)
    .bind(color)
    .bind(hoist)
    .bind(permissions)
    .bind(mentionable)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_role(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_guild_roles(pool: &DbPool, space_id: i64) -> Result<Vec<RoleRow>, DbError> {
    get_space_roles(pool, space_id).await
}

pub async fn get_space_roles(pool: &DbPool, space_id: i64) -> Result<Vec<RoleRow>, DbError> {
    let rows = sqlx::query_as::<_, RoleRow>(
        "SELECT id, space_id, name, color, CASE WHEN hoist THEN 1 ELSE 0 END AS hoist, position, permissions, CASE WHEN managed THEN 1 ELSE 0 END AS managed, CASE WHEN mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN server_wide THEN 1 ELSE 0 END AS server_wide, created_at
         FROM roles WHERE space_id = $1 ORDER BY position"
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// member_roles no longer has guild_id - just user_id + role_id
pub async fn add_member_role(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    role_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO member_roles (user_id, role_id)
         SELECT $1, $3
         WHERE EXISTS (
             SELECT 1 FROM roles r
             WHERE r.id = $3
               AND r.space_id = $2
         )
           AND EXISTS (
             SELECT 1 FROM members m
             WHERE m.user_id = $1
               AND m.guild_id = $2
         )
         ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(guild_id)
    .bind(role_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_member_role(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    role_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM member_roles
         WHERE user_id = $1
           AND role_id = $2
           AND EXISTS (
               SELECT 1 FROM roles r
               WHERE r.id = $2
                 AND r.space_id = $3
           )",
    )
    .bind(user_id)
    .bind(role_id)
    .bind(guild_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_member_roles(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
) -> Result<Vec<RoleRow>, DbError> {
    let rows = sqlx::query_as::<_, RoleRow>(
        "SELECT DISTINCT
            r.id, r.space_id, r.name, r.color, CASE WHEN r.hoist THEN 1 ELSE 0 END AS hoist, r.position, r.permissions, CASE WHEN r.managed THEN 1 ELSE 0 END AS managed, CASE WHEN r.mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN r.server_wide THEN 1 ELSE 0 END AS server_wide, r.created_at
         FROM roles r
         LEFT JOIN member_roles mr
            ON mr.role_id = r.id
            AND mr.user_id = $1
         WHERE r.space_id = $2
           AND (
                mr.user_id IS NOT NULL
                OR (
                    r.id = $2
                    AND EXISTS (
                        SELECT 1 FROM members m
                        WHERE m.user_id = $1
                          AND m.guild_id = $2
                    )
                )
           )
         ORDER BY r.position"
    )
    .bind(user_id)
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_user_all_roles(pool: &DbPool, user_id: i64) -> Result<Vec<RoleRow>, DbError> {
    let rows = sqlx::query_as::<_, RoleRow>(
        "SELECT r.id, r.space_id, r.name, r.color, CASE WHEN r.hoist THEN 1 ELSE 0 END AS hoist, r.position, r.permissions, CASE WHEN r.managed THEN 1 ELSE 0 END AS managed, CASE WHEN r.mentionable THEN 1 ELSE 0 END AS mentionable, CASE WHEN r.server_wide THEN 1 ELSE 0 END AS server_wide, r.created_at
         FROM roles r
         INNER JOIN member_roles mr ON mr.role_id = r.id
         WHERE mr.user_id = $1
         ORDER BY r.position"
    )
    .bind(user_id)
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
    async fn test_create_role() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        let role = create_role(&pool, 500, guild_id, "Moderator", 0x0D)
            .await
            .unwrap();
        assert_eq!(role.id, 500);
        assert_eq!(role.space_id, guild_id);
        assert_eq!(role.name, "Moderator");
        assert_eq!(role.permissions, 0x0D);
        assert_eq!(role.color, 0);
        assert!(!role.hoist);
        assert!(!role.mentionable);
    }

    #[tokio::test]
    async fn test_get_role() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        create_role(&pool, 501, guild_id, "Admin", 8).await.unwrap();
        let role = get_role(&pool, 501).await.unwrap().unwrap();
        assert_eq!(role.name, "Admin");
    }

    #[tokio::test]
    async fn test_get_role_not_found() {
        let pool = test_pool().await;
        let role = get_role(&pool, 9999).await.unwrap();
        assert!(role.is_none());
    }

    #[tokio::test]
    async fn test_update_role() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        create_role(&pool, 502, guild_id, "OldName", 0)
            .await
            .unwrap();
        let updated = update_role(
            &pool,
            502,
            Some("NewName"),
            Some(0xFF0000),
            Some(true),
            None,
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "NewName");
        assert_eq!(updated.color, 0xFF0000);
        assert!(updated.hoist);
        assert!(updated.mentionable);
    }

    #[tokio::test]
    async fn test_update_role_partial() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        create_role(&pool, 503, guild_id, "Keep", 0).await.unwrap();
        let updated = update_role(&pool, 503, None, None, None, Some(42), None)
            .await
            .unwrap();
        assert_eq!(updated.name, "Keep");
        assert_eq!(updated.permissions, 42);
    }

    #[tokio::test]
    async fn test_delete_role() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        create_role(&pool, 504, guild_id, "Gone", 0).await.unwrap();
        delete_role(&pool, 504).await.unwrap();
        let role = get_role(&pool, 504).await.unwrap();
        assert!(role.is_none());
    }

    #[tokio::test]
    async fn test_get_guild_roles() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        create_role(&pool, 505, guild_id, "Role A", 0)
            .await
            .unwrap();
        create_role(&pool, 506, guild_id, "Role B", 0)
            .await
            .unwrap();
        let roles = get_guild_roles(&pool, guild_id).await.unwrap();
        // The @everyone role (id = guild_id) is auto-created, plus our 2
        assert!(roles.len() >= 2);
    }

    #[tokio::test]
    async fn test_add_and_get_member_roles() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::members::add_member(&pool, user_id, guild_id)
            .await
            .unwrap();
        create_role(&pool, 510, guild_id, "Tester", 0)
            .await
            .unwrap();
        add_member_role(&pool, user_id, guild_id, 510)
            .await
            .unwrap();
        let roles = get_member_roles(&pool, user_id, guild_id).await.unwrap();
        let role_ids: Vec<i64> = roles.iter().map(|r| r.id).collect();
        assert!(role_ids.contains(&510));
    }

    #[tokio::test]
    async fn test_remove_member_role() {
        let pool = test_pool().await;
        let (user_id, guild_id) = setup_guild(&pool).await;
        crate::members::add_member(&pool, user_id, guild_id)
            .await
            .unwrap();
        create_role(&pool, 520, guild_id, "Temp", 0).await.unwrap();
        add_member_role(&pool, user_id, guild_id, 520)
            .await
            .unwrap();
        remove_member_role(&pool, user_id, guild_id, 520)
            .await
            .unwrap();
        let roles = get_member_roles(&pool, user_id, guild_id).await.unwrap();
        let role_ids: Vec<i64> = roles.iter().map(|r| r.id).collect();
        assert!(!role_ids.contains(&520));
    }

    #[tokio::test]
    async fn test_guild_id_backward_compat() {
        let pool = test_pool().await;
        let (_user_id, guild_id) = setup_guild(&pool).await;
        let role = create_role(&pool, 530, guild_id, "Compat", 0)
            .await
            .unwrap();
        assert_eq!(role.guild_id(), guild_id);
    }
}
