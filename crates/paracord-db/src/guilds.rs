use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
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
         VALUES (?1, ?2, ?3, ?4)
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
         FROM spaces WHERE id = ?1"
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
         SET name = COALESCE(?2, name),
             description = COALESCE(?3, description),
             icon_hash = COALESCE(?4, icon_hash),
             updated_at = datetime('now')
         WHERE id = ?1
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
         SET visibility = ?2,
             allowed_roles = ?3,
             updated_at = datetime('now')
         WHERE id = ?1
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
    sqlx::query("DELETE FROM spaces WHERE id = ?1")
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

pub async fn get_user_guilds(pool: &DbPool, _user_id: i64) -> Result<Vec<SpaceRow>, DbError> {
    // In the spaces model, all server members see all public spaces
    list_all_spaces(pool).await
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
        "UPDATE spaces SET owner_id = ?2, updated_at = datetime('now')
         WHERE id = ?1
         RETURNING id, name, description, icon_hash, banner_hash, owner_id, features, system_channel_id, vanity_url_code, visibility, allowed_roles, created_at"
    )
    .bind(space_id)
    .bind(new_owner_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}
