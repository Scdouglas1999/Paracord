use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
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
         VALUES (?1, ?2, ?3, ?4)
         RETURNING id, space_id, name, color, hoist, position, permissions, managed, mentionable, server_wide, created_at"
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
        "SELECT id, space_id, name, color, hoist, position, permissions, managed, mentionable, server_wide, created_at
         FROM roles WHERE id = ?1"
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
            name = COALESCE(?2, name),
            color = COALESCE(?3, color),
            hoist = COALESCE(?4, hoist),
            permissions = COALESCE(?5, permissions),
            mentionable = COALESCE(?6, mentionable)
         WHERE id = ?1
         RETURNING id, space_id, name, color, hoist, position, permissions, managed, mentionable, server_wide, created_at"
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
    sqlx::query("DELETE FROM roles WHERE id = ?1")
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
        "SELECT id, space_id, name, color, hoist, position, permissions, managed, mentionable, server_wide, created_at
         FROM roles WHERE space_id = ?1 ORDER BY position"
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
    _guild_id: i64,
    role_id: i64,
) -> Result<(), DbError> {
    sqlx::query("INSERT INTO member_roles (user_id, role_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(role_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn remove_member_role(
    pool: &DbPool,
    user_id: i64,
    _guild_id: i64,
    role_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM member_roles WHERE user_id = ?1 AND role_id = ?2")
        .bind(user_id)
        .bind(role_id)
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
        "SELECT r.id, r.space_id, r.name, r.color, r.hoist, r.position, r.permissions, r.managed, r.mentionable, r.server_wide, r.created_at
         FROM roles r
         INNER JOIN member_roles mr ON mr.role_id = r.id
         WHERE mr.user_id = ?1 AND r.space_id = ?2
         ORDER BY r.position"
    )
    .bind(user_id)
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_user_all_roles(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<RoleRow>, DbError> {
    let rows = sqlx::query_as::<_, RoleRow>(
        "SELECT r.id, r.space_id, r.name, r.color, r.hoist, r.position, r.permissions, r.managed, r.mentionable, r.server_wide, r.created_at
         FROM roles r
         INNER JOIN member_roles mr ON mr.role_id = r.id
         WHERE mr.user_id = ?1
         ORDER BY r.position"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
