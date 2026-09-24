//! Feeds add-on: per-server switch, shared sources, subscriptions, seen items
//! and the messages feeds posted.
//!
//! Booleans are bound as Rust `bool` and read back through `CAST(col AS
//! INTEGER)` plus [`bool_from_any_row`]. Timestamps are TEXT on both engines,
//! written with [`datetime_to_db_text`], which sorts in time order.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};

// ── Per-server switch ──────────────────────────────────────────────────────

pub async fn is_enabled(pool: &DbPool, guild_id: i64) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT CAST(enabled AS INTEGER) AS enabled FROM guild_feed_settings WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(bool_from_any_row(&row, "enabled")?),
        None => Ok(false),
    }
}

pub async fn set_enabled(pool: &DbPool, guild_id: i64, enabled: bool) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO guild_feed_settings (guild_id, enabled, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, updated_at = $3",
    )
    .bind(guild_id)
    .bind(enabled)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

// ── Sources ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FeedSourceRow {
    pub id: i64,
    pub kind: String,
    pub source_key: String,
    pub url: String,
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub error_count: i64,
    pub next_check_at: Option<DateTime<Utc>>,
}

fn optional_time(
    row: &sqlx::any::AnyRow,
    column: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    let raw: Option<String> = row.try_get(column)?;
    raw.as_deref()
        .filter(|value| !value.is_empty())
        .map(datetime_from_db_text)
        .transpose()
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for FeedSourceRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            source_key: row.try_get("source_key")?,
            url: row.try_get("url")?,
            title: row.try_get("title")?,
            site_url: row.try_get("site_url")?,
            icon_url: row.try_get("icon_url")?,
            etag: row.try_get("etag")?,
            last_modified: row.try_get("last_modified")?,
            last_checked_at: optional_time(row, "last_checked_at")?,
            last_success_at: optional_time(row, "last_success_at")?,
            last_error: row.try_get("last_error")?,
            error_count: row.try_get("error_count")?,
            next_check_at: optional_time(row, "next_check_at")?,
        })
    }
}

const SOURCE_COLUMNS: &str = "id, kind, source_key, url, title, site_url, icon_url, etag, \
     last_modified, last_checked_at, last_success_at, last_error, error_count, next_check_at";

/// What a new subscription knows about its source.
pub struct NewSource<'a> {
    pub kind: &'a str,
    pub source_key: &'a str,
    pub url: &'a str,
    pub title: Option<&'a str>,
    pub site_url: Option<&'a str>,
    pub icon_url: Option<&'a str>,
    /// The first check after the one that created it.
    pub next_check_at: DateTime<Utc>,
}

/// Insert a source, or refresh the descriptive fields of the one already
/// stored under the same key. Returns its id.
pub async fn upsert_source(pool: &DbPool, id: i64, source: &NewSource<'_>) -> Result<i64, DbError> {
    let now = datetime_to_db_text(Utc::now());
    let row = sqlx::query(
        "INSERT INTO feed_sources (id, kind, source_key, url, title, site_url, icon_url,
                                   last_checked_at, last_success_at, next_check_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $8)
         ON CONFLICT (source_key) DO UPDATE SET
            url = $4,
            title = COALESCE($5, feed_sources.title),
            site_url = COALESCE($6, feed_sources.site_url),
            icon_url = COALESCE($7, feed_sources.icon_url)
         RETURNING id",
    )
    .bind(id)
    .bind(source.kind)
    .bind(source.source_key)
    .bind(source.url)
    .bind(source.title)
    .bind(source.site_url)
    .bind(source.icon_url)
    .bind(&now)
    .bind(datetime_to_db_text(source.next_check_at))
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("id")?)
}

