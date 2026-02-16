use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct BotApplicationRow {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: i64,
    pub bot_user_id: i64,
    pub token_hash: String,
    pub redirect_uri: Option<String>,
    pub permissions: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct BotGuildInstallRow {
    pub bot_app_id: i64,
    pub guild_id: i64,
    pub added_by: Option<i64>,
    pub permissions: i64,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BotApplicationRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            owner_id: row.try_get("owner_id")?,
            bot_user_id: row.try_get("bot_user_id")?,
            token_hash: row.try_get("token_hash")?,
            redirect_uri: row.try_get("redirect_uri")?,
            permissions: row.try_get("permissions")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BotGuildInstallRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            bot_app_id: row.try_get("bot_app_id")?,
            guild_id: row.try_get("guild_id")?,
            added_by: row.try_get("added_by")?,
            permissions: row.try_get("permissions")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub async fn create_bot_application(
    pool: &DbPool,
    id: i64,
    name: &str,
    description: Option<&str>,
    owner_id: i64,
    bot_user_id: i64,
    token_hash: &str,
    redirect_uri: Option<&str>,
    permissions: i64,
) -> Result<BotApplicationRow, DbError> {
    let row = sqlx::query_as::<_, BotApplicationRow>(
        "INSERT INTO bot_applications (id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at",
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(owner_id)
    .bind(bot_user_id)
    .bind(token_hash)
    .bind(redirect_uri)
    .bind(permissions)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_bot_application(
    pool: &DbPool,
    id: i64,
) -> Result<Option<BotApplicationRow>, DbError> {
    let row = sqlx::query_as::<_, BotApplicationRow>(
        "SELECT id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at
         FROM bot_applications WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_bot_application_by_token_hash(
    pool: &DbPool,
    token_hash: &str,
) -> Result<Option<BotApplicationRow>, DbError> {
    let row = sqlx::query_as::<_, BotApplicationRow>(
        "SELECT id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at
         FROM bot_applications WHERE token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn list_user_bot_applications(
    pool: &DbPool,
    owner_id: i64,
) -> Result<Vec<BotApplicationRow>, DbError> {
    let rows = sqlx::query_as::<_, BotApplicationRow>(
        "SELECT id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at
         FROM bot_applications WHERE owner_id = $1 ORDER BY created_at",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_bot_application(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    redirect_uri: Option<&str>,
) -> Result<BotApplicationRow, DbError> {
    let row = sqlx::query_as::<_, BotApplicationRow>(
        "UPDATE bot_applications SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            redirect_uri = COALESCE($4, redirect_uri),
            updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at",
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(redirect_uri)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn regenerate_bot_token(
    pool: &DbPool,
    id: i64,
    new_token_hash: &str,
) -> Result<BotApplicationRow, DbError> {
    let row = sqlx::query_as::<_, BotApplicationRow>(
        "UPDATE bot_applications SET token_hash = $2, updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, created_at, updated_at",
    )
    .bind(id)
    .bind(new_token_hash)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_bot_application(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM bot_applications WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- Guild installs ---

pub async fn add_bot_to_guild(
    pool: &DbPool,
    bot_app_id: i64,
    guild_id: i64,
    added_by: i64,
    permissions: i64,
) -> Result<BotGuildInstallRow, DbError> {
    let row = sqlx::query_as::<_, BotGuildInstallRow>(
        "INSERT INTO bot_guild_installs (bot_app_id, guild_id, added_by, permissions)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bot_app_id, guild_id) DO UPDATE SET permissions = $4
         RETURNING bot_app_id, guild_id, added_by, permissions, created_at",
    )
    .bind(bot_app_id)
    .bind(guild_id)
    .bind(added_by)
    .bind(permissions)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn remove_bot_from_guild(
    pool: &DbPool,
    bot_app_id: i64,
    guild_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM bot_guild_installs WHERE bot_app_id = $1 AND guild_id = $2")
        .bind(bot_app_id)
        .bind(guild_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_bot_guild_installs(
    pool: &DbPool,
    bot_app_id: i64,
) -> Result<Vec<BotGuildInstallRow>, DbError> {
    let rows = sqlx::query_as::<_, BotGuildInstallRow>(
        "SELECT bot_app_id, guild_id, added_by, permissions, created_at
         FROM bot_guild_installs WHERE bot_app_id = $1 ORDER BY created_at",
    )
    .bind(bot_app_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_guild_bots(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<BotGuildInstallRow>, DbError> {
    let rows = sqlx::query_as::<_, BotGuildInstallRow>(
        "SELECT bot_app_id, guild_id, added_by, permissions, created_at
         FROM bot_guild_installs WHERE guild_id = $1 ORDER BY created_at",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn is_bot_in_guild(
    pool: &DbPool,
    bot_app_id: i64,
    guild_id: i64,
) -> Result<bool, DbError> {
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM bot_guild_installs WHERE bot_app_id = $1 AND guild_id = $2",
    )
    .bind(bot_app_id)
    .bind(guild_id)
    .fetch_one(pool)
    .await?;
    Ok(count.0 > 0)
}
