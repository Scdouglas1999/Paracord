use crate::{
    bool_from_any_row, datetime_from_db_text, datetime_to_db_text, json_from_db_text, DbError,
    DbPool,
};
use chrono::{DateTime, Utc};
use paracord_models::id::UserId;
use sqlx::Row;

const USER_FLAG_BOT: i32 = 1 << 1;
const FEDERATED_PLACEHOLDER_PASSWORD: &str = "!federated!";

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

async fn count_local_human_users_for_first_admin(
    executor: &mut sqlx::AnyConnection,
) -> Result<i64, sqlx::Error> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM users
         WHERE id > 0
           AND (flags & $1) = 0
           AND password_hash != $2",
    )
    .bind(USER_FLAG_BOT)
    .bind(FEDERATED_PLACEHOLDER_PASSWORD)
    .fetch_one(executor)
    .await?;
    Ok(count)
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
    pub email_verified: bool,
}

impl UserRow {
    #[inline]
    pub fn user_id(&self) -> UserId {
        UserId::from(self.id)
    }
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
    pub email_verified: bool,
}

impl UserAuthRow {
    #[inline]
    pub fn user_id(&self) -> UserId {
        UserId::from(self.id)
    }
}

#[derive(Debug, Clone)]
pub struct UserSettingsRow {
    pub user_id: i64,
    pub theme: String,
    pub custom_css: Option<String>,
    pub locale: String,
    pub message_display: String,
    pub crypto_auth_enabled: bool,
    pub presence_status: String,
    pub custom_status: Option<String>,
    pub notifications: serde_json::Value,
    pub keybinds: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

impl UserSettingsRow {
    #[inline]
    pub fn user_id(&self) -> UserId {
        UserId::from(self.user_id)
    }
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
            email_verified: bool_from_any_row(row, "email_verified").unwrap_or(false),
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
            email_verified: bool_from_any_row(row, "email_verified").unwrap_or(false),
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
            presence_status: row
                .try_get("presence_status")
                .unwrap_or_else(|_| "online".to_string()),
            custom_status: row.try_get("custom_status").ok().flatten(),
            notifications: json_from_db_text(&notifications_raw)?,
            keybinds: json_from_db_text(&keybinds_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

/// Raw i64 shim kept for API compat.
pub async fn create_user(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
) -> Result<UserRow, DbError> {
    create_user_typed(
        pool,
        UserId::new(id),
        username,
        discriminator,
        email,
        password_hash,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn create_user_typed(
    pool: &DbPool,
    id: UserId,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
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
/// Raw i64 shim kept for API compat.
pub async fn create_user_as_first_admin(
    pool: &DbPool,
    id: i64,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    create_user_as_first_admin_typed(
        pool,
        UserId::new(id),
        username,
        discriminator,
        email,
        password_hash,
        admin_flag,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn create_user_as_first_admin_typed(
    pool: &DbPool,
    id: UserId,
    username: &str,
    discriminator: i16,
    email: &str,
    password_hash: &str,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let mut tx = pool.begin().await?;
    let count = count_local_human_users_for_first_admin(&mut tx).await?;
    let flags = if count == 0 { admin_flag } else { 0 };

    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, flags)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
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

/// Core implementation using newtype ID.
pub async fn get_user_by_id_typed(pool: &DbPool, id: UserId) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_user_by_id(pool: &DbPool, id: i64) -> Result<Option<UserRow>, DbError> {
    get_user_by_id_typed(pool, UserId::new(id)).await
}

pub async fn get_user_by_email(pool: &DbPool, email: &str) -> Result<Option<UserAuthRow>, DbError> {
    let normalized_email = normalize_email(email);
    let row = match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            sqlx::query_as::<_, UserAuthRow>(
                "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
                 FROM users WHERE lower(email) = $1",
            )
            .bind(normalized_email)
            .fetch_optional(pool)
            .await?
        }
        crate::DatabaseEngine::Sqlite => {
            sqlx::query_as::<_, UserAuthRow>(
                "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
                 FROM users WHERE email = $1 COLLATE NOCASE",
            )
            .bind(normalized_email)
            .fetch_optional(pool)
            .await?
        }
    };
    Ok(row)
}

/// Core implementation using newtype ID.
pub async fn get_user_auth_by_id_typed(
    pool: &DbPool,
    id: UserId,
) -> Result<Option<UserAuthRow>, DbError> {
    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_user_auth_by_id(pool: &DbPool, id: i64) -> Result<Option<UserAuthRow>, DbError> {
    get_user_auth_by_id_typed(pool, UserId::new(id)).await
}

pub async fn get_user_by_username(
    pool: &DbPool,
    username: &str,
    discriminator: i16,
) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
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
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
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
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
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
        "SELECT id, username, discriminator, email, password_hash, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
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

/// Core implementation using newtype ID.
pub async fn update_user_typed(
    pool: &DbPool,
    id: UserId,
    display_name: Option<&str>,
    bio: Option<&str>,
    avatar_hash: Option<&str>,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), avatar_hash = COALESCE($4, avatar_hash), updated_at = $5
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
    )
    .bind(id)
    .bind(display_name)
    .bind(bio)
    .bind(avatar_hash)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_user(
    pool: &DbPool,
    id: i64,
    display_name: Option<&str>,
    bio: Option<&str>,
    avatar_hash: Option<&str>,
) -> Result<UserRow, DbError> {
    update_user_typed(pool, UserId::new(id), display_name, bio, avatar_hash).await
}

/// Core implementation using newtype ID.
pub async fn get_user_settings_typed(
    pool: &DbPool,
    user_id: UserId,
) -> Result<Option<UserSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "SELECT user_id, theme, custom_css, locale, message_display, CASE WHEN crypto_auth_enabled THEN 1 ELSE 0 END AS crypto_auth_enabled, presence_status, custom_status, notifications, keybinds, updated_at
         FROM user_settings WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_user_settings(
    pool: &DbPool,
    user_id: i64,
) -> Result<Option<UserSettingsRow>, DbError> {
    get_user_settings_typed(pool, UserId::new(user_id)).await
}

pub async fn count_users(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

/// Core implementation using newtype ID.
pub async fn update_user_flags_typed(
    pool: &DbPool,
    id: UserId,
    flags: i32,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET flags = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
    )
    .bind(id)
    .bind(flags)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_user_flags(pool: &DbPool, id: i64, flags: i32) -> Result<UserRow, DbError> {
    update_user_flags_typed(pool, UserId::new(id), flags).await
}

pub async fn list_users_paginated(
    pool: &DbPool,
    offset: i64,
    limit: i64,
) -> Result<Vec<UserRow>, DbError> {
    // Legacy offset compatibility for older callers.
    // New code should use `list_users_by_cursor`.
    let after_id = if offset <= 0 {
        None
    } else {
        sqlx::query_as::<_, (i64,)>(
            "SELECT id
             FROM users
             ORDER BY id ASC
             LIMIT 1 OFFSET $1",
        )
        .bind(offset - 1)
        .fetch_optional(pool)
        .await?
        .map(|(id,)| id)
    };

    list_users_by_cursor(pool, after_id, limit).await
}

pub async fn list_users_by_cursor(
    pool: &DbPool,
    after_id: Option<i64>,
    limit: i64,
) -> Result<Vec<UserRow>, DbError> {
    let rows = if let Some(cursor) = after_id {
        sqlx::query_as::<_, UserRow>(
            "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
             FROM users
             WHERE id > $1
             ORDER BY id ASC
             LIMIT $2",
        )
        .bind(cursor)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, UserRow>(
            "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
             FROM users
             ORDER BY id ASC
             LIMIT $1",
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

/// Core implementation using newtype ID.
pub async fn delete_user_typed(pool: &DbPool, id: UserId) -> Result<(), DbError> {
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn delete_user(pool: &DbPool, id: i64) -> Result<(), DbError> {
    delete_user_typed(pool, UserId::new(id)).await
}

#[allow(clippy::too_many_arguments)]
/// Core implementation using newtype ID.
pub async fn upsert_user_settings_typed(
    pool: &DbPool,
    user_id: UserId,
    theme: &str,
    locale: &str,
    message_display: &str,
    custom_css: Option<&str>,
    crypto_auth_enabled: Option<bool>,
    presence_status: Option<&str>,
    custom_status: Option<Option<&str>>,
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
    // custom_status uses a nested Option so callers can distinguish "leave
    // unchanged" (None) from "clear" (Some(None)) vs "set" (Some(Some(...))).
    let clear_custom_status = matches!(custom_status, Some(None));
    let set_custom_status = custom_status.flatten();
    let row = sqlx::query_as::<_, UserSettingsRow>(
        "INSERT INTO user_settings (user_id, theme, locale, message_display, custom_css, crypto_auth_enabled, presence_status, custom_status, notifications, keybinds)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), COALESCE($7, 'online'), $8, COALESCE($9, '{}'), COALESCE($10, '{}'))
         ON CONFLICT (user_id) DO UPDATE SET
            theme = $2,
            locale = $3,
            message_display = $4,
            custom_css = $5,
            crypto_auth_enabled = COALESCE($6, user_settings.crypto_auth_enabled),
            presence_status = COALESCE($7, user_settings.presence_status),
            custom_status = CASE
                WHEN $11 THEN NULL
                WHEN $8 IS NOT NULL THEN $8
                ELSE user_settings.custom_status
            END,
            notifications = COALESCE($9, user_settings.notifications),
            keybinds = COALESCE($10, user_settings.keybinds),
            updated_at = $12
         RETURNING user_id, theme, custom_css, locale, message_display, CASE WHEN crypto_auth_enabled THEN 1 ELSE 0 END AS crypto_auth_enabled, presence_status, custom_status, notifications, keybinds, updated_at",
    )
    .bind(user_id)
    .bind(theme)
    .bind(locale)
    .bind(message_display)
    .bind(custom_css)
    .bind(crypto_auth_enabled)
    .bind(presence_status)
    .bind(set_custom_status)
    .bind(notifications)
    .bind(keybinds)
    .bind(clear_custom_status)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
/// Raw i64 shim kept for API compat.
pub async fn upsert_user_settings(
    pool: &DbPool,
    user_id: i64,
    theme: &str,
    locale: &str,
    message_display: &str,
    custom_css: Option<&str>,
    crypto_auth_enabled: Option<bool>,
    presence_status: Option<&str>,
    custom_status: Option<Option<&str>>,
    notifications: Option<&serde_json::Value>,
    keybinds: Option<&serde_json::Value>,
) -> Result<UserSettingsRow, DbError> {
    upsert_user_settings_typed(
        pool,
        UserId::new(user_id),
        theme,
        locale,
        message_display,
        custom_css,
        crypto_auth_enabled,
        presence_status,
        custom_status,
        notifications,
        keybinds,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn update_user_public_key_typed(
    pool: &DbPool,
    id: UserId,
    public_key: &str,
) -> Result<UserRow, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET public_key = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
    )
    .bind(id)
    .bind(public_key)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_user_public_key(
    pool: &DbPool,
    id: i64,
    public_key: &str,
) -> Result<UserRow, DbError> {
    update_user_public_key_typed(pool, UserId::new(id), public_key).await
}

/// Core implementation using newtype ID.
pub async fn update_user_password_hash_typed(
    pool: &DbPool,
    id: UserId,
    password_hash: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE users
         SET password_hash = $2, updated_at = $3
         WHERE id = $1",
    )
    .bind(id)
    .bind(password_hash)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn update_user_password_hash(
    pool: &DbPool,
    id: i64,
    password_hash: &str,
) -> Result<(), DbError> {
    update_user_password_hash_typed(pool, UserId::new(id), password_hash).await
}

/// Core implementation using newtype ID.
pub async fn update_user_email_typed(
    pool: &DbPool,
    id: UserId,
    email: &str,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users
         SET email = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
    )
    .bind(id)
    .bind(normalized_email)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_user_email(pool: &DbPool, id: i64, email: &str) -> Result<UserRow, DbError> {
    update_user_email_typed(pool, UserId::new(id), email).await
}

/// Update a user's email and mark it unverified in a single statement.
///
/// Used when a user changes their email address: the new address has not been
/// proven to belong to the account, so `email_verified` must be reset to false.
/// Core implementation using newtype ID.
pub async fn update_user_email_unverified_typed(
    pool: &DbPool,
    id: UserId,
    email: &str,
) -> Result<UserRow, DbError> {
    let normalized_email = normalize_email(email);
    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users
         SET email = $2, email_verified = $3, updated_at = $4
         WHERE id = $1
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
    )
    .bind(id)
    .bind(normalized_email)
    .bind(false)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_user_email_unverified(
    pool: &DbPool,
    id: i64,
    email: &str,
) -> Result<UserRow, DbError> {
    update_user_email_unverified_typed(pool, UserId::new(id), email).await
}

pub async fn get_user_by_public_key(
    pool: &DbPool,
    public_key: &str,
) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
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

/// Core implementation using newtype IDs.
pub async fn get_mutual_guilds_typed(
    pool: &DbPool,
    user_a: UserId,
    user_b: UserId,
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

/// Raw i64 shim kept for API compat.
pub async fn get_mutual_guilds(
    pool: &DbPool,
    user_a: i64,
    user_b: i64,
) -> Result<Vec<MutualGuildRow>, DbError> {
    get_mutual_guilds_typed(pool, UserId::new(user_a), UserId::new(user_b)).await
}

/// Core implementation using newtype IDs.
pub async fn get_mutual_friends_typed(
    pool: &DbPool,
    user_a: UserId,
    user_b: UserId,
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

/// Raw i64 shim kept for API compat.
pub async fn get_mutual_friends(
    pool: &DbPool,
    user_a: i64,
    user_b: i64,
) -> Result<Vec<MutualFriendRow>, DbError> {
    get_mutual_friends_typed(pool, UserId::new(user_a), UserId::new(user_b)).await
}

pub async fn create_user_from_pubkey(
    pool: &DbPool,
    id: i64,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
) -> Result<UserRow, DbError> {
    create_user_from_pubkey_typed(pool, UserId::new(id), public_key, username, display_name).await
}

/// Core implementation using newtype ID.
pub async fn create_user_from_pubkey_typed(
    pool: &DbPool,
    id: UserId,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
) -> Result<UserRow, DbError> {
    let placeholder_email = format!("{}@pubkey", public_key);
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, display_name, public_key)
         VALUES ($1, $2, 0, $3, '', $4, $5)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
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
/// Raw i64 shim kept for API compat.
pub async fn create_user_from_pubkey_as_first_admin(
    pool: &DbPool,
    id: i64,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    create_user_from_pubkey_as_first_admin_typed(
        pool,
        UserId::new(id),
        public_key,
        username,
        display_name,
        admin_flag,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn create_user_from_pubkey_as_first_admin_typed(
    pool: &DbPool,
    id: UserId,
    public_key: &str,
    username: &str,
    display_name: Option<&str>,
    admin_flag: i32,
) -> Result<UserRow, DbError> {
    let mut tx = pool.begin().await?;
    let count = count_local_human_users_for_first_admin(&mut tx).await?;
    let flags = if count == 0 { admin_flag } else { 0 };
    let placeholder_email = format!("{}@pubkey", public_key);

    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (id, username, discriminator, email, password_hash, display_name, public_key, flags)
         VALUES ($1, $2, 0, $3, '', $4, $5, $6)
         RETURNING id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified",
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

/// Core implementation using newtype ID.
pub async fn set_email_verified_typed(
    pool: &DbPool,
    user_id: UserId,
    verified: bool,
) -> Result<(), DbError> {
    sqlx::query("UPDATE users SET email_verified = $2, updated_at = $3 WHERE id = $1")
        .bind(user_id)
        .bind(verified)
        .bind(datetime_to_db_text(Utc::now()))
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn set_email_verified(
    pool: &DbPool,
    user_id: i64,
    verified: bool,
) -> Result<(), DbError> {
    set_email_verified_typed(pool, UserId::new(user_id), verified).await
}

/// Core implementation using newtype ID.
pub async fn create_email_verification_token_typed(
    pool: &DbPool,
    user_id: UserId,
    token_hash: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), DbError> {
    let expires_str = expires_at.format("%Y-%m-%d %H:%M:%S").to_string();
    sqlx::query(
        "INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)",
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(expires_str)
    .execute(pool)
    .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn create_email_verification_token(
    pool: &DbPool,
    user_id: i64,
    token_hash: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), DbError> {
    create_email_verification_token_typed(pool, UserId::new(user_id), token_hash, expires_at).await
}

pub async fn get_email_verification_token(
    pool: &DbPool,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<Option<EmailVerificationTokenRow>, DbError> {
    let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let row = sqlx::query_as::<_, EmailVerificationTokenRow>(
        "SELECT token_hash, user_id, expires_at, created_at
         FROM email_verification_tokens
         WHERE token_hash = $1
           AND expires_at > $2",
    )
    .bind(token_hash)
    .bind(now_str)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Core implementation using newtype ID.
pub async fn delete_email_verification_tokens_for_user_typed(
    pool: &DbPool,
    user_id: UserId,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM email_verification_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn delete_email_verification_tokens_for_user(
    pool: &DbPool,
    user_id: i64,
) -> Result<(), DbError> {
    delete_email_verification_tokens_for_user_typed(pool, UserId::new(user_id)).await
}

#[derive(Debug, Clone)]
pub struct EmailVerificationTokenRow {
    pub token_hash: String,
    pub user_id: i64,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for EmailVerificationTokenRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let expires_at_raw: String = row.try_get("expires_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            token_hash: row.try_get("token_hash")?,
            user_id: row.try_get("user_id")?,
            expires_at: datetime_from_db_text(&expires_at_raw)?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
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
        let user = create_user_typed(
            &pool,
            UserId::new(1),
            "testuser",
            1,
            "test@example.com",
            "hashed_pw",
        )
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
        let first = create_user_as_first_admin_typed(
            &pool,
            UserId::new(2),
            "first",
            1,
            "first@example.com",
            "hash",
            1,
        )
        .await
        .unwrap();
        let second = create_user_as_first_admin_typed(
            &pool,
            UserId::new(3),
            "second",
            1,
            "second@example.com",
            "hash",
            1,
        )
        .await
        .unwrap();

        assert_eq!(first.flags & 1, 1);
        assert_eq!(second.flags & 1, 0);
    }

    #[tokio::test]
    async fn test_create_user_as_first_admin_ignores_system_bots() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(-1),
            "Welcome Bot",
            0,
            "welcome@paracord.internal",
            "",
        )
        .await
        .unwrap();
        update_user_flags_typed(&pool, UserId::new(-1), USER_FLAG_BOT)
            .await
            .unwrap();

        let first_human = create_user_as_first_admin_typed(
            &pool,
            UserId::new(4),
            "first-human",
            1,
            "first-human@example.com",
            "hash",
            1,
        )
        .await
        .unwrap();

        assert_eq!(first_human.flags & 1, 1);
    }

    #[tokio::test]
    async fn test_create_user_duplicate_email_fails() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(1),
            "user1",
            1,
            "dup@example.com",
            "hash1",
        )
        .await
        .unwrap();
        let result = create_user_typed(
            &pool,
            UserId::new(2),
            "user2",
            2,
            "dup@example.com",
            "hash2",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_user_duplicate_email_case_insensitive_fails() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(1),
            "user1",
            1,
            "Case@Test.Example",
            "hash1",
        )
        .await
        .unwrap();
        let result = create_user_typed(
            &pool,
            UserId::new(2),
            "user2",
            2,
            "case@test.example",
            "hash2",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_user_by_id() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(10),
            "alice",
            1,
            "alice@example.com",
            "hash",
        )
        .await
        .unwrap();
        let user = get_user_by_id_typed(&pool, UserId::new(10))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.username, "alice");
    }

    #[tokio::test]
    async fn test_get_user_by_id_not_found() {
        let pool = test_pool().await;
        let user = get_user_by_id_typed(&pool, UserId::new(999)).await.unwrap();
        assert!(user.is_none());
    }

    #[tokio::test]
    async fn test_get_user_by_email() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(20),
            "bob",
            1,
            "bob@example.com",
            "secret_hash",
        )
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
        create_user_typed(
            &pool,
            UserId::new(21),
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
        create_user_typed(
            &pool,
            UserId::new(30),
            "carol",
            5,
            "carol@example.com",
            "hash",
        )
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
        create_user_typed(
            &pool,
            UserId::new(31),
            "dave",
            1,
            "dave@example.com",
            "hash",
        )
        .await
        .unwrap();
        let result = get_user_by_username(&pool, "dave", 9999).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_update_user() {
        let pool = test_pool().await;
        create_user_typed(&pool, UserId::new(40), "eve", 1, "eve@example.com", "hash")
            .await
            .unwrap();
        let updated = update_user_typed(
            &pool,
            UserId::new(40),
            Some("Eve Display"),
            Some("Hello!"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.display_name.as_deref(), Some("Eve Display"));
        assert_eq!(updated.bio.as_deref(), Some("Hello!"));
    }

    #[tokio::test]
    async fn test_update_user_partial_fields() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(41),
            "frank",
            1,
            "frank@example.com",
            "hash",
        )
        .await
        .unwrap();
        update_user_typed(&pool, UserId::new(41), Some("Frank"), None, None)
            .await
            .unwrap();
        let user = get_user_by_id_typed(&pool, UserId::new(41))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.display_name.as_deref(), Some("Frank"));
        assert!(user.bio.is_none());
    }

    #[tokio::test]
    async fn test_delete_user() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(50),
            "deleteme",
            1,
            "del@example.com",
            "hash",
        )
        .await
        .unwrap();
        delete_user_typed(&pool, UserId::new(50)).await.unwrap();
        let user = get_user_by_id_typed(&pool, UserId::new(50)).await.unwrap();
        assert!(user.is_none());
    }

    #[tokio::test]
    async fn test_count_users() {
        let pool = test_pool().await;
        assert_eq!(count_users(&pool).await.unwrap(), 0);
        create_user_typed(&pool, UserId::new(60), "u1", 1, "u1@example.com", "h")
            .await
            .unwrap();
        create_user_typed(&pool, UserId::new(61), "u2", 1, "u2@example.com", "h")
            .await
            .unwrap();
        assert_eq!(count_users(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_list_users_paginated() {
        let pool = test_pool().await;
        for i in 0..5 {
            create_user_typed(
                &pool,
                UserId::new(100 + i),
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
    async fn test_list_users_by_cursor() {
        let pool = test_pool().await;
        for i in 0..5 {
            create_user_typed(
                &pool,
                UserId::new(200 + i),
                &format!("cursor_user{}", i),
                1,
                &format!("cursor{}@example.com", i),
                "h",
            )
            .await
            .unwrap();
        }

        let first_page = list_users_by_cursor(&pool, None, 2).await.unwrap();
        assert_eq!(first_page.len(), 2);
        assert_eq!(first_page[0].id, 200);
        assert_eq!(first_page[1].id, 201);

        let second_page = list_users_by_cursor(&pool, Some(first_page[1].id), 2)
            .await
            .unwrap();
        assert_eq!(second_page.len(), 2);
        assert_eq!(second_page[0].id, 202);
        assert_eq!(second_page[1].id, 203);
    }

    #[tokio::test]
    async fn test_update_user_flags() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(70),
            "flaguser",
            1,
            "flag@example.com",
            "h",
        )
        .await
        .unwrap();
        let updated = update_user_flags_typed(&pool, UserId::new(70), 1)
            .await
            .unwrap();
        assert_eq!(updated.flags, 1);
    }

    #[tokio::test]
    async fn test_update_user_email() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(80),
            "emailuser",
            1,
            "old@example.com",
            "h",
        )
        .await
        .unwrap();
        let updated = update_user_email_typed(&pool, UserId::new(80), "new@example.com")
            .await
            .unwrap();
        assert_eq!(updated.email, "new@example.com");
    }

    #[tokio::test]
    async fn test_update_user_email_unverified_clears_verified() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(81),
            "verifieduser",
            1,
            "old2@example.com",
            "h",
        )
        .await
        .unwrap();
        set_email_verified_typed(&pool, UserId::new(81), true)
            .await
            .unwrap();
        let before = get_user_by_id_typed(&pool, UserId::new(81))
            .await
            .unwrap()
            .unwrap();
        assert!(before.email_verified);

        let updated =
            update_user_email_unverified_typed(&pool, UserId::new(81), "New2@Example.com")
                .await
                .unwrap();
        assert_eq!(updated.email, "new2@example.com");
        assert!(
            !updated.email_verified,
            "email_verified must be cleared after email change"
        );
    }

    #[tokio::test]
    async fn test_update_user_public_key() {
        let pool = test_pool().await;
        create_user_typed(&pool, UserId::new(90), "keyuser", 1, "key@example.com", "h")
            .await
            .unwrap();
        let updated = update_user_public_key_typed(&pool, UserId::new(90), "abcdef1234567890")
            .await
            .unwrap();
        assert_eq!(updated.public_key.as_deref(), Some("abcdef1234567890"));
    }

    #[tokio::test]
    async fn test_get_user_by_public_key() {
        let pool = test_pool().await;
        create_user_typed(&pool, UserId::new(91), "pkuser", 1, "pk@example.com", "h")
            .await
            .unwrap();
        update_user_public_key_typed(&pool, UserId::new(91), "pk_hex_value")
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
        let first = create_user_from_pubkey_as_first_admin_typed(
            &pool,
            UserId::new(92),
            "aabbccddeeff",
            "pub-first",
            None,
            1,
        )
        .await
        .unwrap();
        let second = create_user_from_pubkey_as_first_admin_typed(
            &pool,
            UserId::new(93),
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
        create_user_typed(
            &pool,
            UserId::new(95),
            "settings_u",
            1,
            "s@example.com",
            "h",
        )
        .await
        .unwrap();
        let settings = upsert_user_settings_typed(
            &pool,
            UserId::new(95),
            "dark",
            "en-US",
            "cozy",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.locale, "en-US");
        assert_eq!(settings.presence_status, "online");

        // Upsert again to update
        let updated = upsert_user_settings_typed(
            &pool,
            UserId::new(95),
            "light",
            "en-GB",
            "compact",
            None,
            None,
            Some("dnd"),
            Some(Some("focusing")),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.theme, "light");
        assert_eq!(updated.presence_status, "dnd");
        assert_eq!(updated.custom_status.as_deref(), Some("focusing"));
    }

    #[tokio::test]
    async fn test_get_user_settings_none_when_not_set() {
        let pool = test_pool().await;
        create_user_typed(
            &pool,
            UserId::new(96),
            "nosettings",
            1,
            "ns@example.com",
            "h",
        )
        .await
        .unwrap();
        let settings = get_user_settings_typed(&pool, UserId::new(96))
            .await
            .unwrap();
        assert!(settings.is_none());
    }
}
