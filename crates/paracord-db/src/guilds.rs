use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct SpaceRow {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub icon_hash: Option<String>,
    pub banner_hash: Option<String>,
    pub owner_id: i64,
    pub features: i32,
    pub system_channel_id: Option<i64>,
    pub vanity_url_code: Option<String>,
    pub visibility: String,
    pub allowed_roles: String,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for SpaceRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            icon_hash: row.try_get("icon_hash")?,
            banner_hash: row.try_get("banner_hash")?,
            owner_id: row.try_get("owner_id")?,
            features: row.try_get("features")?,
            system_channel_id: row.try_get("system_channel_id")?,
            vanity_url_code: row.try_get("vanity_url_code")?,
            visibility: row.try_get("visibility")?,
            allowed_roles: row.try_get("allowed_roles")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

// Backward compat alias
pub type GuildRow = SpaceRow;

pub async fn create_space(
    pool: &DbPool,
    id: i64,
    name: &str,
    owner_id: i64,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "INSERT INTO spaces (id, name, owner_id, icon_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at"
    )
    .bind(id)
    .bind(name)
    .bind(owner_id)
    .bind(icon_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn create_guild(
    pool: &DbPool,
    id: i64,
    name: &str,
    owner_id: i64,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    create_space(pool, id, name, owner_id, icon_hash).await
}

pub async fn get_space(pool: &DbPool, id: i64) -> Result<Option<SpaceRow>, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "SELECT id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at
         FROM spaces WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_guild(pool: &DbPool, id: i64) -> Result<Option<SpaceRow>, DbError> {
    get_space(pool, id).await
}

pub async fn update_space(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             icon_hash = COALESCE($4, icon_hash),
             updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at"
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(icon_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_guild(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    update_space(pool, id, name, description, icon_hash).await
}

pub async fn update_space_visibility(
    pool: &DbPool,
    id: i64,
    visibility: &str,
    allowed_roles: &str,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces
         SET visibility = $2,
             allowed_roles = $3,
             updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at"
    )
    .bind(id)
    .bind(visibility)
    .bind(allowed_roles)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_space(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM spaces WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_guild(pool: &DbPool, id: i64) -> Result<(), DbError> {
    delete_space(pool, id).await
}

pub async fn list_all_spaces(pool: &DbPool) -> Result<Vec<SpaceRow>, DbError> {
    let rows = sqlx::query_as::<_, SpaceRow>(
        "SELECT id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at
         FROM spaces
         ORDER BY created_at ASC"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_user_guilds(pool: &DbPool, user_id: i64) -> Result<Vec<SpaceRow>, DbError> {
    let rows = sqlx::query_as::<_, SpaceRow>(
        "SELECT s.id, s.name, s.description, s.icon_hash, s.banner_hash, s.owner_id, s.features,
                s.system_channel_id, s.vanity_url_code, s.visibility, s.allowed_roles, s.created_at
         FROM spaces s
         INNER JOIN members m ON m.guild_id = s.id
         WHERE m.user_id = $1
         ORDER BY s.created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut visible = Vec::with_capacity(rows.len());
    for row in rows {
        if row.visibility != "roles" {
            visible.push(row);
            continue;
        }

        let allowed_roles = parse_allowed_role_ids(&row.allowed_roles);
        if allowed_roles.is_empty() {
            visible.push(row);
            continue;
        }

        let member_role_rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT mr.role_id
             FROM member_roles mr
             INNER JOIN roles r ON r.id = mr.role_id
             WHERE mr.user_id = $1
               AND r.space_id = $2",
        )
        .bind(user_id)
        .bind(row.id)
        .fetch_all(pool)
        .await?;

        let user_roles: HashSet<i64> = member_role_rows.into_iter().map(|(id,)| id).collect();
        if allowed_roles
            .into_iter()
            .any(|role_id| user_roles.contains(&role_id))
        {
            visible.push(row);
        }
    }

    Ok(visible)
}

pub fn parse_allowed_role_ids(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

pub async fn list_all_guilds(pool: &DbPool) -> Result<Vec<SpaceRow>, DbError> {
    list_all_spaces(pool).await
}

pub async fn count_spaces(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM spaces")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn count_guilds(pool: &DbPool) -> Result<i64, DbError> {
    count_spaces(pool).await
}

pub async fn transfer_ownership(
    pool: &DbPool,
    space_id: i64,
    new_owner_id: i64,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces SET owner_id = $2, updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at"
    )
    .bind(space_id)
    .bind(new_owner_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn create_test_user(pool: &DbPool, id: i64) {
        crate::users::create_user(
            pool,
            id,
            &format!("user{}", id),
            1,
            &format!("user{}@example.com", id),
            "hash",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn test_create_guild_with_valid_data() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        let guild = create_guild(&pool, 100, "Test Guild", 1, None)
            .await
            .unwrap();
        assert_eq!(guild.id, 100);
        assert_eq!(guild.name, "Test Guild");
        assert_eq!(guild.owner_id, 1);
        assert!(guild.icon_hash.is_none());
        assert!(guild.description.is_none());
    }

    #[tokio::test]
    async fn test_create_guild_with_icon() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        let guild = create_guild(&pool, 101, "Icon Guild", 1, Some("abc123"))
            .await
            .unwrap();
        assert_eq!(guild.icon_hash.as_deref(), Some("abc123"));
    }

    #[tokio::test]
    async fn test_get_guild() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 200, "My Guild", 1, None).await.unwrap();
        let guild = get_guild(&pool, 200).await.unwrap().unwrap();
        assert_eq!(guild.name, "My Guild");
    }

    #[tokio::test]
    async fn test_get_guild_not_found() {
        let pool = test_pool().await;
        let guild = get_guild(&pool, 999).await.unwrap();
        assert!(guild.is_none());
    }

    #[tokio::test]
    async fn test_update_guild() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 300, "Old Name", 1, None).await.unwrap();
        let updated = update_guild(&pool, 300, Some("New Name"), Some("A description"), None)
            .await
            .unwrap();
        assert_eq!(updated.name, "New Name");
        assert_eq!(updated.description.as_deref(), Some("A description"));
    }

    #[tokio::test]
    async fn test_update_guild_partial() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 301, "Original", 1, None).await.unwrap();
        let updated = update_guild(&pool, 301, None, Some("desc only"), None)
            .await
            .unwrap();
        assert_eq!(updated.name, "Original");
        assert_eq!(updated.description.as_deref(), Some("desc only"));
    }

    #[tokio::test]
    async fn test_delete_guild() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 400, "To Delete", 1, None)
            .await
            .unwrap();
        delete_guild(&pool, 400).await.unwrap();
        let guild = get_guild(&pool, 400).await.unwrap();
        assert!(guild.is_none());
    }

    #[tokio::test]
    async fn test_list_user_guilds() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 500, "Guild A", 1, None).await.unwrap();
        create_guild(&pool, 501, "Guild B", 1, None).await.unwrap();
        crate::members::add_member(&pool, 1, 500).await.unwrap();
        crate::members::add_member(&pool, 1, 501).await.unwrap();
        let guilds = get_user_guilds(&pool, 1).await.unwrap();
        assert_eq!(guilds.len(), 2);
    }

    #[tokio::test]
    async fn test_count_guilds() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        assert_eq!(count_guilds(&pool).await.unwrap(), 0);
        create_guild(&pool, 600, "G1", 1, None).await.unwrap();
        create_guild(&pool, 601, "G2", 1, None).await.unwrap();
        assert_eq!(count_guilds(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_list_all_guilds() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 700, "First", 1, None).await.unwrap();
        create_guild(&pool, 701, "Second", 1, None).await.unwrap();
        let all = list_all_guilds(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_transfer_ownership() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_test_user(&pool, 2).await;
        create_guild(&pool, 800, "Owned Guild", 1, None)
            .await
            .unwrap();
        let transferred = transfer_ownership(&pool, 800, 2).await.unwrap();
        assert_eq!(transferred.owner_id, 2);
    }

    #[tokio::test]
    async fn test_update_space_visibility() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 900, "Vis Guild", 1, None)
            .await
            .unwrap();
        let updated = update_space_visibility(&pool, 900, "roles", "[10,20]")
            .await
            .unwrap();
        assert_eq!(updated.visibility, "roles");
        assert_eq!(updated.allowed_roles, "[10,20]");
    }

    #[tokio::test]
    async fn test_parse_allowed_role_ids() {
        assert_eq!(parse_allowed_role_ids("[1,2,3]"), vec![1, 2, 3]);
        assert_eq!(parse_allowed_role_ids("[]"), Vec::<i64>::new());
        assert_eq!(parse_allowed_role_ids("invalid"), Vec::<i64>::new());
    }
}
