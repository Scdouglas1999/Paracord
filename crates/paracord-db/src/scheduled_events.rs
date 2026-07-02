use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
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
    pub recurrence_rule: Option<String>,
    pub reminder_minutes: Option<i32>,
    pub event_channel_id: Option<i64>,
    pub event_channel_created: bool,
    pub reminder_sent_at: Option<DateTime<Utc>>,
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
        let reminder_sent_at_raw: Option<String> = row.try_get("reminder_sent_at")?;
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
            recurrence_rule: row.try_get("recurrence_rule")?,
            reminder_minutes: row.try_get("reminder_minutes")?,
            event_channel_id: row.try_get("event_channel_id")?,
            event_channel_created: bool_from_any_row(row, "event_channel_created")?,
            reminder_sent_at: reminder_sent_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
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
    recurrence_rule: Option<&str>,
    reminder_minutes: Option<i32>,
    event_channel_id: Option<i64>,
) -> Result<ScheduledEventRow, DbError> {
    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "INSERT INTO scheduled_events (
             id, guild_id, creator_id, name, description, scheduled_start, scheduled_end,
             entity_type, channel_id, location, image_url, recurrence_rule, reminder_minutes,
             event_channel_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, guild_id, channel_id, creator_id, name, description, scheduled_start,
                   scheduled_end, status, entity_type, location, image_url, recurrence_rule,
                   reminder_minutes, event_channel_id, CASE WHEN event_channel_created THEN 1 ELSE 0 END AS event_channel_created, reminder_sent_at,
                   created_at"
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
    .bind(recurrence_rule)
    .bind(reminder_minutes)
    .bind(event_channel_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_event(pool: &DbPool, id: i64) -> Result<Option<ScheduledEventRow>, DbError> {
    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "SELECT id, guild_id, channel_id, creator_id, name, description, scheduled_start,
                scheduled_end, status, entity_type, location, image_url, recurrence_rule,
                reminder_minutes, event_channel_id, CASE WHEN event_channel_created THEN 1 ELSE 0 END AS event_channel_created, reminder_sent_at,
                created_at
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
        "SELECT id, guild_id, channel_id, creator_id, name, description, scheduled_start,
                scheduled_end, status, entity_type, location, image_url, recurrence_rule,
                reminder_minutes, event_channel_id, CASE WHEN event_channel_created THEN 1 ELSE 0 END AS event_channel_created, reminder_sent_at,
                created_at
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
    description: Option<Option<&str>>,
    scheduled_start: Option<&str>,
    scheduled_end: Option<Option<&str>>,
    status: Option<i32>,
    entity_type: Option<i32>,
    channel_id: Option<Option<i64>>,
    location: Option<Option<&str>>,
    image_url: Option<Option<&str>>,
    recurrence_rule: Option<Option<&str>>,
    reminder_minutes: Option<Option<i32>>,
    event_channel_id: Option<Option<i64>>,
) -> Result<ScheduledEventRow, DbError> {
    let description_set = i32::from(description.is_some());
    let scheduled_end_set = i32::from(scheduled_end.is_some());
    let channel_id_set = i32::from(channel_id.is_some());
    let location_set = i32::from(location.is_some());
    let image_url_set = i32::from(image_url.is_some());
    let recurrence_rule_set = i32::from(recurrence_rule.is_some());
    let reminder_minutes_set = i32::from(reminder_minutes.is_some());
    let event_channel_id_set = i32::from(event_channel_id.is_some());

    let row = sqlx::query_as::<_, ScheduledEventRow>(
        "UPDATE scheduled_events
         SET name = COALESCE($2, name),
             description = CASE WHEN $3 != 0 THEN $4 ELSE description END,
             scheduled_start = COALESCE($5, scheduled_start),
             scheduled_end = CASE WHEN $6 != 0 THEN $7 ELSE scheduled_end END,
             status = COALESCE($8, status),
             entity_type = COALESCE($9, entity_type),
             channel_id = CASE WHEN $10 != 0 THEN $11 ELSE channel_id END,
             location = CASE WHEN $12 != 0 THEN $13 ELSE location END,
             image_url = CASE WHEN $14 != 0 THEN $15 ELSE image_url END,
             recurrence_rule = CASE WHEN $16 != 0 THEN $17 ELSE recurrence_rule END,
             reminder_minutes = CASE WHEN $18 != 0 THEN $19 ELSE reminder_minutes END,
             event_channel_id = CASE WHEN $20 != 0 THEN $21 ELSE event_channel_id END
         WHERE id = $1
         RETURNING id, guild_id, channel_id, creator_id, name, description, scheduled_start,
                   scheduled_end, status, entity_type, location, image_url, recurrence_rule,
                   reminder_minutes, event_channel_id, CASE WHEN event_channel_created THEN 1 ELSE 0 END AS event_channel_created, reminder_sent_at,
                   created_at"
    )
    .bind(id)
    .bind(name)
    .bind(description_set)
    .bind(description.flatten())
    .bind(scheduled_start)
    .bind(scheduled_end_set)
    .bind(scheduled_end.flatten())
    .bind(status)
    .bind(entity_type)
    .bind(channel_id_set)
    .bind(channel_id.flatten())
    .bind(location_set)
    .bind(location.flatten())
    .bind(image_url_set)
    .bind(image_url.flatten())
    .bind(recurrence_rule_set)
    .bind(recurrence_rule.flatten())
    .bind(reminder_minutes_set)
    .bind(reminder_minutes.flatten())
    .bind(event_channel_id_set)
    .bind(event_channel_id.flatten())
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_events_by_status(
    pool: &DbPool,
    statuses: &[i32],
    limit: i64,
) -> Result<Vec<ScheduledEventRow>, DbError> {
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..statuses.len())
        .map(|idx| format!("${}", idx + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let limit_placeholder = format!("${}", statuses.len() + 1);
    let sql = format!(
        "SELECT id, guild_id, channel_id, creator_id, name, description, scheduled_start,
                scheduled_end, status, entity_type, location, image_url, recurrence_rule,
                reminder_minutes, event_channel_id, CASE WHEN event_channel_created THEN 1 ELSE 0 END AS event_channel_created, reminder_sent_at,
                created_at
         FROM scheduled_events
         WHERE status IN ({placeholders})
         ORDER BY scheduled_start ASC
         LIMIT {limit_placeholder}"
    );
    let mut query = sqlx::query_as::<_, ScheduledEventRow>(&sql);
    for status in statuses {
        query = query.bind(*status);
    }
    let rows = query.bind(limit).fetch_all(pool).await?;
    Ok(rows)
}

pub async fn mark_reminder_sent(
    pool: &DbPool,
    event_id: i64,
    sent_at: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE scheduled_events SET reminder_sent_at = $2 WHERE id = $1")
        .bind(event_id)
        .bind(datetime_to_db_text(sent_at))
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_event_channel(
    pool: &DbPool,
    event_id: i64,
    event_channel_id: i64,
    created: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE scheduled_events
         SET event_channel_id = $2, event_channel_created = $3
         WHERE id = $1",
    )
    .bind(event_id)
    .bind(event_channel_id)
    .bind(created)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_event_channel(pool: &DbPool, event_id: i64) -> Result<(), DbError> {
    sqlx::query("UPDATE scheduled_events SET event_channel_id = NULL WHERE id = $1")
        .bind(event_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_event_status(pool: &DbPool, event_id: i64, status: i32) -> Result<(), DbError> {
    sqlx::query("UPDATE scheduled_events SET status = $2 WHERE id = $1")
        .bind(event_id)
        .bind(status)
        .execute(pool)
        .await?;
    Ok(())
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
