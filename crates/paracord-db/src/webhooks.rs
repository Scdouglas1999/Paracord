use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct WebhookRow {
    pub id: i64,
    pub space_id: i64,
    pub channel_id: i64,
    pub creator_id: Option<i64>,
    pub name: String,
    pub token: String,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for WebhookRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            space_id: row.try_get("space_id")?,
            channel_id: row.try_get("channel_id")?,
            creator_id: row.try_get("creator_id")?,
            name: row.try_get("name")?,
            token: row.try_get("token")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_token_hash(token: &str) -> String {
    let trimmed = token.trim();
    if is_hex_sha256(trimmed) {
        trimmed.to_ascii_lowercase()
    } else {
        sha256_hex(trimmed)
    }
}

pub async fn create_webhook(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    channel_id: i64,
    name: &str,
    token: &str,
    creator_id: i64,
) -> Result<WebhookRow, DbError> {
    let token_hash = normalize_token_hash(token);
    let row = sqlx::query_as::<_, WebhookRow>(
        "INSERT INTO webhooks (id, space_id, channel_id, name, token, creator_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, space_id, channel_id, creator_id, name, token, created_at",
    )
    .bind(id)
    .bind(space_id)
    .bind(channel_id)
    .bind(name)
    .bind(token_hash)
    .bind(creator_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_webhook(pool: &DbPool, id: i64) -> Result<Option<WebhookRow>, DbError> {
    let row = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, created_at
         FROM webhooks WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_webhook_by_id_and_token(
    pool: &DbPool,
    id: i64,
    token: &str,
) -> Result<Option<WebhookRow>, DbError> {
    let token_hash = normalize_token_hash(token);
    let row = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, created_at
         FROM webhooks WHERE id = $1 AND (token = $2 OR token = $3)",
    )
    .bind(id)
    .bind(token_hash)
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_channel_webhooks(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<WebhookRow>, DbError> {
    let rows = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, created_at
         FROM webhooks WHERE channel_id = $1 ORDER BY created_at",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_guild_webhooks(pool: &DbPool, space_id: i64) -> Result<Vec<WebhookRow>, DbError> {
    let rows = sqlx::query_as::<_, WebhookRow>(
        "SELECT id, space_id, channel_id, creator_id, name, token, created_at
         FROM webhooks WHERE space_id = $1 ORDER BY created_at",
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_webhook(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
) -> Result<WebhookRow, DbError> {
    let row = sqlx::query_as::<_, WebhookRow>(
        "UPDATE webhooks SET name = COALESCE($2, name)
         WHERE id = $1
         RETURNING id, space_id, channel_id, creator_id, name, token, created_at",
    )
    .bind(id)
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_webhook(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM webhooks WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