pub async fn get_source(pool: &DbPool, id: i64) -> Result<Option<FeedSourceRow>, DbError> {
    Ok(sqlx::query_as::<_, FeedSourceRow>(&format!(
        "SELECT {SOURCE_COLUMNS} FROM feed_sources WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

/// Sources whose next check is due and that at least one running
/// subscription on a server with the add-on on still wants.
pub async fn list_due_sources(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<FeedSourceRow>, DbError> {
    Ok(sqlx::query_as::<_, FeedSourceRow>(&format!(
        "SELECT {SOURCE_COLUMNS} FROM feed_sources s
         WHERE (s.next_check_at IS NULL OR s.next_check_at <= $1)
           AND EXISTS (
               SELECT 1 FROM guild_feeds f
               JOIN guild_feed_settings g ON g.guild_id = f.guild_id
               WHERE f.source_id = s.id
                 AND (CASE WHEN f.paused THEN 1 ELSE 0 END) = 0
                 AND (CASE WHEN g.enabled THEN 1 ELSE 0 END) = 1)
         ORDER BY s.next_check_at LIMIT $2"
    ))
    .bind(datetime_to_db_text(now))
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?)
}

/// A check that reached the source (a fresh body or "not modified").
pub struct SourceSuccess<'a> {
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    pub title: Option<&'a str>,
    pub checked_at: DateTime<Utc>,
    pub next_check_at: DateTime<Utc>,
}

pub async fn record_source_success(
    pool: &DbPool,
    id: i64,
    success: &SourceSuccess<'_>,
) -> Result<(), DbError> {
    let checked = datetime_to_db_text(success.checked_at);
    sqlx::query(
        "UPDATE feed_sources SET
            etag = COALESCE($2, etag),
            last_modified = COALESCE($3, last_modified),
            title = COALESCE($4, title),
            last_checked_at = $5,
            last_success_at = $5,
            last_error = NULL,
            error_count = 0,
            next_check_at = $6
         WHERE id = $1",
    )
    .bind(id)
    .bind(success.etag)
    .bind(success.last_modified)
    .bind(success.title)
    .bind(&checked)
    .bind(datetime_to_db_text(success.next_check_at))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_source_error(
    pool: &DbPool,
    id: i64,
    error: &str,
    error_count: i64,
    checked_at: DateTime<Utc>,
    next_check_at: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE feed_sources SET last_error = $2, error_count = $3, last_checked_at = $4,
                next_check_at = $5
         WHERE id = $1",
    )
    .bind(id)
    .bind(error)
    .bind(error_count)
    .bind(datetime_to_db_text(checked_at))
    .bind(datetime_to_db_text(next_check_at))
    .execute(pool)
    .await?;
    Ok(())
}

/// Move a source's next check, e.g. to check a source again right away.
pub async fn set_next_check(
    pool: &DbPool,
    id: i64,
    next_check_at: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE feed_sources SET next_check_at = $2 WHERE id = $1")
        .bind(id)
        .bind(datetime_to_db_text(next_check_at))
        .execute(pool)
        .await?;
    Ok(())
}

/// Remove a source nobody subscribes to any more.
pub async fn delete_source_if_orphaned(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM feed_sources WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM guild_feeds WHERE source_id = $1)",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Subscriptions ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GuildFeedRow {
    pub id: i64,
    pub guild_id: i64,
    pub channel_id: i64,
    pub source_id: i64,
    pub creator_id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub options: String,
    pub secret: Option<String>,
    pub show_on_front_page: bool,
    pub paused: bool,
    pub last_error: Option<String>,
    pub last_posted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildFeedRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created: String = row.try_get("created_at")?;
        let updated: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            channel_id: row.try_get("channel_id")?,
            source_id: row.try_get("source_id")?,
            creator_id: row.try_get("creator_id")?,
            kind: row.try_get("kind")?,
            name: row.try_get("name")?,
            options: row.try_get("options")?,
            secret: row.try_get("secret")?,
            show_on_front_page: bool_from_any_row(row, "show_on_front_page")?,
            paused: bool_from_any_row(row, "paused")?,
            last_error: row.try_get("last_error")?,
            last_posted_at: optional_time(row, "last_posted_at")?,
            created_at: datetime_from_db_text(&created)?,
            updated_at: datetime_from_db_text(&updated)?,
        })
    }
}

const FEED_COLUMNS: &str = "id, guild_id, channel_id, source_id, creator_id, kind, name, options, \
     secret, CAST(show_on_front_page AS INTEGER) AS show_on_front_page, \
     CAST(paused AS INTEGER) AS paused, last_error, last_posted_at, created_at, updated_at";

pub struct NewGuildFeed<'a> {
    pub id: i64,
    pub guild_id: i64,
    pub channel_id: i64,
    pub source_id: i64,
    pub creator_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub options: &'a str,
    pub secret: Option<&'a str>,
    pub show_on_front_page: bool,
}

pub async fn create_feed(pool: &DbPool, feed: &NewGuildFeed<'_>) -> Result<GuildFeedRow, DbError> {
    let now = datetime_to_db_text(Utc::now());
    Ok(sqlx::query_as::<_, GuildFeedRow>(&format!(
        "INSERT INTO guild_feeds (id, guild_id, channel_id, source_id, creator_id, kind, name,
                                  options, secret, show_on_front_page, paused, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING {FEED_COLUMNS}"
    ))
    .bind(feed.id)
    .bind(feed.guild_id)
    .bind(feed.channel_id)
    .bind(feed.source_id)
    .bind(feed.creator_id)
    .bind(feed.kind)
    .bind(feed.name)
    .bind(feed.options)
    .bind(feed.secret)
    .bind(feed.show_on_front_page)
    .bind(false)
    .bind(&now)
    .fetch_one(pool)
    .await?)
}

