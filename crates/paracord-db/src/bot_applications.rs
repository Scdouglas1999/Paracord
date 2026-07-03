use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
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
    pub scopes: Option<String>,
    pub intents: i64,
    pub public_listed: bool,
    pub category: Option<String>,
    pub tags: Option<String>,
    pub icon_hash: Option<String>,
    pub install_count: i64,
    pub revoked: bool,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A row returned by store listing queries (includes store-specific columns).
#[derive(Debug, Clone)]
pub struct BotStoreRow {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub bot_user_id: i64,
    pub permissions: i64,
    pub category: Option<String>,
    pub tags: Option<String>,
    pub icon_hash: Option<String>,
    pub install_count: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BotStoreRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            bot_user_id: row.try_get("bot_user_id")?,
            permissions: row.try_get("permissions")?,
            category: row.try_get("category").ok().flatten(),
            tags: row.try_get("tags").ok().flatten(),
            icon_hash: row.try_get("icon_hash").ok().flatten(),
            install_count: row.try_get("install_count").unwrap_or(0),
        })
    }
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
        let last_used_at_raw: Option<String> = row.try_get("last_used_at").ok().flatten();
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            owner_id: row.try_get("owner_id")?,
            bot_user_id: row.try_get("bot_user_id")?,
            token_hash: row.try_get("token_hash")?,
            redirect_uri: row.try_get("redirect_uri")?,
            permissions: row.try_get("permissions")?,
            scopes: row.try_get("scopes").ok().flatten(),
            intents: row.try_get("intents").unwrap_or(0),
            public_listed: bool_from_any_row(row, "public_listed").unwrap_or(false),
            category: row.try_get("category").ok().flatten(),
            tags: row.try_get("tags").ok().flatten(),
            icon_hash: row.try_get("icon_hash").ok().flatten(),
            install_count: row.try_get("install_count").unwrap_or(0),
            revoked: bool_from_any_row(row, "revoked").unwrap_or(false),
            last_used_at: last_used_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
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

pub fn verify_token_hash(token: &str, stored_hash: &str) -> bool {
    let computed = hash_token(token);
    if computed.len() != stored_hash.len() {
        return false;
    }

    // Constant-time compare to avoid leaking token validity via timing.
    let mut diff = 0u8;
    for (a, b) in computed
        .as_bytes()
        .iter()
        .zip(stored_hash.as_bytes().iter())
    {
        diff |= a ^ b;
    }
    diff == 0
}

