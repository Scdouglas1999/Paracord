use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub discriminator: i16,
    pub email: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub banner_hash: Option<String>,
    pub bio: Option<String>,
    pub accent_color: Option<i32>,
    pub flags: i32,
    pub created_at: DateTime<Utc>,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserSettingsRow {
    pub user_id: i64,
    pub theme: String,
    pub custom_css: Option<String>,
    pub locale: String,
    pub message_display: String,
    pub crypto_auth_enabled: bool,
    pub notifications: serde_json::Value,
    pub keybinds: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

pub async fn create_user(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(username)
    .bind(discriminator)
    .bind(email)
    .bind(password_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Create a user and atomically promote to admin if this is the first user.
/// Uses a transaction to prevent TOCTOU race where two simultaneous
/// registrations both see count==0 and both become admin.
pub async fn create_user_as_first_admin(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    let mut tx = pool.begin().await?;

    // Count existing users inside the transaction (serialized by SQLite's write lock)
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;

    let flags = if count == 0 { admin_flag } else { 0 };

    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, flags)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(username)
    .bind(discriminator)
    .bind(email)
    .bind(password_hash)
    .bind(flags)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row)
}

pub async fn get_user_by_id(pool: &DbPool, id: i64) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE id = ?1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_email(pool: &DbPool, email: &str) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE email = ?1"
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_username(
    pool: &DbPool,
    username: &str,
    discriminator: i16,
) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE username = ?1 AND discriminator = ?2"
    )
    .bind(username)
    .bind(discriminator)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_username_only(
    pool: &DbPool,
    username: &str,
) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users
         WHERE username = ?1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_user(
    pool: &DbPool,
    id: i64,
    display_name: Option<&str>,
    bio: Option<&str>,
    avatar_hash: Option<&str>,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET display_name = COALESCE(?2, display_name), bio = COALESCE(?3, bio), avatar_hash = COALESCE(?4, avatar_hash), updated_at = datetime('now')
         WHERE id = ?1
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(display_name)
    .bind(bio)
    .bind(avatar_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_settings(pool: &DbPool, user_id: i64) -> Result<Option<UserSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "SELECT user_id, theme, custom_css, locale, message_display, crypto_auth_enabled, notifications, keybinds, updated_at
         FROM user_settings WHERE user_id = ?1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn count_users(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn update_user_flags(pool: &DbPool, id: i64, flags: i32) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET flags = ?2, updated_at = datetime('now')
         WHERE id = ?1
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(flags)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_users_paginated(pool: &DbPool, offset: i64, limit: i64) -> Result<Vec<UserRow>, DbError> {
    let rows = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users
         ORDER BY created_at ASC
         LIMIT ?1 OFFSET ?2"
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_user(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM users WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_user_settings(
    pool: &DbPool,
    user_id: i64,
    theme: &str,
    locale: &str,
    message_display: &str,
    custom_css: Option<&str>,
    crypto_auth_enabled: Option<bool>,
    notifications: Option<&serde_json::Value>,
    keybinds: Option<&serde_json::Value>,
) -> Result<UserSettingsRow, DbError> {
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "INSERT INTO user_settings (user_id, theme, locale, message_display, custom_css, crypto_auth_enabled, notifications, keybinds)
         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, FALSE), COALESCE(?7, '{}'), COALESCE(?8, '{}'))
         ON CONFLICT (user_id) DO UPDATE SET
            theme = ?2,
            locale = ?3,
            message_display = ?4,
            custom_css = ?5,
            crypto_auth_enabled = COALESCE(?6, user_settings.crypto_auth_enabled),
            notifications = COALESCE(?7, user_settings.notifications),
            keybinds = COALESCE(?8, user_settings.keybinds),
            updated_at = datetime('now')
         RETURNING user_id, theme, custom_css, locale, message_display, crypto_auth_enabled, notifications, keybinds, updated_at"
    )
    .bind(user_id)
    .bind(theme)
    .bind(locale)
    .bind(message_display)
    .bind(custom_css)
    .bind(crypto_auth_enabled)
    .bind(notifications)
    .bind(keybinds)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_user_public_key(
    pool: &DbPool,
    id: i64,
    public_key: &str,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET public_key = ?2, updated_at = datetime('now')
         WHERE id = ?1
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(public_key)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_public_key(pool: &DbPool, public_key: &str) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE public_key = ?1"
    )
    .bind(public_key)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn create_user_from_pubkey(
    pool: &DbPool,
    id: i64,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
) -> Result<UserRow, DbError> {
    let placeholder_email = format!("{}@pubkey", public_key);
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, display_name, public_key)
         VALUES (?1, ?2, 0, ?3, '', ?4, ?5)
         RETURNING id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key"
    )
    .bind(id)
    .bind(username)
    .bind(&placeholder_email)
    .bind(display_name)
    .bind(public_key)
    .fetch_one(pool)
    .await?;
    Ok(row)
}