pub async fn get_feed(pool: &DbPool, id: i64) -> Result<Option<GuildFeedRow>, DbError> {
    Ok(sqlx::query_as::<_, GuildFeedRow>(&format!(
        "SELECT {FEED_COLUMNS} FROM guild_feeds WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list_guild_feeds(pool: &DbPool, guild_id: i64) -> Result<Vec<GuildFeedRow>, DbError> {
    Ok(sqlx::query_as::<_, GuildFeedRow>(&format!(
        "SELECT {FEED_COLUMNS} FROM guild_feeds WHERE guild_id = $1 ORDER BY id"
    ))
    .bind(guild_id)
    .fetch_all(pool)
    .await?)
}

pub async fn count_guild_feeds(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM guild_feeds WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("n")?)
}

/// Running subscriptions of one source on servers with the add-on on.
pub async fn list_active_feeds_for_source(
    pool: &DbPool,
    source_id: i64,
) -> Result<Vec<GuildFeedRow>, DbError> {
    Ok(sqlx::query_as::<_, GuildFeedRow>(&format!(
        "SELECT {FEED_COLUMNS} FROM guild_feeds f
         WHERE f.source_id = $1
           AND (CASE WHEN f.paused THEN 1 ELSE 0 END) = 0
           AND EXISTS (SELECT 1 FROM guild_feed_settings g
                       WHERE g.guild_id = f.guild_id
                         AND (CASE WHEN g.enabled THEN 1 ELSE 0 END) = 1)
         ORDER BY f.id"
    ))
    .bind(source_id)
    .fetch_all(pool)
    .await?)
}

pub struct FeedUpdate<'a> {
    pub source_id: i64,
    pub name: &'a str,
    pub channel_id: i64,
    pub show_on_front_page: bool,
    pub paused: bool,
    pub secret: Option<&'a str>,
}

pub async fn update_feed(
    pool: &DbPool,
    id: i64,
    update: &FeedUpdate<'_>,
) -> Result<GuildFeedRow, DbError> {
    sqlx::query_as::<_, GuildFeedRow>(&format!(
        "UPDATE guild_feeds SET source_id = $2, name = $3, channel_id = $4,
                show_on_front_page = $5, paused = $6, secret = $7, updated_at = $8
         WHERE id = $1
         RETURNING {FEED_COLUMNS}"
    ))
    .bind(id)
    .bind(update.source_id)
    .bind(update.name)
    .bind(update.channel_id)
    .bind(update.show_on_front_page)
    .bind(update.paused)
    .bind(update.secret)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)
}

/// Record how the last post into the channel went.
pub async fn record_delivery(
    pool: &DbPool,
    id: i64,
    error: Option<&str>,
    posted_at: Option<DateTime<Utc>>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE guild_feeds SET last_error = $2,
                last_posted_at = COALESCE($3, last_posted_at)
         WHERE id = $1",
    )
    .bind(id)
    .bind(error)
    .bind(posted_at.map(datetime_to_db_text))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_feed(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM guild_feed_items WHERE feed_id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM guild_feeds WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Seen items ─────────────────────────────────────────────────────────────

/// How many seen items a subscription keeps. A source lists far fewer at a
/// time; the oldest are dropped first.
pub const MAX_SEEN_ITEMS: i64 = 1000;

pub async fn seen_keys(pool: &DbPool, feed_id: i64) -> Result<HashSet<String>, DbError> {
    let rows = sqlx::query("SELECT item_key FROM guild_feed_items WHERE feed_id = $1")
        .bind(feed_id)
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|row| row.try_get::<String, _>("item_key").map_err(DbError::from))
        .collect()
}

pub struct SeenItem<'a> {
    pub key: &'a str,
    pub title: &'a str,
    pub published_at: Option<DateTime<Utc>>,
    /// The item as JSON, enough to post it later.
    pub item: &'a str,
}