const BOT_APP_SELECT_COLS: &str = "id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions, scopes, intents, public_listed, category, tags, icon_hash, install_count, revoked, last_used_at, created_at, updated_at";

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
    let sql = format!(
        "INSERT INTO bot_applications (id, name, description, owner_id, bot_user_id, token_hash, redirect_uri, permissions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING {BOT_APP_SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
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
    let sql = format!("SELECT {BOT_APP_SELECT_COLS} FROM bot_applications WHERE id = $1");
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn get_bot_application_by_token_hash(
    pool: &DbPool,
    token_hash: &str,
) -> Result<Option<BotApplicationRow>, DbError> {
    let sql = format!("SELECT {BOT_APP_SELECT_COLS} FROM bot_applications WHERE token_hash = $1");
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(token_hash)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn list_user_bot_applications(
    pool: &DbPool,
    owner_id: i64,
) -> Result<Vec<BotApplicationRow>, DbError> {
    let sql = format!(
        "SELECT {BOT_APP_SELECT_COLS} FROM bot_applications WHERE owner_id = $1 ORDER BY created_at"
    );
    let rows = sqlx::query_as::<_, BotApplicationRow>(&sql)
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
    permissions: Option<i64>,
    intents: Option<i64>,
) -> Result<BotApplicationRow, DbError> {
    let sql = format!(
        "UPDATE bot_applications SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            redirect_uri = COALESCE($4, redirect_uri),
            permissions = COALESCE($5, permissions),
            intents = COALESCE($6, intents),
            updated_at = $7
         WHERE id = $1
         RETURNING {BOT_APP_SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(id)
        .bind(name)
        .bind(description)
        .bind(redirect_uri)
        .bind(permissions)
        .bind(intents)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn get_bot_application_by_user_id(
    pool: &DbPool,
    bot_user_id: i64,
) -> Result<Option<BotApplicationRow>, DbError> {
    let sql = format!("SELECT {BOT_APP_SELECT_COLS} FROM bot_applications WHERE bot_user_id = $1");
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(bot_user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn regenerate_bot_token(
    pool: &DbPool,
    id: i64,
    new_token_hash: &str,
) -> Result<BotApplicationRow, DbError> {
    // Rotating the token re-activates the application and clears the old
    // last-used marker so lockout/telemetry start fresh for the new secret.
    let sql = format!(
        "UPDATE bot_applications
         SET token_hash = $2, revoked = FALSE, last_used_at = NULL, updated_at = $3
         WHERE id = $1
         RETURNING {BOT_APP_SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(id)
        .bind(new_token_hash)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
    Ok(row)
}

/// Mark a bot application's token as revoked (or re-enable it). A revoked token
/// is rejected by bot authentication until the token is regenerated.
pub async fn set_bot_application_revoked(
    pool: &DbPool,
    id: i64,
    revoked: bool,
) -> Result<BotApplicationRow, DbError> {
    let sql = format!(
        "UPDATE bot_applications SET revoked = $2, updated_at = $3
         WHERE id = $1
         RETURNING {BOT_APP_SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, BotApplicationRow>(&sql)
        .bind(id)
        .bind(revoked)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
    Ok(row)
}

/// Best-effort update of a bot application's `last_used_at` timestamp. Called on
/// every successful bot authentication; failures are non-fatal to the request.
pub async fn touch_bot_last_used(
    pool: &DbPool,
    id: i64,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE bot_applications SET last_used_at = $2 WHERE id = $1")
        .bind(id)
        .bind(datetime_to_db_text(now))
        .execute(pool)
        .await?;
    Ok(())
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
    sqlx::query(
        "UPDATE bot_applications
         SET install_count = (
            SELECT COUNT(*) FROM bot_guild_installs WHERE bot_app_id = $1
         ),
             updated_at = $2
         WHERE id = $1",
    )
    .bind(bot_app_id)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
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
    sqlx::query(
        "UPDATE bot_applications
         SET install_count = (
            SELECT COUNT(*) FROM bot_guild_installs WHERE bot_app_id = $1
         ),
             updated_at = $2
         WHERE id = $1",
    )
    .bind(bot_app_id)
    .bind(datetime_to_db_text(Utc::now()))
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

/// Get a bot's install permissions for a guild, looking up by bot_user_id.
/// Returns `None` if the bot is not installed in the guild.
pub async fn get_bot_install_permissions_by_user(
    pool: &DbPool,
    bot_user_id: i64,
    guild_id: i64,
) -> Result<Option<i64>, DbError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT bgi.permissions FROM bot_guild_installs bgi
         JOIN bot_applications ba ON ba.id = bgi.bot_app_id
         WHERE ba.bot_user_id = $1 AND bgi.guild_id = $2",
    )
    .bind(bot_user_id)
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(p,)| p))
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

// --- Bot store queries ---

/// List publicly listed bots with optional search and category filter.
pub async fn list_store_bots(
    pool: &DbPool,
    query: Option<&str>,
    category: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<(Vec<BotStoreRow>, i64), DbError> {
    let q = query.map(|s| s.trim()).filter(|s| !s.is_empty());
    let cat = category.map(|s| s.trim()).filter(|s| !s.is_empty());

    // Use four fixed SQL variants to avoid dynamic binding complexity.
    match (q, cat) {
        (None, None) => {
            let (total,) = sqlx::query_as::<_, (i64,)>(
                "SELECT COUNT(*) FROM bot_applications WHERE public_listed = TRUE",
            )
            .fetch_one(pool)
            .await?;
            let rows = sqlx::query_as::<_, BotStoreRow>(
                "SELECT id, name, description, bot_user_id, permissions, category, tags, icon_hash, install_count \
                 FROM bot_applications WHERE public_listed = TRUE \
                 ORDER BY install_count DESC, id ASC LIMIT $1 OFFSET $2",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await?;
            Ok((rows, total))
        }
        (Some(q), None) => {
            let pattern = format!("%{q}%");
            let (total,) = sqlx::query_as::<_, (i64,)>(
                "SELECT COUNT(*) FROM bot_applications \
                 WHERE public_listed = TRUE AND (name LIKE $1 OR description LIKE $1)",
            )
            .bind(&pattern)
            .fetch_one(pool)
            .await?;
            let rows = sqlx::query_as::<_, BotStoreRow>(
                "SELECT id, name, description, bot_user_id, permissions, category, tags, icon_hash, install_count \
                 FROM bot_applications WHERE public_listed = TRUE AND (name LIKE $3 OR description LIKE $3) \
                 ORDER BY install_count DESC, id ASC LIMIT $1 OFFSET $2",
            )
            .bind(limit)
            .bind(offset)
            .bind(&pattern)
            .fetch_all(pool)
            .await?;
            Ok((rows, total))
        }
        (None, Some(cat)) => {
            let (total,) = sqlx::query_as::<_, (i64,)>(
                "SELECT COUNT(*) FROM bot_applications WHERE public_listed = TRUE AND category = $1",
            )
            .bind(cat)
            .fetch_one(pool)
            .await?;
            let rows = sqlx::query_as::<_, BotStoreRow>(
                "SELECT id, name, description, bot_user_id, permissions, category, tags, icon_hash, install_count \
                 FROM bot_applications WHERE public_listed = TRUE AND category = $3 \
                 ORDER BY install_count DESC, id ASC LIMIT $1 OFFSET $2",
            )
            .bind(limit)
            .bind(offset)
            .bind(cat)
            .fetch_all(pool)
            .await?;
            Ok((rows, total))
        }
        (Some(q), Some(cat)) => {
            let pattern = format!("%{q}%");
            let (total,) = sqlx::query_as::<_, (i64,)>(
                "SELECT COUNT(*) FROM bot_applications \
                 WHERE public_listed = TRUE AND (name LIKE $1 OR description LIKE $1) AND category = $2",
            )
            .bind(&pattern)
            .bind(cat)
            .fetch_one(pool)
            .await?;
            let rows = sqlx::query_as::<_, BotStoreRow>(
                "SELECT id, name, description, bot_user_id, permissions, category, tags, icon_hash, install_count \
                 FROM bot_applications WHERE public_listed = TRUE \
                 AND (name LIKE $3 OR description LIKE $3) AND category = $4 \
                 ORDER BY install_count DESC, id ASC LIMIT $1 OFFSET $2",
            )
            .bind(limit)
            .bind(offset)
            .bind(&pattern)
            .bind(cat)
            .fetch_all(pool)
            .await?;
            Ok((rows, total))
        }
    }
}

/// Batch-load owner verification signals (email-verified flag and account
/// flags) keyed by bot application id. Lets store listings compute
/// `verified_developer` for a whole page in one query instead of per row.
/// Apps whose owner is missing are simply absent from the map.
pub async fn get_owner_verification_by_app_ids(
    pool: &DbPool,
    app_ids: &[i64],
) -> Result<std::collections::HashMap<i64, (bool, i32)>, DbError> {
    if app_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = crate::messages::build_placeholders(1, app_ids.len());
    let sql = format!(
        "SELECT ba.id AS app_id, u.email_verified AS email_verified, u.flags AS flags \
         FROM bot_applications ba JOIN users u ON u.id = ba.owner_id \
         WHERE ba.id IN ({placeholders})"
    );
    let mut query = sqlx::query(&sql);
    for id in app_ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(pool).await?;
    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let app_id: i64 = row.try_get("app_id")?;
        let email_verified = bool_from_any_row(&row, "email_verified").unwrap_or(false);
        let flags: i32 = row.try_get("flags").unwrap_or(0);
        map.insert(app_id, (email_verified, flags));
    }
    Ok(map)
}

/// Get the top featured (most installed) publicly listed bots.
pub async fn list_featured_bots(pool: &DbPool, limit: i64) -> Result<Vec<BotStoreRow>, DbError> {
    let rows = sqlx::query_as::<_, BotStoreRow>(
        "SELECT id, name, description, bot_user_id, permissions, category, tags, icon_hash, install_count \
         FROM bot_applications WHERE public_listed = TRUE \
         ORDER BY install_count DESC, id ASC \
         LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Get the distinct categories from publicly listed bots.
pub async fn list_store_categories(pool: &DbPool) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT category FROM bot_applications \
         WHERE public_listed = TRUE AND category IS NOT NULL AND category != '' \
         ORDER BY category ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}
