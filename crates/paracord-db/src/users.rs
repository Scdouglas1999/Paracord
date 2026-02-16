use crate::{bool_from_any_row, datetime_from_db_text, json_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub discriminator: i16,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub banner_hash: Option<String>,
    pub bio: Option<String>,
    pub accent_color: Option<i32>,
    pub flags: i32,
    pub created_at: DateTime<Utc>,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UserAuthRow {
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

#[derive(Debug, Clone)]
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

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            username: row.try_get("username")?,
            discriminator: row.try_get("discriminator")?,
            email: row.try_get("email")?,
            display_name: row.try_get("display_name")?,
            avatar_hash: row.try_get("avatar_hash")?,
            banner_hash: row.try_get("banner_hash")?,
            bio: row.try_get("bio")?,
            accent_color: row.try_get("accent_color")?,
            flags: row.try_get("flags")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            public_key: row.try_get("public_key")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserAuthRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            username: row.try_get("username")?,
            discriminator: row.try_get("discriminator")?,
            email: row.try_get("email")?,
            password_hash: row.try_get("password_hash")?,
            display_name: row.try_get("display_name")?,
            avatar_hash: row.try_get("avatar_hash")?,
            banner_hash: row.try_get("banner_hash")?,
            bio: row.try_get("bio")?,
            accent_color: row.try_get("accent_color")?,
            flags: row.try_get("flags")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            public_key: row.try_get("public_key")?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserSettingsRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let notifications_raw: String = row.try_get("notifications")?;
        let keybinds_raw: String = row.try_get("keybinds")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            theme: row.try_get("theme")?,
            custom_css: row.try_get("custom_css")?,
            locale: row.try_get("locale")?,
            message_display: row.try_get("message_display")?,
            crypto_auth_enabled: bool_from_any_row(row, "crypto_auth_enabled")?,
            notifications: json_from_db_text(&notifications_raw)?,
            keybinds: json_from_db_text(&keybinds_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn create_user(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(username)
    .bind(discriminator)
    .bind(normalized_email)
    .bind(password_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Create a user and atomically promote to admin if this is the first user.
/// Uses a transaction to prevent registration races.
pub async fn create_user_as_first_admin(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let mut tx = pool.begin().await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    let flags = if count == 0 { admin_flag } else { 0 };

    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, flags)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(username)
    .bind(discriminator)
    .bind(normalized_email)
    .bind(password_hash)
    .bind(flags)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row)
}

pub async fn get_user_by_id(pool: &DbPool, id: i64) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_email(pool: &DbPool, email: &str) -> Result<Option<UserAuthRow>, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE lower(email) = $1",
    )
    .bind(normalized_email)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_auth_by_id(pool: &DbPool, id: i64) -> Result<Option<UserAuthRow>, DbError> {
    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE id = $1",
    )
    .bind(id)
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
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE username = $1 AND discriminator = $2",
    )
    .bind(username)
    .bind(discriminator)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_auth_by_username(
    pool: &DbPool,
    username: &str,
    discriminator: i16,
) -> Result<Option<UserAuthRow>, DbError> {
    let normalized_username = username.trim().to_ascii_lowercase();
    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE lower(username) = $1 AND discriminator = $2",
    )
    .bind(normalized_username)
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
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users
         WHERE username = $1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_auth_by_username_only(
    pool: &DbPool,
    username: &str,
) -> Result<Option<UserAuthRow>, DbError> {
    let normalized_username = username.trim().to_ascii_lowercase();
    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users
         WHERE lower(username) = $1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(normalized_username)
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
        "UPDATE users SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), avatar_hash = COALESCE($4, avatar_hash), updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(display_name)
    .bind(bio)
    .bind(avatar_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_settings(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<UserSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "SELECT user_id, theme, custom_css, locale, message_display, CASE WHEN crypto_auth_enabled THEN 1 ELSE 0 END AS crypto_auth_enabled, notifications, keybinds, updated_at
         FROM user_settings WHERE user_id = $1",
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
        "UPDATE users SET flags = $2, updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(flags)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_users_paginated(
    pool: &DbPool,
    offset: i64,
    limit: i64,
) -> Result<Vec<UserRow>, DbError> {
    let rows = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users
         ORDER BY created_at ASC
         LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_user(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM users WHERE id = $1")
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
    let notifications = notifications
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| {
            DbError::Sqlx(sqlx::Error::Protocol(format!(
                "invalid notifications json: {e}"
            )))
        })?;
    let keybinds = keybinds
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(format!("invalid keybinds json: {e}"))))?;
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "INSERT INTO user_settings (user_id, theme, locale, message_display, custom_css, crypto_auth_enabled, notifications, keybinds)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), COALESCE($7, '{}'), COALESCE($8, '{}'))
         ON CONFLICT (user_id) DO UPDATE SET
            theme = $2,
            locale = $3,
            message_display = $4,
            custom_css = $5,
            crypto_auth_enabled = COALESCE($6, user_settings.crypto_auth_enabled),
            notifications = COALESCE($7, user_settings.notifications),
            keybinds = COALESCE($8, user_settings.keybinds),
            updated_at = datetime('now')
         RETURNING user_id, theme, custom_css, locale, message_display, CASE WHEN crypto_auth_enabled THEN 1 ELSE 0 END AS crypto_auth_enabled, notifications, keybinds, updated_at",
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
        "UPDATE users SET public_key = $2, updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(public_key)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_user_password_hash(
    pool: &DbPool,
    id: i64,
    password_hash: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE users
         SET password_hash = $2, updated_at = datetime('now')
         WHERE id = $1",
    )
    .bind(id)
    .bind(password_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_user_email(pool: &DbPool, id: i64, email: &str) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users
         SET email = $2, updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(normalized_email)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_user_by_public_key(
    pool: &DbPool,
    public_key: &str,
) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key
         FROM users WHERE public_key = $1",
    )
    .bind(public_key)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MutualGuildRow {
    pub id: i64,
    pub name: String,
    pub icon_hash: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MutualFriendRow {
    pub id: i64,
    pub username: String,
    pub discriminator: i16,
    pub avatar_hash: Option<String>,
}

pub async fn get_mutual_guilds(
    pool: &DbPool,
    user_a: i64,
    user_b: i64,
) -> Result<Vec<MutualGuildRow>, DbError> {
    let rows = sqlx::query_as::<_, MutualGuildRow>(
        "SELECT s.id, s.name, s.icon_hash
         FROM spaces s
         INNER JOIN members ma ON ma.guild_id = s.id AND ma.user_id = $1
         INNER JOIN members mb ON mb.guild_id = s.id AND mb.user_id = $2
         ORDER BY s.name",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_mutual_friends(
    pool: &DbPool,
    user_a: i64,
    user_b: i64,
) -> Result<Vec<MutualFriendRow>, DbError> {
    let rows = sqlx::query_as::<_, MutualFriendRow>(
        "SELECT u.id, u.username, u.discriminator, u.avatar_hash
         FROM relationships ra
         INNER JOIN relationships rb ON ra.target_id = rb.target_id
         INNER JOIN users u ON u.id = ra.target_id
         WHERE ra.user_id = $1 AND rb.user_id = $2
           AND ra.rel_type = 1 AND rb.rel_type = 1
         ORDER BY u.username",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_all(pool)
    .await?;
    Ok(rows)
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
         VALUES ($1, $2, 0, $3, '', $4, $5)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
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

/// Create a pubkey-auth user and atomically promote to admin if first user.
pub async fn create_user_from_pubkey_as_first_admin(
    pool: &DbPool,
    id: i64,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    let mut tx = pool.begin().await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    let flags = if count == 0 { admin_flag } else { 0 };
    let placeholder_email = format!("{}@pubkey", public_key);

    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, display_name, public_key, flags)
         VALUES ($1, $2, 0, $3, '', $4, $5, $6)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key",
    )
    .bind(id)
    .bind(username)
    .bind(&placeholder_email)
    .bind(display_name)
    .bind(public_key)
    .bind(flags)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
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

    #[tokio::test]
    async fn test_create_user_with_valid_data() {
        let pool = test_pool().await;
        let user = create_user(&pool, 1, "testuser", 1, "test@example.com", "hashed_pw")
            .await
            .unwrap();
        assert_eq!(user.id, 1);
        assert_eq!(user.username, "testuser");
        assert_eq!(user.discriminator, 1);
        assert_eq!(user.email, "test@example.com");
        assert!(user.display_name.is_none());
        assert!(user.avatar_hash.is_none());
        assert_eq!(user.flags, 0);
    }

    #[tokio::test]
    async fn test_create_user_as_first_admin_sets_only_first_user_admin() {
        let pool = test_pool().await;
        let first =
            create_user_as_first_admin(&pool, 2, "first", 1, "first@example.com", "hash", 1)
                .await
                .unwrap();
        let second =
            create_user_as_first_admin(&pool, 3, "second", 1, "second@example.com", "hash", 1)
                .await
                .unwrap();

        assert_eq!(first.flags & 1, 1);
        assert_eq!(second.flags & 1, 0);
    }

    #[tokio::test]
    async fn test_create_user_duplicate_email_fails() {
        let pool = test_pool().await;
        create_user(&pool, 1, "user1", 1, "dup@example.com", "hash1")
            .await
            .unwrap();
        let result = create_user(&pool, 2, "user2", 2, "dup@example.com", "hash2").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_user_duplicate_email_case_insensitive_fails() {
        let pool = test_pool().await;
        create_user(&pool, 1, "user1", 1, "Case@Test.Example", "hash1")
            .await
            .unwrap();
        let result = create_user(&pool, 2, "user2", 2, "case@test.example", "hash2").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_user_by_id() {
        let pool = test_pool().await;
        create_user(&pool, 10, "alice", 1, "alice@example.com", "hash")
            .await
            .unwrap();
        let user = get_user_by_id(&pool, 10).await.unwrap().unwrap();
        assert_eq!(user.username, "alice");
    }

    #[tokio::test]
    async fn test_get_user_by_id_not_found() {
        let pool = test_pool().await;
        let user = get_user_by_id(&pool, 999).await.unwrap();
        assert!(user.is_none());
    }

    #[tokio::test]
    async fn test_get_user_by_email() {
        let pool = test_pool().await;
        create_user(&pool, 20, "bob", 1, "bob@example.com", "secret_hash")
            .await
            .unwrap();
        let auth = get_user_by_email(&pool, "bob@example.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(auth.id, 20);
        assert_eq!(auth.password_hash, "secret_hash");
    }

    #[tokio::test]
    async fn test_get_user_by_email_is_case_insensitive() {
        let pool = test_pool().await;
        create_user(
            &pool,
            21,
            "mixed",
            1,
            "MixedCase@Example.com",
            "secret_hash",
        )
        .await
        .unwrap();
        let auth = get_user_by_email(&pool, "mixedcase@example.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(auth.id, 21);
    }

    #[tokio::test]
    async fn test_get_user_by_email_not_found() {
        let pool = test_pool().await;
        let result = get_user_by_email(&pool, "nobody@example.com")
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_get_user_by_username() {
        let pool = test_pool().await;
        create_user(&pool, 30, "carol", 5, "carol@example.com", "hash")
            .await
            .unwrap();
        let user = get_user_by_username(&pool, "carol", 5)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.id, 30);
    }

    #[tokio::test]
    async fn test_get_user_by_username_wrong_discriminator() {
        let pool = test_pool().await;
        create_user(&pool, 31, "dave", 1, "dave@example.com", "hash")
            .await
            .unwrap();
        let result = get_user_by_username(&pool, "dave", 9999).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_update_user() {
        let pool = test_pool().await;
        create_user(&pool, 40, "eve", 1, "eve@example.com", "hash")
            .await
            .unwrap();
        let updated = update_user(&pool, 40, Some("Eve Display"), Some("Hello!"), None)
            .await
            .unwrap();
        assert_eq!(updated.display_name.as_deref(), Some("Eve Display"));
        assert_eq!(updated.bio.as_deref(), Some("Hello!"));
    }

    #[tokio::test]
    async fn test_update_user_partial_fields() {
        let pool = test_pool().await;
        create_user(&pool, 41, "frank", 1, "frank@example.com", "hash")
            .await
            .unwrap();
        update_user(&pool, 41, Some("Frank"), None, None)
            .await
            .unwrap();
        let user = get_user_by_id(&pool, 41).await.unwrap().unwrap();
        assert_eq!(user.display_name.as_deref(), Some("Frank"));
        assert!(user.bio.is_none());
    }

    #[tokio::test]
    async fn test_delete_user() {
        let pool = test_pool().await;
        create_user(&pool, 50, "deleteme", 1, "del@example.com", "hash")
            .await
            .unwrap();
        delete_user(&pool, 50).await.unwrap();
        let user = get_user_by_id(&pool, 50).await.unwrap();
        assert!(user.is_none());
    }

    #[tokio::test]
    async fn test_count_users() {
        let pool = test_pool().await;
        assert_eq!(count_users(&pool).await.unwrap(), 0);
        create_user(&pool, 60, "u1", 1, "u1@example.com", "h")
            .await
            .unwrap();
        create_user(&pool, 61, "u2", 1, "u2@example.com", "h")
            .await
            .unwrap();
        assert_eq!(count_users(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_list_users_paginated() {
        let pool = test_pool().await;
        for i in 0..5 {
            create_user(
                &pool,
                100 + i,
                &format!("user{}", i),
                1,
                &format!("u{}@example.com", i),
                "h",
            )
            .await
            .unwrap();
        }
        let page1 = list_users_paginated(&pool, 0, 3).await.unwrap();
        assert_eq!(page1.len(), 3);
        let page2 = list_users_paginated(&pool, 3, 3).await.unwrap();
        assert_eq!(page2.len(), 2);
    }

    #[tokio::test]
    async fn test_update_user_flags() {
        let pool = test_pool().await;
        create_user(&pool, 70, "flaguser", 1, "flag@example.com", "h")
            .await
            .unwrap();
        let updated = update_user_flags(&pool, 70, 1).await.unwrap();
        assert_eq!(updated.flags, 1);
    }

    #[tokio::test]
    async fn test_update_user_email() {
        let pool = test_pool().await;
        create_user(&pool, 80, "emailuser", 1, "old@example.com", "h")
            .await
            .unwrap();
        let updated = update_user_email(&pool, 80, "new@example.com")
            .await
            .unwrap();
        assert_eq!(updated.email, "new@example.com");
    }

    #[tokio::test]
    async fn test_update_user_public_key() {
        let pool = test_pool().await;
        create_user(&pool, 90, "keyuser", 1, "key@example.com", "h")
            .await
            .unwrap();
        let updated = update_user_public_key(&pool, 90, "abcdef1234567890")
            .await
            .unwrap();
        assert_eq!(updated.public_key.as_deref(), Some("abcdef1234567890"));
    }

    #[tokio::test]
    async fn test_get_user_by_public_key() {
        let pool = test_pool().await;
        create_user(&pool, 91, "pkuser", 1, "pk@example.com", "h")
            .await
            .unwrap();
        update_user_public_key(&pool, 91, "pk_hex_value")
            .await
            .unwrap();
        let user = get_user_by_public_key(&pool, "pk_hex_value")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.id, 91);
    }

    #[tokio::test]
    async fn test_create_user_from_pubkey_as_first_admin_sets_only_first_user_admin() {
        let pool = test_pool().await;
        let first =
            create_user_from_pubkey_as_first_admin(&pool, 92, "aabbccddeeff", "pub-first", None, 1)
                .await
                .unwrap();
        let second = create_user_from_pubkey_as_first_admin(
            &pool,
            93,
            "001122334455",
            "pub-second",
            None,
            1,
        )
        .await
        .unwrap();

        assert_eq!(first.flags & 1, 1);
        assert_eq!(second.flags & 1, 0);
    }

    #[tokio::test]
    async fn test_upsert_user_settings() {
        let pool = test_pool().await;
        create_user(&pool, 95, "settings_u", 1, "s@example.com", "h")
            .await
            .unwrap();
        let settings =
            upsert_user_settings(&pool, 95, "dark", "en-US", "cozy", None, None, None, None)
                .await
                .unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.locale, "en-US");

        // Upsert again to update
        let updated = upsert_user_settings(
            &pool, 95, "light", "en-GB", "compact", None, None, None, None,
        )
        .await
        .unwrap();
        assert_eq!(updated.theme, "light");
    }

    #[tokio::test]
    async fn test_get_user_settings_none_when_not_set() {
        let pool = test_pool().await;
        create_user(&pool, 96, "nosettings", 1, "ns@example.com", "h")
            .await
            .unwrap();
        let settings = get_user_settings(&pool, 96).await.unwrap();
        assert!(settings.is_none());
    }
}
