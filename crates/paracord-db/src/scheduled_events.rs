use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ScheduledEventRow {
    pub id: i64,
    pub guild_id: i64,
    pub channel_id: Option<i64>,
    pub creator_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub status: i32,
    pub entity_type: i32,
    pub location: Option<String>,
    pub image_url: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct EventRsvpRow {
    pub event_id: i64,
    pub user_id: i64,
    pub status: i32,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ScheduledEventRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            channel_id: row.try_get("channel_id")?,
            creator_id: row.try_get("creator_id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            scheduled_start: row.try_get("scheduled_start")?,
            scheduled_end: row.try_get("scheduled_end")?,
            status: row.try_get("status")?,
            entity_type: row.try_get("entity_type")?,
            location: row.try_get("location")?,
            image_url: row.try_get("image_url")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for EventRsvpRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            event_id: row.try_get("event_id")?,
            user_id: row.try_get("user_id")?,
            status: row.try_get("status")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_event(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    creator_id: i64,
    name: &str,
    description: Option<&str>,
    scheduled_start: &str,
    scheduled_end: Option<&str>,
    entity_type: i32,
    channel_id: Option<i64>,
    location: Option<&str>,
    image_url: Option<&str>,
) -> Result<ScheduledEventRow, DbError> {
    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "INSERT INTO scheduled_events (id, guild_id, creator_id, name, description, scheduled_start, scheduled_end, entity_type, channel_id, location, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end, status, entity_type, location, image_url, created_at"
    )
    .bind(id)
    .bind(guild_id)
    .bind(creator_id)
    .bind(name)
    .bind(description)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(entity_type)
    .bind(channel_id)
    .bind(location)
    .bind(image_url)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_event(pool: &DbPool, id: i64) -> Result<Option<ScheduledEventRow>, DbError> {
    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "SELECT id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end, status, entity_type, location, image_url, created_at
         FROM scheduled_events WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_guild_events(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<ScheduledEventRow>, DbError> {
    let rows = sqlx::query_as::<_, ScheduledEventRow>(
        "SELECT id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end, status, entity_type, location, image_url, created_at
         FROM scheduled_events WHERE guild_id = $1
         ORDER BY scheduled_start ASC"
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_event(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    scheduled_start: Option<&str>,
    scheduled_end: Option<&str>,
    status: Option<i32>,
    channel_id: Option<i64>,
    location: Option<&str>,
    image_url: Option<&str>,
) -> Result<ScheduledEventRow, DbError> {
    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "UPDATE scheduled_events
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             scheduled_start = COALESCE($4, scheduled_start),
             scheduled_end = COALESCE($5, scheduled_end),
             status = COALESCE($6, status),
             channel_id = COALESCE($7, channel_id),
             location = COALESCE($8, location),
             image_url = COALESCE($9, image_url)
         WHERE id = $1
         RETURNING id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end, status, entity_type, location, image_url, created_at"
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(scheduled_start)
    .bind(scheduled_end)
    .bind(status)
    .bind(channel_id)
    .bind(location)
    .bind(image_url)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_event(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM scheduled_events WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn add_rsvp(pool: &DbPool, event_id: i64, user_id: i64) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO event_rsvps (event_id, user_id, status)
         VALUES ($1, $2, 1)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status",
    )
    .bind(event_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_rsvp(pool: &DbPool, event_id: i64, user_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2")
        .bind(event_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_event_rsvps(pool: &DbPool, event_id: i64) -> Result<Vec<EventRsvpRow>, DbError> {
    let rows = sqlx::query_as::<_, EventRsvpRow>(
        "SELECT event_id, user_id, status, created_at
         FROM event_rsvps WHERE event_id = $1
         ORDER BY created_at ASC",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_rsvp_count(pool: &DbPool, event_id: i64) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1")
        .bind(event_id)
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn has_rsvp(pool: &DbPool, event_id: i64, user_id: i64) -> Result<bool, DbError> {
    let row: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1 AND user_id = $2")
            .bind(event_id)
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    Ok(row.0 > 0)
}
