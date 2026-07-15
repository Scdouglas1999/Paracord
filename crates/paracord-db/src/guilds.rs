use crate::{datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::id::{GuildId, RoleId, UserId};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

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
    /// JSON array of role IDs permitted to see a role-gated guild. Empty (`[]`)
    /// for guilds that are not role-gated. Kept distinct from `discovery_tags`.
    pub allowed_roles: String,
    /// JSON array of discovery tag strings for public/discoverable guilds.
    pub discovery_tags: String,
    pub created_at: DateTime<Utc>,
    pub hub_settings: Option<String>,
    pub bot_settings: Option<String>,
}

impl SpaceRow {
    #[inline]
    pub fn guild_id(&self) -> GuildId {
        GuildId::from(self.id)
    }

    #[inline]
    pub fn owner_user_id(&self) -> UserId {
        UserId::from(self.owner_id)
    }
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
            discovery_tags: row.try_get("discovery_tags")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            hub_settings: row.try_get("hub_settings").unwrap_or(None),
            bot_settings: row.try_get("bot_settings").unwrap_or(None),
        })
    }
}

// Backward compat alias
pub type GuildRow = SpaceRow;

/// Core implementation using newtype IDs.
pub async fn create_space(
    pool: &DbPool,
    id: GuildId,
    name: &str,
    owner_id: UserId,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "INSERT INTO spaces (id, name, owner_id, icon_hash, visibility)
         VALUES ($1, $2, $3, $4, 'private')
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings"
    )
    .bind(id)
    .bind(name)
    .bind(owner_id)
    .bind(icon_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim for backward compatibility with callers that haven't migrated.
pub async fn create_guild(
    pool: &DbPool,
    id: i64,
    name: &str,
    owner_id: i64,
    icon_hash: Option<&str>,
) -> Result<SpaceRow, DbError> {
    create_space(
        pool,
        GuildId::new(id),
        name,
        UserId::new(owner_id),
        icon_hash,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn get_space(pool: &DbPool, id: GuildId) -> Result<Option<SpaceRow>, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "SELECT id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings
         FROM spaces WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim for backward compatibility.
pub async fn get_guild(pool: &DbPool, id: i64) -> Result<Option<SpaceRow>, DbError> {
    get_space(pool, GuildId::new(id)).await
}

/// Core implementation using newtype ID.
pub async fn update_space(
    pool: &DbPool,
    id: GuildId,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
    hub_settings: Option<&str>,
    bot_settings: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             icon_hash = COALESCE($4, icon_hash),
             hub_settings = COALESCE($5, hub_settings),
             bot_settings = COALESCE($6, bot_settings),
             updated_at = $7
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings"
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(icon_hash)
    .bind(hub_settings)
    .bind(bot_settings)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim for backward compatibility.
pub async fn update_guild(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
    hub_settings: Option<&str>,
    bot_settings: Option<&str>,
) -> Result<SpaceRow, DbError> {
    update_space(
        pool,
        GuildId::new(id),
        name,
        description,
        icon_hash,
        hub_settings,
        bot_settings,
    )
    .await
}

/// Update a guild's discovery visibility and its discovery tags.
///
/// `discovery_tags` is written to the dedicated `discovery_tags` column and is
/// kept separate from `allowed_roles` (the role-gating allowed role IDs).
/// When `allowed_roles` is `None`, the existing column value is preserved.
/// Core implementation using newtype ID.
pub async fn update_space_visibility(
    pool: &DbPool,
    id: GuildId,
    visibility: &str,
    discovery_tags: &str,
    allowed_roles: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces
         SET visibility = $2,
             discovery_tags = $3,
             allowed_roles = COALESCE($4, allowed_roles),
             updated_at = $5
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings"
    )
    .bind(id)
    .bind(visibility)
    .bind(discovery_tags)
    .bind(allowed_roles)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Core implementation using newtype ID.
pub async fn delete_space(pool: &DbPool, id: GuildId) -> Result<(), DbError> {
    sqlx::query("DELETE FROM spaces WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim for backward compatibility.
pub async fn delete_guild(pool: &DbPool, id: i64) -> Result<(), DbError> {
    delete_space(pool, GuildId::new(id)).await
}

pub async fn list_all_spaces(pool: &DbPool) -> Result<Vec<SpaceRow>, DbError> {
    let rows = sqlx::query_as::<_, SpaceRow>(
        "SELECT id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings
         FROM spaces
         ORDER BY created_at ASC"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Core implementation using newtype ID.
pub async fn get_user_guilds(pool: &DbPool, user_id: UserId) -> Result<Vec<SpaceRow>, DbError> {
    let rows = sqlx::query_as::<_, SpaceRow>(
        "SELECT s.id, s.name, s.description, s.icon_hash, s.banner_hash, s.owner_id, s.features,
                s.system_channel_id, s.vanity_url_code, s.visibility, s.allowed_roles, s.discovery_tags, s.created_at, s.hub_settings, s.bot_settings
         FROM spaces s
         INNER JOIN members m ON m.guild_id = s.id
         WHERE m.user_id = $1
         ORDER BY s.created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    // Batch-fetch all member roles once to avoid per-guild role lookups.
    let member_roles: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT r.space_id, mr.role_id
         FROM member_roles mr
         INNER JOIN roles r ON r.id = mr.role_id
         WHERE mr.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut user_roles_by_space: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (space_id, role_id) in member_roles {
        user_roles_by_space
            .entry(space_id)
            .or_default()
            .insert(role_id);
    }

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

        let user_roles = user_roles_by_space.get(&row.id);
        if allowed_roles
            .into_iter()
            .any(|role_id| user_roles.is_some_and(|roles| roles.contains(&role_id)))
        {
            visible.push(row);
        }
    }

    Ok(visible)
}

pub fn parse_allowed_role_ids(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

pub fn parse_allowed_role_ids_typed(raw: &str) -> Vec<RoleId> {
    parse_allowed_role_ids(raw)
        .into_iter()
        .map(RoleId::from)
        .collect()
}

/// Set or clear the vanity URL code for a guild. Pass `None` to clear it.
/// Core implementation using newtype ID.
pub async fn update_vanity_url(
    pool: &DbPool,
    guild_id: GuildId,
    code: Option<&str>,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces
         SET vanity_url_code = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings"
    )
    .bind(guild_id)
    .bind(code)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Look up a guild by its vanity URL code.
pub async fn get_guild_by_vanity_code(
    pool: &DbPool,
    code: &str,
) -> Result<Option<SpaceRow>, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "SELECT id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings
         FROM spaces WHERE vanity_url_code = $1"
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row)
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

/// Core implementation using newtype IDs.
pub async fn transfer_ownership(
    pool: &DbPool,
    space_id: GuildId,
    new_owner_id: UserId,
) -> Result<SpaceRow, DbError> {
    let row = sqlx::query_as::<_, SpaceRow>(
        "UPDATE spaces SET owner_id = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, discovery_tags, created_at, hub_settings, bot_settings"
    )
    .bind(space_id)
    .bind(new_owner_id)
    .bind(datetime_to_db_text(Utc::now()))
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
        let guild = create_space(&pool, GuildId::new(100), "Test Guild", UserId::new(1), None)
            .await
            .unwrap();
        assert_eq!(guild.id, 100);
        assert_eq!(guild.name, "Test Guild");
        assert_eq!(guild.owner_id, 1);
        assert!(guild.icon_hash.is_none());
        assert!(guild.description.is_none());
        assert_eq!(guild.visibility, "private");
    }

    #[tokio::test]
    async fn test_create_guild_with_icon() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        let guild = create_space(
            &pool,
            GuildId::new(101),
            "Icon Guild",
            UserId::new(1),
            Some("abc123"),
        )
        .await
        .unwrap();
        assert_eq!(guild.icon_hash.as_deref(), Some("abc123"));
    }

    #[tokio::test]
    async fn test_get_guild() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 200, "My Guild", 1, None).await.unwrap();
        let guild = get_space(&pool, GuildId::new(200)).await.unwrap().unwrap();
        assert_eq!(guild.name, "My Guild");
    }

    #[tokio::test]
    async fn test_get_guild_not_found() {
        let pool = test_pool().await;
        let guild = get_space(&pool, GuildId::new(999)).await.unwrap();
        assert!(guild.is_none());
    }

    #[tokio::test]
    async fn test_update_guild() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 300, "Old Name", 1, None).await.unwrap();
        let updated = update_space(
            &pool,
            GuildId::new(300),
            Some("New Name"),
            Some("A description"),
            None,
            None,
            None,
        )
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
        let updated = update_space(
            &pool,
            GuildId::new(301),
            None,
            Some("desc only"),
            None,
            None,
            None,
        )
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
        delete_space(&pool, GuildId::new(400)).await.unwrap();
        let guild = get_space(&pool, GuildId::new(400)).await.unwrap();
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
        let guilds = get_user_guilds(&pool, UserId::new(1)).await.unwrap();
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
        let transferred = transfer_ownership(&pool, GuildId::new(800), UserId::new(2))
            .await
            .unwrap();
        assert_eq!(transferred.owner_id, 2);
    }

    #[tokio::test]
    async fn test_update_space_visibility() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 900, "Vis Guild", 1, None)
            .await
            .unwrap();
        let updated = update_space_visibility(
            &pool,
            GuildId::new(900),
            "public",
            "[\"gaming\",\"chat\"]",
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.visibility, "public");
        // Discovery tags land in their own column, leaving allowed_roles (the
        // role-gating role IDs) untouched when not provided.
        assert_eq!(updated.discovery_tags, "[\"gaming\",\"chat\"]");
        assert_eq!(updated.allowed_roles, "[]");
    }

    #[tokio::test]
    async fn test_public_guild_with_discovery_tags_is_not_role_gated() {
        // A public guild that sets discovery tags must keep an empty
        // allowed_roles column so it is NOT treated as role-gated. This is the
        // invariant auto_join_public_spaces relies on to still auto-join it.
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 950, "Public Guild", 1, None)
            .await
            .unwrap();
        let updated = update_space_visibility(
            &pool,
            GuildId::new(950),
            "public",
            "[\"gaming\"]",
            Some("[]"),
        )
        .await
        .unwrap();
        assert_eq!(updated.visibility, "public");
        assert_eq!(
            parse_allowed_role_ids(&updated.allowed_roles),
            Vec::<i64>::new()
        );
        assert_eq!(updated.discovery_tags, "[\"gaming\"]");
    }

    #[tokio::test]
    async fn test_update_space_visibility_writes_allowed_roles() {
        let pool = test_pool().await;
        create_test_user(&pool, 1).await;
        create_guild(&pool, 960, "Roles Guild", 1, None)
            .await
            .unwrap();
        let updated =
            update_space_visibility(&pool, GuildId::new(960), "roles", "[]", Some("[11,22]"))
                .await
                .unwrap();
        assert_eq!(updated.visibility, "roles");
        assert_eq!(parse_allowed_role_ids(&updated.allowed_roles), vec![11, 22]);
    }

    #[tokio::test]
    async fn test_parse_allowed_role_ids() {
        assert_eq!(parse_allowed_role_ids("[1,2,3]"), vec![1, 2, 3]);
        assert_eq!(parse_allowed_role_ids("[]"), Vec::<i64>::new());
        assert_eq!(parse_allowed_role_ids("invalid"), Vec::<i64>::new());
    }
}