/// Record items as seen. Items already recorded keep their row.
pub async fn record_seen(
    pool: &DbPool,
    feed_id: i64,
    items: &[SeenItem<'_>],
    seen_at: DateTime<Utc>,
) -> Result<(), DbError> {
    if items.is_empty() {
        return Ok(());
    }
    let seen = datetime_to_db_text(seen_at);
    let mut tx = pool.begin().await?;
    for item in items {
        sqlx::query(
            "INSERT INTO guild_feed_items (feed_id, item_key, title, published_at, item, posted, seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (feed_id, item_key) DO NOTHING",
        )
        .bind(feed_id)
        .bind(item.key)
        .bind(item.title)
        .bind(item.published_at.map(datetime_to_db_text))
        .bind(item.item)
        .bind(false)
        .bind(&seen)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    prune_seen(pool, feed_id).await
}

async fn prune_seen(pool: &DbPool, feed_id: i64) -> Result<(), DbError> {
    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM guild_feed_items WHERE feed_id = $1")
        .bind(feed_id)
        .fetch_one(pool)
        .await?
        .try_get("n")?;
    if count <= MAX_SEEN_ITEMS {
        return Ok(());
    }
    sqlx::query(
        "DELETE FROM guild_feed_items WHERE feed_id = $1 AND item_key IN (
            SELECT item_key FROM guild_feed_items WHERE feed_id = $1
            ORDER BY seen_at, published_at LIMIT $2)",
    )
    .bind(feed_id)
    .bind(count - MAX_SEEN_ITEMS)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_posted(pool: &DbPool, feed_id: i64, keys: &[String]) -> Result<(), DbError> {
    for key in keys {
        sqlx::query("UPDATE guild_feed_items SET posted = $1 WHERE feed_id = $2 AND item_key = $3")
            .bind(true)
            .bind(feed_id)
            .bind(key)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// The newest item a subscription has seen, as stored JSON.
pub async fn newest_item(pool: &DbPool, feed_id: i64) -> Result<Option<String>, DbError> {
    let row = sqlx::query(
        "SELECT item FROM guild_feed_items WHERE feed_id = $1
         ORDER BY CASE WHEN published_at IS NULL THEN 1 ELSE 0 END, published_at DESC, seen_at DESC
         LIMIT 1",
    )
    .bind(feed_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .map(|row| row.try_get::<String, _>("item"))
        .transpose()?)
}

// ── Messages a feed posted ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FeedMessageRow {
    pub message_id: i64,
    pub feed_id: i64,
    pub guild_id: i64,
    pub kind: String,
    pub name: String,
    pub icon_url: Option<String>,
}

pub struct NewFeedMessage<'a> {
    pub message_id: i64,
    pub feed_id: i64,
    pub guild_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub icon_url: Option<&'a str>,
    /// The "and N more" line rather than an item.
    pub overflow: bool,
}

pub async fn link_feed_message(pool: &DbPool, message: &NewFeedMessage<'_>) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO feed_messages (message_id, feed_id, guild_id, kind, name, icon_url, overflow,
                                    created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(message.message_id)
    .bind(message.feed_id)
    .bind(message.guild_id)
    .bind(message.kind)
    .bind(message.name)
    .bind(message.icon_url)
    .bind(message.overflow)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// Feed identities for a page of messages. Messages no feed posted are absent.
pub async fn get_feed_messages_for_ids(
    pool: &DbPool,
    message_ids: &[i64],
) -> Result<Vec<FeedMessageRow>, DbError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=message_ids.len())
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT message_id, feed_id, guild_id, kind, name, icon_url FROM feed_messages
         WHERE message_id IN ({placeholders})"
    );
    let mut query = sqlx::query(&sql);
    for id in message_ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            Ok(FeedMessageRow {
                message_id: row.try_get("message_id")?,
                feed_id: row.try_get("feed_id")?,
                guild_id: row.try_get("guild_id")?,
                kind: row.try_get("kind")?,
                name: row.try_get("name")?,
                icon_url: row.try_get("icon_url")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Of these messages, the item cards a feed posted with "Show on the front page" on.
pub async fn front_page_feed_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
) -> Result<HashSet<i64>, DbError> {
    if message_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let placeholders = (1..=message_ids.len())
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT fm.message_id FROM feed_messages fm
         JOIN guild_feeds f ON f.id = fm.feed_id
         WHERE fm.message_id IN ({placeholders})
           AND (CASE WHEN fm.overflow THEN 1 ELSE 0 END) = 0
           AND (CASE WHEN f.show_on_front_page THEN 1 ELSE 0 END) = 1"
    );
    let mut query = sqlx::query(&sql);
    for id in message_ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(pool).await?;
    rows.iter()
        .map(|row| row.try_get::<i64, _>("message_id").map_err(DbError::from))
        .collect()
}
